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

Fly does not allow a secret name that starts with `FLY_`. On the Fly app the same secret value is `OPENCLUTTER_WORKER_SECRET`.

## Cost

Prices below are Fly.io public list rates for Ashburn (`iad`) from [Fly.io resource pricing](https://fly.io/docs/about/pricing/), checked October 2026. No tax, no committed-use discount.

| Machine | If left on for 30 days |
| --- | --- |
| shared-cpu-1x, 256 MB | $2.19 |
| shared-cpu-1x with RAM raised to 2 GB | $12.69 |
| performance-1x, 2 GB | $33.00 |

The 2 GB shared price is the 256 MB machine at $2.19 plus 1.75 GB of extra RAM at $6 per GB. Per hour that is $12.69 / 720 = about $0.0176. This app uses that shape: `shared-cpu-1x` and `memory = "2gb"`. A 2 GB machine is the size the Wynn export needs. `performance-1x` is not required.

`auto_stop_machines = "off"` and `min_machines_running = 0`. Fly Proxy does not stop the machine. A stopped machine stays stopped. The worker process exits on its own after 5 minutes with no export running. That exit code is 0. The restart policy is `on-failure`, so a clean exit is not started again. `auto_start_machines = true` starts the machine on the next export.

Fly autostop is off because it stops a machine when it sees no open HTTP connection. That is the "excess capacity" stop that killed a live export at 17:29:30Z on 2026-10-12 while the job was still in memory. Suspend is not used. Suspend freezes the process, and a long export cannot rely on that.

The export POST stays open until the job finishes. A newline every 20 seconds keeps that one connection up. Concurrency is `type = "requests"`, `soft_limit = 200`, `hard_limit = 250`. One open export is a single request, so the same machine still accepts a health check or another POST. A hard limit of 1 made Fly Proxy refuse that second request with "could not find a good candidate within 40 attempts at load balancing". The app still runs one export at a time and answers 409 when a second export arrives.

- Idle compute is $0 once the process has exited and the machine has stopped. A stopped machine still pays for its root disk at $0.15 per GB per month. There is no volume. A shared IPv4 address is free. Expect well under $1 in a quiet month, mostly that stopped disk.
- One warm Wynn export is about 115 seconds. 115 / 3600 * $0.0176 is about $0.00056.
- A few dozen of those, 40 exports, is about $0.02 of compute.
- Outbound data from the machine (source tiles and the blob upload) is $0.02 per GB in North America. Inbound data is free. That is cents even for a busy month, not a second machine bill.
- A machine left on all month would be about $12.69. The 5 minute idle exit is what avoids that. Fly autostop stays off so it cannot kill a job that is still in memory.

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

`fly launch` creates the app and does not deploy it. `--ha=false` keeps it to one machine. If launch rewrites `fly.toml`, restore this repo's file before the deploy so the 2 GB shared machine, the concurrency limits, autostop off, and the idle exit stay as written.

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

fly deploy --depot=false
fly scale count 1
```

`fly scale count 1` is the whole pool. Fly will not create a second machine. The process exits after 5 minutes with no export, which stops the machine. The next export starts it. Fly autostop is off, so it does not stop a machine that still has a job in memory. There is no periodic health check. `GET /health` is only for a manual check. `--depot=false` builds on the machine running the deploy, not on Fly's remote builder.

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

The app is already `openclutter-export`. From the repo root, deploy this commit so the live machine gets heartbeats, the concurrency limits (soft 200, hard 250), and the 5 minute idle exit. The machine that is already running does not have those until this deploy.

```bash
fly deploy --depot=false
```

`--depot=false` builds without Fly's remote builder. Run that from the repo root.

Until that deploy, the live worker does not write a heartbeat, still has a concurrency hard limit of 1, and Fly can still stop it for excess capacity while a job is in memory. Netlify then runs the export itself after 45 seconds of silence, or fails the job when under 2 minutes remain. After the deploy, a fresh heartbeat keeps the job on the worker, a busy machine still accepts a status check, and the process exits on its own after 5 minutes with no export.
