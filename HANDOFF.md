# Handoff — keep iterating here

Repo: https://github.com/jolla/openintent-clutter
Owner: jolla (Jerry / Hamina)

## What to tell a new Grok chat

> Continue https://github.com/jolla/openintent-clutter
> Prefer a branch + PR for clutter.js / HANDOFF changes; push to main only if PR tools fail and HANDOFF requires it.
> Read HANDOFF.md first.

Do **not** use an X Grok bot. It cannot push to GitHub.

## Current product

Address + draw bbox → Netlify function builds OpenIntent zip **or** HaminaClipboard JSON → import / paste in Hamina Planner.

- Imagery: Esri World Imagery export (same bbox as the math)
- Buildings: Microsoft US Building Footprints (Esri MSBFP2) — **no OSM building rings**
- Coords (OpenIntent): pixels, Y-up from south edge of bbox
- Scale: meters from bbox (`widthM` / `lengthM`), not a separate Hamina auto-scale
- Clipboard path: POST with `"format": "hamina-clipboard"` (or `clipboard: true`). Uses the **same** `widthM`/`lengthM`/`mpu` as the zip path:
  - `x_clip = x_px * mpu - widthM`
  - `y_clip = y_from_south_px * mpu - lengthM`
  - Prefer clipboard paste when OpenIntent `attenuation_areas` import is unreliable

## Dual-scale warning (Wynn Golf Course GE screenshot)

When the Hamina **map image** is a Google Earth screenshot, Planner may auto-scale it to a size that does **not** match the image’s true geographic extent (world file / scale bar). Example: 3840×2160 GE frame ≈ 2376×1337 m geographically, but Hamina showed ≈ 796×448 m (16:9).

In that case:

1. Fit lon/lat → **image pixels** via an ESRI world file (`.jgw`), not via `widthM` from a lon/lat bbox alone.
2. Convert pixels → clipboard meters with **Hamina’s map meters** (`MPU = haminaWidthM / imageWidthPx`), not the geographic meters.
3. Prefer **HaminaClipboard paste**; do not rely on OpenIntent `attenuation_areas` until verified.
4. Do **not** inject OSM building/tree rings into the Wynn clipboard rebuild.

Offline builder for that site: `build_aligned_clipboard.py` (see ALIGN_NOTES in the Wynn clutter-align workdir).

For **new** sites where this function’s Esri imagery + bbox meters are the map source, keep one consistent scale (`widthM`/`lengthM`) — do not apply the Wynn dual-scale hack.

## Known issues (2026-09-20)

1. Alignment can still be slightly off after import (MS footprint vintage vs imagery).
2. Heights are heuristics unless the footprint feature has a `height` property (most MS footprints do not).
3. OSM trees (if re-enabled) are sparse outside well-mapped parks/golf; prefer image green-mask offline for golf belts.
4. Hamina may still map OpenIntent `attenuation_areas` to walls on some builds — use HaminaClipboard JSON.
5. Function timeout: Esri footprints must finish inside Netlify’s limit (~10s hobby). Clipboard path skips imagery fetch.

## Next fixes (priority)

1. Confirm Hamina Y direction: export a Hamina project that contains one drawn object and diff coords vs image pixels.
2. USGS 3DEP point query or Microsoft/Google building height where available.
3. Optional tree fill in the function (needs image decode worker) or keep offline green-mask.
4. Front-end toggle: download zip vs HaminaClipboard JSON.

## How to work

```
edit netlify/functions/clutter.js
open a branch + PR (or push to main if PR blocked and deploy is needed)
Netlify auto-deploys if the site is linked to this repo
```
