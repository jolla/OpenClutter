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
