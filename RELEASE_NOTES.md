# OpenClutter v1.3.0

Released Oct 30, 2026 on openclutter.com and dev.openclutter.com.

## What's new

- **Feedback button.** A Feedback button in the bottom-right corner sends a bug report or idea, with up to 3 screenshots and an optional email for a reply. Reports go privately to the OpenClutter team.
- **Shareable links.** The address bar keeps the map view and the drawn box, so a site can be bookmarked or sent to someone and opens ready to export.
- **Clearer network messages.** When a company firewall or proxy blocks part of the site, the page says which step was blocked and suggests another network instead of failing silently. Feedback and Export check this up front.
- **Place labels.** Country, state, city and town names show on the draw map when zoomed out. They are never part of the export.
- **Better RV parks.** More trailers are found in shade and on pale concrete, roof fragments are no longer counted as extra RVs, and old building outlines on empty pads are left out.
- **Better tree crowns.** Crowns follow the leaves on the aerial photo, so tree cover is closer to what is really there.
- **Tower heights.** New towers keep their real height when the lidar flight is older than the building.
- **Copy terrain.** Terrain lines up with the imported map, the Copy terrain button is always shown after an export, and a new Terrain JSON link beside Download again saves the same terrain file.

## Data

No new map data in this release. Buildings read Overture release 2026-10-21.0.

## Git / deploy

- Tag `v1.3.0` on `main`; `dev` is at the same commit.
- Full history in CHANGELOG.md.

# OpenClutter v1.0.0

Production freeze of the working **buildings → Hamina OpenIntent** import.

## Highlights

- Search an address, draw a bbox, export one OpenIntent zip.
- Map + building `attenuation_areas` import in Hamina (Building - One/Two/Five/Ten Floor).
- Floorplan height matches Hamina outdoor default (2.5 m / 8.202 ft).
- Esri content grid preserved; isotropic meter frame via `unifyFrameMpu`.
- Trees and exact measured heights remain on `hamina-clipboard.json` (paste).

## Git / deploy

- Tag: `v1.0.0` on `main` tip that shipped PR #22.
- Long-lived `dev` branch for post-1.0 experiments.
- Production: https://openclutter.netlify.app (`main` only).
- Dev entry: https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app

## Upgrade / promote

Merge `dev` → `main` only when ready to cut a new production release; tag the new tip.
