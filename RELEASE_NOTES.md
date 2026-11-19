# OpenClutter v1.3.42

Released Nov 23, 2026 on openclutter.com. dev.openclutter.com runs the same build.

## What's new

- **Larger exports.** Production can keep up to 14 MB (8.37 MB of OpenIntent JSON plus the map image), so large wooded sites keep more of their canopy.
- **Adaptive terrain.** Copy terrain follows the native elevation grid on steep or curved ground (pit walls, ski runs) instead of a fixed lattice. ?adaptiveTerrain=0 turns it off.
- **Overture street map.** Roads, parking, water, woods, barriers, and lights come from Overture Maps, with a smaller Overpass query for campgrounds, palms, and other gaps.
- **Faster exports.** Slope splits run in one persistent thread, JSON budget checks use cached area bytes, and Overture range reads stay in process.
- **Wall materials.** Buildings get per-type wall materials (wood frame, shed, carport, masonry, big-box, civic, glass, metal warehouse) from OSM and Overture tags. Typing a building does not drop it or change its outline.
- **Tropical woods.** On surface DEMs such as GLO-30, woods are no longer sliced into slope ramps, which had been shortening canopy at sites like Manuel Antonio.
- **Detections on the map.** After an export, /dev hosts show the zip's buildings, trees, and vehicles on the map by default. Off on production. ?preview=0 turns it off on /dev.

## Data

Street map features can now come from Overture Maps (Azure GeoParquet, same path as buildings). Overpass remains the fallback and still supplies the forest query when the street-map read misses woods.

## Git / deploy

- Tag `v1.3.42` on `main` after this commit; `dev` is at the same commit.
- forest=crowns or merge stays on dev.openclutter.com only.
- Fly worker is redeployed from this commit (it serves every host). Rollback target if smoke fails: v128 / deployment-01M7JW2RWTAHGAN68MVRD40ZF3.

# OpenClutter v1.3.38

Released Nov 16, 2026 on openclutter.com. dev.openclutter.com runs the same build.

## What's new

- **True scale.** Buildings and clutter export at their real size at every latitude.
- **Hamina project type.** An OpenIntent import sets the project to Outdoor (Trees / Foliage) when the area has tree cover, or Outdoor (Open) when it does not.
- **Turn the export box.** A finished box has a turn handle; the export comes out square to the turned box, including Copy terrain. ?rotate=0 hides the handle.
- **Clear the area.** A muted trash can next to the box clears it.
- **Search auto-fill.** After you draw a box, the search field fills with the nearest landmark and the city. A name you type yourself is left alone.
- **Water and Cars.** Those options are off the settings panel; exports leave both off.
- **Hillside trees (feedback #20).** Woods on a sloped hill sit on the floor instead of under it.
- **Turned terrain paste (feedback #21).** Copy terrain from a turned box pastes into Planner Plus.
- **Steadier street-map reads.** A hanging OpenStreetMap server is dropped after about 20 seconds, so a small export no longer waits a minute on a dead server.
- **Terrain and Copy terrain fixes.** US terrain retries the national elevation source before falling back; no fake trees on crater walls or pit benches; one level surface per lake or pond; Copy terrain floors stay at or under 1000 m.

## Data

No new map data in this release.

## Git / deploy

- Tag `v1.3.38` on `main`; `dev` is at the same commit.
- Adaptive terrain, the forest=crowns style and the 14 MB /dev JSON budget stay on dev.openclutter.com only.

# OpenClutter v1.3.20

Released Nov 9, 2026 on openclutter.com. dev.openclutter.com runs the same build.

## What's new

- **Resize from a corner.** Drag a corner of a finished box to resize it; the opposite corner stays put.
- **Move and clear.** Drag inside a finished box to move it. The small x by its corner, Delete or Backspace clears it.
- **Light pole map notes (feedback #14).** Copy terrain adds a map note at each light pole, so poles are easy to find. The OpenIntent file is unchanged.
- **RVs at point-mapped campgrounds (feedback #15).** A campground mapped only as a point now gets its RVs read from the photo (Williams AZ KOA: 0 to 30 RVs).
- **Sea and large water.** The sea and big rivers or lakes that run past the drawn area are drawn as water.
- **Turned export box (feedback #18).** Open the page with ?rotate=1 to get a turn handle on the box; the export comes out square to the turned box.
- **Smoother tree edges.** Forest outlines follow the crowns instead of stair steps on the height grid.
- **Anonymous usage counts.** Page views and exports are counted by day, week and month with no cookies and no stored IP addresses.

## Data

No new map data in this release.

## Git / deploy

- Tag `v1.3.20` on `main`; `dev` is at the same commit.
- True ground meters (trueMetres), adaptive terrain and the forest=crowns style stay on dev.openclutter.com only.

# OpenClutter v1.3.18

Released Nov 5, 2026 on openclutter.com. dev.openclutter.com runs the same build.

## What's new

- **Steadier street-map reads.** The OpenStreetMap read (Overpass) asks one server at a time, in order, and leaves a server alone for 30 minutes when it blocks this site, so an export no longer fails when the main server is overloaded.
- **Stale map note.** When an export had to use a street-map copy more than 3 days old, the export says so and names the copy's date.
- **Fence fix (from v1.3.16).** A slanted fence cut by the map edge stays on its line instead of stretching across a road.

## Data

No new map data in this release.

## Git / deploy

- Tag `v1.3.18` on `main`; `dev` is at the same commit.
- Sea and river water sides (seaWater), light pole map notes (poleNotes), campground points (campNodes), true ground meters (trueMetres), adaptive terrain and the forest=crowns style stay on dev.openclutter.com only.

# OpenClutter v1.3.13

Released Nov 2, 2026 on openclutter.com and dev.openclutter.com.

## What's new

- **Forests follow the canopy.** Large forests are cut along canopy height bands instead of a grid of about 50 m squares, so tree tops no longer step at every block edge and the file is smaller.
- **Tall trees in leaf-off photos.** Trees 12 m and taller are no longer cleared when a winter photo shows bare branches over leaf litter.
- **Water edges.** No RVs on the deck around a covered pool, and no trees standing in a mapped pond.

## Data

No new map data in this release. Buildings read Overture release 2026-10-21.0.

## Git / deploy

- Tag `v1.3.13` on `main`; `dev` is at the same commit.
- True ground meters (trueMetres), adaptive terrain and the forest=crowns style stay on dev.openclutter.com only.

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
