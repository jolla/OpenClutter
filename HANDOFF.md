# Handoff — keep iterating here

Repo: https://github.com/jolla/openintent-clutter
Owner: jolla (Jerry / Hamina)

## What to tell a new Grok chat

> Continue https://github.com/jolla/openintent-clutter
> Push fixes to main on that repo (GitHub is connected).
> Read HANDOFF.md first.

Do **not** use an X Grok bot. It cannot push to GitHub.

## Current product

Address + draw bbox → Netlify function builds OpenIntent zip → import in Hamina Planner.

- Imagery: Esri World Imagery export (same bbox as the math)
- Buildings: Microsoft US Building Footprints (Esri MSBFP2)
- Trees: OSM Overpass (wood/forest/golf_course/scrub + natural=tree)
- Coords: pixels, Y-up from south edge of bbox
- Scale: meters from bbox, not Hamina auto-scale

## Known issues (2026-09-20)

1. Alignment still slightly off in Hamina after import.
2. Heights are heuristics unless the footprint feature has a `height` property (most MS footprints do not).
3. OSM trees are sparse outside well-mapped parks/golf; golf tree belts often missing.
4. Hamina may still map OpenIntent `attenuation_areas` to walls on some builds — clipboard JSON is the fallback from the original Wynn thread.
5. Function timeout: Overpass + Esri + footprints must finish inside Netlify’s limit (~10s hobby).

## Next fixes (priority)

1. Confirm Hamina Y direction: export a Hamina project that contains one drawn object and diff coords vs image pixels.
2. USGS 3DEP point query or Microsoft/Google building height where available.
3. Optional tree fill: sample Esri image is hard in a function without a decoder; keep OSM or add a later image worker.
4. If objects import as walls, emit HaminaClipboard JSON as a second download.

## How to work

```
edit netlify/functions/clutter.js
push to jolla/openintent-clutter main
Netlify auto-deploys if the site is linked to this repo
```
