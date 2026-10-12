# Fly worker for heavy exports

This is the setup Jerry runs after he has a Fly.io account. Nothing in the repo signs up, deploys, or stores a real secret.

The worker runs the same export as the Netlify background function: imagery, footprints, terrain, canopy, vehicles, OpenIntent JSON, and the zip. It writes that zip and the job status into the existing Netlify Blobs store (`openclutter-exports`). The page keeps polling `/api/export-status` and downloading `/api/export-file`. There is no new button.

The app name in `fly.toml` is the placeholder `openclutter-export`. The public URL is `https://openclutter-export.fly.dev`. If that name is taken, change the `app` line to another name and use that name in every command below.

## When the worker is used

The Netlify background function calls the worker only when both of these are set on that Netlify deploy:

- `FLY_WORKER_URL`, for example `https://openclutter-export.fly.dev`
- `FLY_WORKER_SECRET`, a long random string

If either one is missing, the export stays on the current Netlify background path. If the worker does not accept the job, that same path runs it, and the job warning is: "Fly worker did not accept this export. It is running on the Netlify background path."

The handoff is attempted even when the job has no heartbeat yet. While the export runs, the worker writes a heartbeat on that same job about every 10 seconds. The heartbeat is the current stage name and a timestamp.

If no heartbeat arrives for 45 seconds, Netlify runs the job on its own background path. The job warning is: "The export worker stopped. The job was run here instead."

If the page or the function has under 2 minutes left, Netlify does not start that second run. The job fails with: "The export worker stopped during Trees. Export again." The stage name is the last one on the heartbeat, or the last stage on the job.

A worker that has not been deployed with this heartbeat yet never writes one. Netlify still attempts the handoff, then runs the job itself after 45 seconds. After `fly deploy`, heartbeats keep the job on the worker.

The worker logs each stage for `fly logs`, when it starts and when it finishes:

```text
export 3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21 stage done Buildings duration 8.4s
export 3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21 stage start Trees elapsed 41.2s
```

`elapsed` is from the start of that export. `duration` is that stage only.

The process also logs the CPU count it can see, and one line per canopy or foliage tile:

```text
worker start os.cpus 4 availableParallelism 4 pool 4
export 3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21 stage tile canopy-3 thread 1 start 41.2s duration 12.4s
```

`os.cpus` is what Node reports in the guest. `pool` is the worker count actually used. Two tile lines overlap when one tile's start falls inside the other's start plus duration. A tile whose duration is most of the Trees stage is the band to split.

Fly does not allow a secret name that starts with `FLY_`. On the Fly app the same secret value is `OPENCLUTTER_WORKER_SECRET`.

## Cost

