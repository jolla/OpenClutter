# Fly worker for heavy exports

This is the setup Jerry runs after he has a Fly.io account. Nothing in the repo signs up, deploys, or stores a real secret.

The worker runs the same export as the Netlify background function: imagery, footprints, terrain, canopy, vehicles, OpenIntent JSON, and the zip. It writes that zip and the job status into the existing Netlify Blobs store (`openclutter-exports`). The page keeps polling `/api/export-status` and downloading `/api/export-file`. There is no new button.

The app name in `fly.toml` is the placeholder `openclutter-export`. The public URL is `https://openclutter-export.fly.dev`. If that name is taken, change the `app` line to another name and use that name in every command below.

## When the worker is used

The Netlify background function calls the worker only when both of these are set on that Netlify deploy:

- `FLY_WORKER_URL`, for example `https://openclutter-export.fly.dev`
- `FLY_WORKER_SECRET`, a long random string

If either one is missing, the export stays on the current Netlify background path. If the worker does not accept the job, that same path runs it, and the job warning is: "Fly worker did not accept this export. It is running on the Netlify background path."

Fly does not allow a secret name that starts with `FLY_`. On the Fly app the same secret value is `OPENCLUTTER_WORKER_SECRET`.

## Cost

Prices below are Fly.io public list rates for Ashburn (`iad`) from [Fly.io resource pricing](https://fly.io/docs/about/pricing/), checked October 2026. No tax, no committed-use discount.

| Machine | If left on for 30 days |
| --- | --- |
| shared-cpu-1x, 256 MB | $2.19 |
| shared-cpu-1x with RAM raised to 2 GB | $12.69 |
| performance-1x, 2 GB | $33.00 |

The 2 GB shared price is the 256 MB machine at $2.19 plus 1.75 GB of extra RAM at $6 per GB. Per hour that is $12.69 / 720 = about $0.0176. This app uses that shape: `shared-cpu-1x` and `memory = "2gb"`. A 2 GB machine is the size the Wynn export needs. `performance-1x` is not required.

`auto_stop_machines = "stop"` and `min_machines_running = 0`. An idle app does not keep a machine running.

- Idle compute is $0. A stopped machine still pays for its root disk at $0.15 per GB per month. There is no volume. A shared IPv4 address is free. Expect well under $1 in a quiet month, mostly that stopped disk.
- One warm Wynn export is about 115 seconds. 115 / 3600 * $0.0176 is about $0.00056.
- A few dozen of those, 40 exports, is about $0.02 of compute.
- Outbound data from the machine (source tiles and the blob upload) is $0.02 per GB in North America. Inbound data is free. That is cents even for a busy month, not a second machine bill.
- A machine left on all month would be about $12.69. Auto-stop is what avoids that.

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

`fly launch` creates the app and does not deploy it. `--ha=false` keeps it to one machine. If launch rewrites `fly.toml`, restore this repo's file before the deploy so the 2 GB shared machine and auto-stop stay as written.

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

fly deploy
fly scale count 1
```

`fly scale count 1` is the whole pool. Fly will not create a second machine. The one machine stops after it has been idle for several minutes and starts again on the next export. There is no periodic health check, so a quiet app can stop. `GET /health` is only for a manual check.

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
