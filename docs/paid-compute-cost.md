# Paid compute for a Wynn-sized export

This is a cost note only. Nothing here signs up, deploys, or adds credentials. Prices are public list rates checked in October 2026, before tax and before committed-use discounts. A Wynn golf draw is about 1,915,158 m2. The timings below are wall clock on one local run of current dev, not a cloud bill.

## What one export costs in time

The slow part is the single Node process: the aerial JPEG, the Microsoft tile, canopy and world cover, then building and tree work. A warm blob cache skips repeat downloads of raw tiles. It does not skip detection. Final geometry is not cached.

Measured on this machine for the Wynn box (west -115.16942, south 36.11944163, east -115.153863, north 36.13182737), area 1,915,158 m2:

| Run | Wall clock |
| --- | --- |
| Baseline, v1.1.148, cache off | 115 s |
| Cold cache | 120 s |
| Warm cache, same draw | 115 s |
| Overlapping draw to the east | 180 s |

The warm run is not a shorter wall clock than that baseline, because building and tree work still dominates. The cached stages are shorter: aerial fetch 25.0 s cold to 2.7 s warm, DEM 8.2 s to 2.7 s, Microsoft footprints 6.1 s to 3.1 s. The overlap reuses the Las Vegas Microsoft quadkey.

Use those wall clocks as the billable seconds. Round up to the next second. Assume the machine is busy for that whole wall clock (request-based billing) and then scales to zero.

## Cloud Run (us-central1, request-based)

| Meter | List price |
| --- | --- |
| Active CPU | $0.000024 per vCPU-second |
| Active memory | $0.0000025 per GiB-second |
| Requests | $0.40 per million |
| Free each month | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests |

Shape used for the estimate: 1 vCPU and 2 GiB, which is enough for the JPEG and the Microsoft gzip. Egress of the zip to the browser is extra (on the order of a few cents per GB after the free tier). Fetching source tiles is ingress.

Per export, before the free tier:

`cpu = seconds * 0.000024`

`memory = seconds * 2 * 0.0000025`

`request = 0.0000004`

At the warm 115 seconds: CPU $0.00276, memory $0.000575, request negligible, about $0.0033 per export. One thousand: about $3.34. The free tier covers about 1,500 of those a month on CPU (180,000 / 115). The heavier overlap at 180 seconds is about $0.0052, or $5.22 per thousand.

Instance-based billing is $0.000018 per vCPU-second and $0.000002 per GiB-second with no per-request fee, but the instance is billed while it is alive. That is cheaper only when exports run back to back. A quiet hour with a minimum instance is not.

## Fly.io (Ashburn or Secaucus, per second while the Machine runs)

| Machine | Per hour | Per month if left on |
| --- | --- | --- |
| shared-cpu-1x, 256 MB | $0.0030 | $2.19 |
| shared-cpu-1x plus RAM to 2 GB | about $0.017 | about $12.70 |
| performance-1x, 2 GB | $0.0458 | $33.00 |

The 2 GB shared shape is the one that matches this export. Extra RAM on the pricing page is $6 per GB per month. Stopped root disk is $0.15 per GB per month. A Machine that stops after the export is billed only for the seconds it ran.

At $0.017 per hour, the warm 115 seconds is about $0.00054. One thousand exports: about $0.54, plus disk if a volume is kept. The 180 second overlap is about $0.00085, or $0.85 per thousand. Bandwidth beyond the included amount is the zip the browser downloads, not the source tiles.

## Compared with staying on Netlify

Netlify background functions already allow about 15 minutes and the blob store used here. They do not add a second cloud account. The cache and the fan-out (at most 3 background invocations, 4 tile fetches in flight on each) stay inside that. A paid Cloud Run or Fly machine is worth it only when many large draws run at once and the 15 minute Netlify cap, or the single-function CPU, is the limit. One Wynn draw is a fraction of a cent on either host. The blob cache on Netlify saves the repeat downloads without that move.