Prices below are Fly.io public list rates for Ashburn (`iad`) from [Fly.io resource pricing](https://fly.io/docs/about/pricing/), checked October 2026. No tax, no committed-use discount. The public table lists `performance-1x` with 2 GB at $33.00 per month and `performance-2x` with 4 GB at $66.00 per month. It does not list `performance-4x` on its own row. That pair is $33 per performance CPU with 2 GB included, so four CPUs with 8 GB included is $132 per month if the machine is left running. Extra RAM beyond the preset is $6 per GB per month and is not added here.

| Machine | If left on for 30 days | Per hour (720 hours) |
| --- | --- | --- |
| performance-1x, 2 GB | $33.00 | about $0.0458 |
| performance-4x, 8 GB | $132.00 | about $0.183 |

This app uses `performance-4x` and `memory = "8192mb"`. Four full cores are what the Trees pass needs. A shared CPU is not used. Fly's shared vCPU is allowed 5 ms of every 80 ms (6.25 percent) after its burst balance is gone, and a Trees pass is much longer than that burst.

`auto_stop_machines = "off"` and `min_machines_running = 0`. Fly Proxy does not stop the machine. A stopped machine stays stopped. The worker process exits on its own after 5 minutes with no export running. That exit code is 0. The restart policy is `on-failure`, so a clean exit is not started again. `auto_start_machines = true` starts the machine on the next export.

Fly autostop is off because it stops a machine when it sees no open HTTP connection. That is the "excess capacity" stop that killed a live export at 17:29:30Z on 2026-10-12 while the job was still in memory. Suspend is not used. Suspend freezes the process, and a long export cannot rely on that.

The export POST stays open until the job finishes. A newline every 20 seconds keeps that one connection up. Concurrency is `type = "requests"`, `soft_limit = 200`, `hard_limit = 250`. One open export is a single request, so the same machine still accepts a health check or another POST. A hard limit of 1 made Fly Proxy refuse that second request with "could not find a good candidate within 40 attempts at load balancing". The app still runs one export at a time and answers 409 when a second export arrives.

- Idle compute is $0 once the process has exited and the machine has stopped. A stopped machine still pays for its root disk at $0.15 per GB per month. There is no volume. A shared IPv4 address is free. Expect well under $1 in a quiet month, mostly that stopped disk.
- One Wynn export that hits the 60 second target is 60 / 3600 * $0.183, about $0.0031.
- A few dozen of those, 40 exports, is about $0.12 of compute.
- Outbound data from the machine (source tiles and the blob upload) is $0.02 per GB in North America. Inbound data is free. That is cents even for a busy month, not a second machine bill.
- A machine left on all month would be about $132. The 5 minute idle exit is what avoids that. Fly autostop stays off so it cannot kill a job that is still in memory.

## Why Trees was slow

Trees, the canopy trace, and the vehicle scans ran as one synchronous JavaScript thread. The code never read `os.cpus()`, so a second core did nothing, and `setInterval` could not fire a heartbeat while that thread was busy. Netlify then treated the silence as a dead worker and started the job again.

The raw tile cache is not the cause. It stores the response bytes it fetched. Canopy COG reads are HTTP Range requests and skip the cache, so the height grid is the same window the Netlify path reads. Aerial keys include metres per pixel, so a cached JPEG is the same export size as a live one. The cache does not add polygons.

On this 4-core machine the real Wynn golf box, with the tile cache off, finished in 75 s with 369 buildings and 881 trees. The tree work, including turning outlines into OpenIntent rings, was 37.5 s on the worker threads. Vehicle scans were 8.5 s. A one-thread trace of a synthetic canopy the same size was 4.1 s (782 groups); the tiled path was 3.5 s cold and 3.0 s warm (790 groups). Netlify's earlier baseline for this box was about 115 s with 369 buildings and 794 trees. This machine is not a Fly performance-4x host, so this is not a 60 s proof on that size. The trace waits on the workers, so the 10 second heartbeat still runs.

A profile of that Trees path spends most of its time in polygon clipping of the traced crowns (`polygon-clipping`), not in a different image size. Splitting the canopy grid into row tiles and clipping each tile on its own worker is what keeps the main thread free for the 10 second heartbeat.

Fly's performance-4x guest is 4 dedicated vCPUs. Node's `os.cpus()` does not read that reservation. Inside a container it can report 1, or the host's CPU count, because it lists online CPUs rather than the cgroup quota ([Node issue 28762](https://github.com/nodejs/node/issues/28762), [Fly CPU performance](https://fly.io/docs/machines/cpu-performance/)). Fly does not set a CPU-count variable of its own. `fly.toml` sets `OPENCLUTTER_CPU_COUNT=4`. When that variable or `FLY_MACHINE_CPUS` is set, the pool uses it and does not use the machine it happens to be running on. When neither is set, the pool uses `os.availableParallelism()`, which reads the cgroup CPU quota, and only then `os.cpus()`. The worker logs `os.cpus().length` at process start and again on each export so `fly logs` shows what the guest reported.

Canopy height is a COG on S3. Each window is an HTTP Range read, and those range reads skip the raw-byte cache, so a warm export used to fetch the height grid again. The reader now prefetches the strip windows together, four at a time, and stores the decoded height raster for the snapped draw. The cache key is the canopy source with the existing 14 day TTL. The bytes are the height samples (`CHM1` plus the grid), not crowns or OpenIntent polygons. The main thread is waiting on those reads, so the 10 second heartbeat still runs.

The Trees grid is a pull queue of 16 to 32 row tiles, 24 on a 4-core pool. A thread takes the next tile when it finishes, so a short tile does not sit behind a long one. Each tile owns a band of rows and also reads 48 m past that band (about 22 rows on the Wynn grid, where a cell is about 2.2 m). A crown that crosses the band is traced whole by the tile that owns its top row. A crown taller than that overlap is traced from the full grid, so the outline is not cut. The same queue then clips foliage in 16 to 32 groups. Each group includes neighboring crowns within 48 m so a shared edge is clipped, and only the owner emits the piece. Tile lines stay `canopy-N` and keep going as the queue drains. `fly logs` shows one line per tile.

On the v1.1.154 worker the four foliage tiles ran 27.9, 41.8, 50.2, and 72.5 s, so the longest tile held the Trees stage at about 70 s while the stage itself was 92 to 96 s. The other roughly 20 s was work that did not overlap that long tile: the canopy trace ran as its own phase before clipping, the canopy gap fill ran on one thread before the tiles, and the vehicle scan ran after the tiles while the stage was still Trees. Gap fill now starts before the footprint preview and overlaps it. The vehicle scan starts as soon as those footprints are ready and overlaps the tile queue. The main thread still only waits, so the 10 second heartbeat still fires.

On this 4-core machine, which is not ord and not a Fly performance-4x host, the same Wynn box with the tile cache off finished in 68 s with 369 buildings and 837 trees. The 24 trace tiles took 1.2 s on the wall clock. The next 24 tiles, the foliage clip, took 123 s of thread time and 36.7 s on the wall clock. The longest clip tile was 14.7 s, and the queue kept going on the other threads. The vehicle scan ran in that same window (11.7 s of thread time) instead of after the trees. The earlier run on this machine was 75 s with 881 trees, 37.5 s of trees, then 8.5 s of vehicles. This is not a 60 s proof on the ord host.

A done or failed job is terminal. A later heartbeat, stage update, or requeue does not change `state`, `error`, or the zip pointer. A heartbeat refreshes `heartbeatAt` only while the job is still queued or running.

A local read of the Wynn golf canopy (west -115.16942, south 36.11944163, east -115.153863, north 36.13182737), on a machine that is not ord and not performance-4x, took 1.3 s. About 1.3 s of that had an HTTP range in flight: 70 range reads, 405 KB, at most 18 at once. Time with no range in flight was about 0.06 s. The same grid from the raster cache was 3 ms. `os.cpus()` on that machine was 4. What the Fly guest reports for `os.cpus()`, and whether the tile lines overlap, is only in `fly logs` after deploy.

## Before the commands

1. Sign up at https://fly.io
2. Add a credit card. A new account can start on the free trial, which lasts up to 2 hours of machine time or 7 days, whichever comes first. After that, Fly requires a card. There is no monthly free allowance.
3. Install flyctl: https://fly.io/docs/flyctl/install/

Do not commit secrets. Do not put a token in this repo.

## Commands

Install the CLI from https://fly.io/docs/flyctl/install/ if it is not installed yet. Then, from the repo root:

```bash
fly auth login

fly launch --ha=false --no-deploy --copy-config --yes --name openclutter-export --region iad
```

`fly launch` creates the app and does not deploy it. `--ha=false` keeps it to one machine. If launch rewrites `fly.toml`, restore this repo's file before the deploy so the performance-4x 8 GB machine, the concurrency limits, autostop off, and the idle exit stay as written.

Create a secret locally. Do not commit it, and do not paste it into the repo:

```bash
openssl rand -hex 32
```

Set the Fly secrets. Replace the three values. `NETLIFY_SITE_ID` is the Project ID at Project configuration > General > Project information. `NETLIFY_AUTH_TOKEN` is a Netlify personal access token from https://app.netlify.com/user/applications#personal-access-tokens . The token needs access to this site so the worker can read and write Blobs. Do not invent either value.

```bash
fly secrets set \
  OPENCLUTTER_WORKER_SECRET='paste-the-secret' \
  NETLIFY_SITE_ID='paste-the-project-id' \
  NETLIFY_AUTH_TOKEN='paste-the-personal-access-token'

flyctl deploy --local-only
fly scale count 1
```

`fly scale count 1` is the whole pool. Fly will not create a second machine. The process exits after 5 minutes with no export, which stops the machine. The next export starts it. Fly autostop is off, so it does not stop a machine that still has a job in memory. There is no periodic health check. `GET /health` is only for a manual check. `flyctl deploy --local-only` builds on the machine running the deploy, not on Fly's remote builder.

On Netlify, set the URL and the same secret for production and for the `dev` branch. A context that is missing either value keeps the current background export.

```bash
netlify env:set FLY_WORKER_URL "https://openclutter-export.fly.dev" --context production
netlify env:set FLY_WORKER_SECRET "paste-the-secret" --context production
netlify env:set FLY_WORKER_URL "https://openclutter-export.fly.dev" --context branch:dev
netlify env:set FLY_WORKER_SECRET "paste-the-secret" --context branch:dev
```

The same four values can be entered in the Netlify UI under Site configuration > Environment variables. The next deploy of that context picks them up.

Optional, only if blob writes from the worker cannot find the store: on Fly, `fly secrets set NETLIFY_BLOBS_REGION='us-east-2'`. Leave it unset unless a job fails to store. Do not set it on Netlify. The function already has its own blob context.

No map API key is required for the current sources. The Finland laser grid is already in the image. Leave `NLS_API_KEY` unset unless you later have a real key to put there. Do not put a placeholder in the repo or in Fly.

## Update the live worker

The app is already `openclutter-export`. From the repo root, on Jerry's machine, deploy this commit so the live machine gets the 16 to 32 tile queue, the terminal done and failed job write, performance-4x with 8 GB, worker threads for Trees, heartbeats, the concurrency limits (soft 200, hard 250), and the 5 minute idle exit. Do not run this from CI.

```bash
flyctl deploy --local-only
```

`--local-only` builds on Jerry's machine. The machine that is already running does not pick up the tile queue until that deploy.

Until that deploy, Trees still waits on the longest of four bands, and a late heartbeat can leave a finished job queued. After the deploy, threads pull the next small tile, a finished job stays done or failed, a fresh heartbeat keeps a running job on the worker, a busy machine still accepts a status check, and the process exits on its own after 5 minutes with no export.
