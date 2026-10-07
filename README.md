# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import the zip for the map and **buildings**. **Foliage** is on by default on the dev page. Uncheck it for buildings only. The zip is that OpenIntent JSON and the aerial. Copy terrain is a separate paste.

**v1.0.0** — stable buildings → Hamina OpenIntent import (production freeze).

**v1.1.74** on `dev` — The first Export tries once more in that same click when the gateway returns an empty response, and the status says the first export did not return a zip while that second try is still working. If that try is also empty, the status stays “The export did not return a zip.” A discrete-tree stem stays about 1 m across and round. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.74`).

**v1.1.73** on `dev` — Dense canopy (Foliage - Heavy, and a measured canopy at or above 12 m) is 1.5 dB/m. A discrete-tree stem is 3 dB/m and about 1 m across, a round footprint under the crown, so it stays thinner than the canopy. Light foliage stays 1 dB/m. Buildings stay 5 dB/m. Terrain paste stays 0. These are 5 GHz per-meter figures. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.73`).

**v1.1.72** on `dev` — Copy terrain now includes two Hamina GPS tie points, the southwest and northeast corners of the imported map. OpenIntent has no GPS field, so they stay on that Planner Plus paste. Northeast is local (0, 0) and southwest is (−width, −height), with the corner latitude and longitude. Terrain off still offers Copy GPS points, with no mesh and no DEM on the zip. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.72`).

**v1.1.71** on `dev` — On a large downtown Sharp draw, a 2048 px plate that cannot finish no longer burns the clock. Sharp asks for 1040 px first when that 2048 frame is over about 3.2 million pixels, and buildings and canopy height start with the map, so a missed plate still leaves roofs and trees in the zip. A smaller Sharp draw still asks for 2048. Copy terrain stays the separate paste. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.71`).

**v1.1.70** on `dev` — Buildings sit on the pasted mesh again. Taking the elevation read off the zip had left every building bottom on the floor, so the sloped paste buried them. The elevation response now includes the samples that mesh used, and the zip sets each building bottom to the downhill ground under that piece. The mesh stays out of the zip. Copy terrain is still the separate paste. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.70`).

**v1.1.69** on `dev` — Copy terrain on a US draw no longer comes back empty when the first bare-earth read misses the clock. That request starts Copernicus beside USGS, and if bare earth is still out the paste is the surface grid that already finished. A USGS grid that returns in time is still the one copied. The page tries the elevation request once more in the same export before it asks you to export again. The zip stays the OpenIntent JSON and the aerial JPEG, and the mesh stays off that clock. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.69`).

**v1.1.68** on `dev` — On a long Vegas draw, building footprints and measured heights start with the map and keep the rest of the answer clock. Towers cut by the edge stay in the zip at their measured height instead of falling back to a short stock floor while the trees export. The Sphere south of this golf polygon is outside the draw and is not added. Copy terrain is still the separate paste. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.68`).

**v1.1.67** on `dev` — Terrain on reads elevation in its own request, so the map and foliage cannot spend that clock. Copy terrain still pastes in Planner Plus when that read returns. If it does not, the page says to export again. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.67`).

**v1.1.66** on `dev` — Terrain on starts the elevation read with the map, including High and Sharp, so a slow plate does not omit the paste. Copy terrain still pastes in Planner Plus. The zip stays the OpenIntent JSON and the aerial JPEG. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.66`).

**v1.1.65** on `dev` — The draw label leads with area, such as `5,000 m² · 53,820 ft²`, and leaves the side lengths off that line. Space pans the map while a site is being drawn, and it does not toggle the last checkbox or button. The Map note says Auto is fast and High and Sharp wait for a bigger plate. Terrain has a short note: copy and paste in Planner Plus, and do not import it as OpenIntent. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.65`).

**v1.1.64** on `dev` — The export note is one line, with the rest under Details. The foliage control is labeled **Foliage**, on by default, with no Experimental tag. Terrain and the Map menu stay as they are. Include foliage stays a request flag on the API. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.64`).

**v1.1.63** on `dev` — High on the ~850 m draw was the same 400 px plate as Auto, because that 1040 px request was cut off at 2.5 s and the zip stepped down. High now waits for the 1040 px plate, and Sharp asks for 2048 px. Buildings and terrain start after that plate is in hand. The status names the pixels that landed, and says when a plate was still out. A 4K plate does not come back inside the gateway, so it is not a choice. Auto is unchanged. Terrain on still pastes the sloped mesh. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.63`).

**v1.1.62** on `dev` — The dev page has a Map menu: Auto, Low · 256 px, Standard · 640 px, or High · 1040 px. Auto is the same plate as before: a short draw at half a meter, a long draw at 400 px. High asks for a 1040 px plate and steps down to 400 px when that plate is still out. The status names the plate that landed. Terrain is on or off, and Terrain on pastes the sloped mesh. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.62`).

**v1.1.61** on `dev` — The white-roof convent at the south tip of the Pointe-Claire peninsula stays in the zip. OpenStreetMap already had that roof, and the export was dropping it because the trees on it looked like a parking lot. A measured building with trees on the roof is kept. A gray parking lot is still dropped. The ~850 m draw stays on the workable aerial so the zip still returns inside the gateway. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.61`).

**v1.1.60** on `dev` — A venue name that is not an OpenStreetMap point can still land on the building when a public search snippet prints the street. `Casa Evexia` and `Casa Evexía` resolve to 298 Lakeshore, Pointe-Claire. The typed address, including the bilingual Chem. street, still goes straight to Nominatim. A name with no street in that snippet stays empty, and the page says to try the street address. This is not a places directory. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.60`).

**v1.1.59** on `dev` — A short draw, including the Pointe-Claire peninsula, exports a sharper aerial (half a meter, capped at 1040 px). A long campus stays on the coarser plate so the zip still returns inside the gateway. Terrain on starts the elevation read with that aerial. In southern Canada, where USGS 3DEP has no grid, the paste comes from Copernicus and Copy terrain is on the page when that grid returns. A short draw also starts building footprints with the aerial, so a Quebec site is not left at zero roofs when Overture can answer. Search accepts the bilingual street `298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3`. The map no longer paints the CARTO “API KEY REQUIRED” tiles through the aerial. The zip is still only the OpenIntent JSON and the aerial JPEG. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. The badge stays (`dev · v1.1.59`).

**v1.1.58** on `dev` — Include foliage draws traced canopy outlines again, across the whole draw. A tree is a trunk under a raised crown, and a wider canopy keeps the measured outline. A crown that is small on the coarse aerial is scaled up to Hamina's minimum span instead of being replaced with a square. Canopy height starts with the aerial: one full-site read first, then finer strips, and peaks already read stay if the clock runs out. A miss leaves foliage out of the zip instead of drawing grid squares. The zip is still only the OpenIntent JSON and the aerial JPEG. Include foliage stays off and Experimental. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.58`).

**v1.1.57** on `dev` — The export zip is the OpenIntent JSON and the aerial JPEG. Clipboard JSON, the terrain paste, and the debug notes stay out of that zip. Copy terrain still pastes from the page when Terrain is on. Include foliage stays off and Experimental. The measured crowns from v1.1.52 stay. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.57`).

**v1.1.56** on `dev` — The first Export returns a zip inside the platform timeout. The dev image starts at 400 px and steps down to 256 px in that same request. Buildings and that aerial are sent as soon as they are ready. A slow terrain, foliage, or Overture read is left out instead of holding the function until the gateway answers 504. If the buildings still cannot finish, the function returns JSON “Export timed out. Retry the export.” in that same window, instead of an empty 504. An empty gateway response is still one try, and the page says “The export did not return a zip.” Include foliage stays off and Experimental. The measured crowns from v1.1.52 stay. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.56`).

**v1.1.55** on `dev` — The first Export returns a zip before the gateway closes the request. The dev image starts at 640 px and steps down to 400 px in that same request, and it does not keep fetching after that plan. Terrain, foliage, and a still-running building read stop by 10 seconds so the buildings zip can be sent. A gateway timeout is one try, and the page says “The export did not return a zip.” Include foliage stays off and Experimental. The measured crowns from v1.1.52 stay. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.55`).

**v1.1.54** on `dev` — One Export click returns a zip or one clear sentence. The export image starts at the production size (1040 px) and steps down to 640 px in that same request, including one more try while the function clock is still open. A 502 is not sent three times, and the page does not go quiet after “Aerial imagery timed out.” It says “The export did not return a zip.” A slow terrain read stops at 12s so the buildings zip can still download. Include foliage stays off and Experimental. The measured crowns from v1.1.52 stay. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.54`).

**v1.1.53** on `dev` — The first Export returns a zip. The canopy-height read is taken in short strips and stops when the export clock runs out, so that read cannot hold the function until the gateway answers with an empty 502. Foliage is left out of that zip when the height read does not finish; buildings still download. An empty 502 is one try, and the page says “The export did not return a zip.” It is not asked for three times with no sentence. Include foliage stays off and Experimental. The measured crowns from v1.1.52 stay. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.53`).

**v1.1.52** on `dev` — Include foliage stays off and Experimental. When it is on, a measured crown is kept even when it is one tree: the canopy grid keeps the peak instead of averaging it into the grass, and the extra foliage budget is used for those compact crowns. The larger canopy masses stay. Roofs, pavement, water, and ground under 3 m stay clear. A one-pixel spike is not a tree. Buildings stay the quiet cool gray from v1.1.48. There is no new control. The badge stays (`dev · v1.1.52`).

**v1.1.51** on `dev` — A slow sharp aerial steps down to the production-size image in that same request, and the zip comes back on the first try. The page does not stop on “Aerial imagery timed out” or “The export stopped before a zip was ready.” The status line says the export is working only while Export is in progress. Buildings stay the quiet cool gray from v1.1.48. There is no new control. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.51`).

**v1.1.50** on `dev` — A drawn site returns a zip before the gateway closes the request. A sharp aerial that is still out steps down and the export finishes in that same request. The status line says the export is working only while Export is in progress. It does not stay on that line after the button is idle, and the page does not send the same long request three times. Buildings stay the quiet cool gray from v1.1.48. There is no new control. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.50`).

**v1.1.49** on `dev` — A drawn site exports. A slow aerial still finishes, and the status line keeps saying the export is working. An empty gateway or platform response is tried again and a later zip is the download. The page does not stop on “Export failed. Retry.” Buildings stay the quiet cool gray from v1.1.48. There is no new control. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.49`).

**v1.1.48** on `dev` — Buildings are one cool gray. A short floor is slightly lighter (`#C5CBD1`) and a tall tower, including 187 m, is slightly darker (`#A2A8AE`). A missing height number is the middle gray (`#B4BAC0`). The footprint size is not turned into a height for that color. Trees and foliage stay the same greens. A gateway timeout retries the export while the status line still says the export is working, instead of stopping on “Export did not finish.” There is no new control and no legend. Address, draw, and export stay the same. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.48`).

**v1.1.47** on `dev` — Buildings take their color from vertical height, so a short building and a tall tower are easy to tell apart. One Floor is blue (`#377EB8`), Two Floor is orange (`#FF7F00`), Five Floor is purple (`#984EA3`), Ten Floor is red (`#E41A1C`), and a measured tower above that stock height, including a 187 m tower, is yellow (`#F0E442`). A height we do not have stays a quiet gray (`#8B949E`). Trees and foliage stay the same greens. There is no new control and no legend. Address, draw, and export stay the same. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.47`).

**v1.1.46** on `dev` — The draw readout leads with how far across the site is. A small draw uses meters and feet. A campus on the order of a kilometer, such as Wynn at about 2 km, uses kilometers and miles. Area follows on the same line in square meters, with square feet quieter beside it, and steps up to hectares and acres when that number is huge. There is no unit toggle. Address, draw, and export stay the same. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.46`).

**v1.1.45** on `dev` — A Wynn-sized draw exports again. The finer aerial (0.5 m pixels, up to a 2048 px long side) is kept when that image is slow. While the zip is still running, the status line says the export is still working. A slow export is not reported as an area that is too large. A smaller site still gets that finer image. There is no resolution slider. The map still follows Esri tiles through level 23. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.45`).

**v1.1.44** on `dev` — The aerial on /dev is sharper. The map follows Esri World Imagery tiles through level 23, and a drawn site’s export asks for 0.5 m pixels up to a 2048 px long side. A slow or failed image steps down to the previous size instead of dropping the map. There is no resolution slider. Address, draw, and export stay the same. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.44`).

**v1.1.42** on `dev` — A building on a slope is cut into the hill. Bottom height from floor is the downhill ground under that piece, and top height from floor is that bottom plus the building height, so the footprint meets the slope on the uphill side and continues down into the hillside on the downhill side. The roof stays the measured height above that ground. A footprint that climbs more than about 2.5 m is split so each piece keeps that height. A building on flat ground stays on the floor. Terrain paste stays a separate paste. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.42`).

**v1.1.41** on `dev` — Include foliage stays off and Experimental. When it is on, a compact measured crown is one tree: a stem under the crown, the crown bottom above the ground, and the crown top still at the measured height. A continuous canopy stays one mass on the ground. Tree points are not turned into trees. Buildings stay as they are. There is no extra switch on the page. The badge stays (`dev · v1.1.41`).

**v1.1.40** on `dev` — Include foliage stays off and Experimental. When it is on, canopy and tree attenuating objects export with Hamina’s Transparent in 3D flag (`transparencyEnabled: true`), so they are see-through in 3D. Buildings omit that flag and stay opaque. There is no extra switch on the page. Hamina still draws that transparency only when Transparency effects are on in Settings. The badge stays (`dev · v1.1.40`).

**v1.1.39** on `dev` — A recorded dome, including the MSG Sphere at its measured 112 m, is stacked rings that shrink toward that top, so the plan stays round and the height is a dome. A roof that records both a high side and a low side is several pieces whose tops follow those two heights. A plain box stays one object. The curved Wynn tower still has one measured height and no low side in the source, so it stays one flat top; a second height is not invented. Finish shape stays gone. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.39`).

**v1.1.38** on `dev` — A measured tower taller than Hamina’s Ten Floor stock keeps that height. A wider lower footprint with a taller inset inside it is two attenuating objects: the podium on its own plan, and the tower on its plan at the measured height. A plain box stays one object. A height no source recorded is not invented. Finish shape stays gone. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.38`).

**v1.1.37** on `dev` — Finish shape is gone. Click the map to place corners; there is no extra close button. Click the first corner to close a shape of 3 or more corners. Export commits an open polygon of 3 or more corners and refuses one or two. Right-drag or a two-finger drag pans and does not finish the shape or open a menu. Hold Space and drag to pan, including while a polygon is open. The badge stays (`dev · v1.1.37`).

**v1.1.36** on `dev` — A pasted hill lifts every building, including a US bare-earth slope under 20 m and a raised-layer stack. The bottom is the high edge of each slope cell the footprint sits in, so the low side of a ramp does not leave the building under the floor. A shared cell edge still uses the height at that edge. Pieces of a steep footprint and a tower on a podium each use the slope under their own outline. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.36`).

**v1.1.35** on `dev` — Include foliage stays off and Experimental. A measured canopy cell that is a real tree is kept, including a tall crown only one or two cells wide. Roofs, roads, pavement, and water stay clear, and a percent reading does not invent a tree where the canopy-height model is empty. Terrain on still has no resolution slider. Auto fills the 20×20 paste budget on a mild hill as well as a ski hill; a larger draw stays coarse because that cap is what Planner Plus accepts. Raised layers use the same plan. The badge stays (`dev · v1.1.35`).

**v1.1.34** on `dev` — On a sloped site, each building’s bottom height from floor is the top of the slope under that footprint, including a cell edge the outline only shares. A footprint that climbs more than about 8 m is split so each piece sits on its own slope. A taller plan inside a shorter one (a tower on a podium) is two attenuating objects; a single simple box stays one. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.34`).

**v1.1.33** on `dev` — Left click still draws; Draw is optional. A right-drag pans the map and does not finish the shape or open a menu. Hold Space and drag to pan, including while a polygon is open. Click the first corner to close a shape of 3 or more corners. Finish shape stays optional. Export still commits an open polygon of 3 or more corners and still refuses one or two. The badge stays (`dev · v1.1.33`).

**v1.1.32** on `dev` — Include foliage stays off unless checked, and it still wears the Experimental tag. Canopy is still a traced outline, not a grid square. Foliage attenuating objects set Hamina’s Transparent in 3D flag (`transparencyEnabled: true`) on the OpenIntent material and on the clipboard zone type. Buildings omit that flag and stay opaque. Turn on Transparency effects in Hamina settings to see through the canopy. The badge stays (`dev · v1.1.32`).

**v1.1.31** on `dev` — The map starts ready to draw. Click it to place corners; Draw is optional. A shape with 3 or more corners closes when you click the first corner again, including a click that comes back near the start. Double-click still finishes. Finish shape stays optional. A two-corner line does not close. Export still commits an open polygon of 3 or more corners and still refuses one or two. The badge stays (`dev · v1.1.31`).

**v1.1.30** on `dev` — Include foliage stays off unless checked, and it still wears the Experimental tag. When it is on, canopy extent and height come from the Meta/WRI canopy height model. US tree-canopy percent can add cells only where that cover is denser and a measured height is already known. Canopy is kept off building footprints and pavement, so it does not sit on roofs or parking. Bottom height from floor is the terrain under the footprint. Top height from floor is that bottom plus the measured canopy height. If the canopy-height read times out, foliage is left out of the zip and the status says so. Buildings still download. The badge stays (`dev · v1.1.30`).

**v1.1.29** on `dev` — A large campus with Terrain on still returns **Copy terrain** for **Sloped** and **Raised layers**. Both styles use the same elevation read. When the full grid does not come back, a coarser grid is pasted instead (still at most 20×20, and at most 400 raised floors). The status still starts with `Terrain sloped` or `Terrain raised layers`. The OpenIntent zip is unchanged. The badge stays (`dev · v1.1.29`).

**v1.1.28** on `dev` — With Terrain on, the page offers **Sloped** (the default ramp mesh, one quad per cell) and **Raised layers** (stacked height-band rectangles, 1 m bands, at most 400 floors). The style radios appear only when Terrain is on. Status names the mode (`Terrain sloped 20×20` or `Terrain raised layers 12×8`). Terrain stays a checkbox, on by default, with no resolution control. When it is off, that export skips the DEM and Copy terrain. The badge stays (`dev · v1.1.28`).

**v1.1.27** on `dev` — Terrain stays a checkbox, on by default, with no resolution control. When it is on, Auto sizes cells from the draw: about 1 m on a small hill and coarser on a large one, at most 20×20 quads, so Copy terrain stays a paste Planner Plus can take. When it is off, that export skips the DEM and Copy terrain. The badge stays (`dev · v1.1.27`).

**v1.1.26** on `dev` — A polygon closes without a right-click. After three corners, double-click, click the first corner, or **Finish shape**. Export commits that open polygon. A ring of one or two corners blocks export instead of sending the previous outline. Esc still drops only the open corners. The badge stays (`dev · v1.1.26`).

**v1.1.25** on `dev` — The Terrain resolution control is gone. Terrain stays a checkbox, on by default. When it is on, export uses the densest mesh that still fits (about 1 m cells, stepped coarser only when that grid will not fit the response). When it is off, that export skips the DEM and Copy terrain. The subtitle and muted badge stay (`dev · v1.1.25`).

**v1.1.24** on `dev` — Include foliage wears an Experimental tag and stays off unless checked. A Terrain checkbox sits next to it, on by default. Turn it off and that export skips the DEM and Copy terrain. Terrain resolution stays hidden while Terrain is off. The subtitle and muted badge stay (`dev · v1.1.24`).

**v1.1.23** on `dev` — The subtitle under the title says what Export does: a zip you import in Hamina for the aerial map and buildings. The small muted build label stays (`dev · v1.1.23`).

**v1.1.22** on `dev` — The address panel drops “One zip.” The build label sits in the corner in small muted type (`dev · v1.1.22`). Address, draw, and export stay the same.

**v1.1.21** on `dev` — Finland terrain paste uses the same ground-meter frame as the aerial, so the quads are roughly square and the status shows that cell size. A 1 m or Auto paste on a town is meter-scale: the mesh steps coarser only when the draw will not fit, and the readout names that size instead of a 500×500 label on a stretched slab. GLO-30 is still about 30 m native; a finer cell is interpolated. A Finland town export still offers **Copy terrain** after the ground-meter aerial resample. When little time is left, the elevation grid steps down to a coarser lattice and still pastes, instead of omitting terrain with a timeout. A Finland town import keeps the shape and the ground scale of the map you drew. The aerial is resampled so east–west and north–south pixels are ground meters, and buildings and terrain paste use that same frame. A US site keeps the existing aerial grid. A Finland export finishes. The Hamina NLS laser grid is packaged with the function, so measured building heights still apply, and a grid that cannot be read omits those heights inside a successful zip instead of Export failed (502). Buildings and canopy sit on the pasted slope: bottom height from floor is the higher of the DEM under the footprint and the pasted floor there, and top height from floor is that bottom plus the object height. A US bare-earth hill still lifts the same way; a US site under 20 m of relief still stays on the floor. Terrain resolution on the dev host adds **20, 15, 10, 5, and 1 m** past Finest (~25 m). Auto, Default, and Fine stay. Those finer stops can paste denser than the old 20×20 Hamina expectation so a ski hill can keep that cell size (mesh cap 500 quads on a side, enough for about 5 m on a 2.5 km draw). The readout shows the cell size and the ground that mesh covers. A paste past 20×20 is listed in `export-warnings.json`. A mesh that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download. The status names that reduction. If it still cannot, Copy terrain is left out and the OpenIntent zip still downloads. DEM samples for those stops step down when time is short. The dev host still keeps the v1.1.14 sharper Esri World Imagery JPEG (1600 px on the long side instead of 1040); production keeps the 1040 cap, and there is no imagery-quality control on the page. Outside USGS 3DEP coverage the dev host still gives up on that request quickly and reads Copernicus DEM GLO-30, including a coarser grid when the aerial has already used the export clock. Building and foliage objects sit on that surface. A US 3DEP hit is unchanged. Production stays 3DEP only. The page title and the export zip (`openclutter_version`) both read this from `package.json`.

Live: https://openclutter.netlify.app · Dev: https://openclutter.netlify.app/dev · Source: https://github.com/jolla/OpenClutter

## Production vs Dev

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.netlify.app | https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app |
| Git branch | `main` | `dev` |
| Purpose | Frozen **v1.0** buildings OpenIntent import — address, draw, export | Experiments (trees-in-OI, terrain, etc.) without breaking production |

- Use **production** for the known-good 1.0 buildings workflow.
- Hack on **https://openclutter.netlify.app/dev**. The panel corner shows a small muted build label (`dev · v1.1.74`). **Foliage** is on by default. **Terrain** is on by default and pastes the sloped mesh. Copy that paste into Planner Plus. Do not import it as OpenIntent. A Map menu picks Auto, Low · 256 px, Standard · 640 px, High · 1040 px, or Sharp · 2048 px. Auto is fast. High and Sharp wait for a bigger plate. Space pans the map and does not toggle the last checkbox. The draw label shows area in m² and ft². After export, the panel shows one line; Details holds the rest. The lattice is Auto: about 1 m on a small hill, coarser on a large one, at most 20×20. There is no resolution control. Terrain and the map menu stay hidden off this host.
- Workflow: open feature PRs against `dev`. Promote with a PR `dev` → `main` only for a production release; then tag (e.g. `v1.1.0`).


## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. Buildings use Hamina’s Building - One/Two/Five/Ten Floor catalog (Jerry’s gold export). When Include foliage is on, canopy uses the picker types **Foliage - Heavy** (19.68 ft, 1.5 dB/m) and **Foliage - Light** (19.68 ft, 1 dB/m), same object shape. A measured height that is not 19.68 ft is a custom `Foliage - Heavy H.H` / `Foliage - Light H.H`. A discrete tree adds `Foliage - Trunk H.H` (3 dB/m, about 1 m across, a round footprint). There is no Tree type. `Tree Trunk` and per-metre `Foliage N.N m` stay off the OpenIntent catalog.

One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box. After that snap, meters are unified to the JPEG pixel aspect (`lengthM = imgH * widthM/imgW`) so Hamina’s isotropic map scale matches. In the continental US the aerial content grid is kept. At high latitude (Finland), that degree grid is resampled so pixels are square in ground meters, and buildings, the aerial, and terrain paste use that frame.
2. Building footprints mapped through that actual extent: Microsoft Global ML (height used when the tile has one), Overture Buildings (`height` or `num_floors`), Esri MSBFP2, then FEMA USA Structures. One ring per roof; the best measured height wins.
3. **Include foliage** (off unless checked, still marked Experimental). When on, canopy extent and height come from the Meta/WRI canopy height model. Each polygon is the traced outline of a connected canopy, simplified so it follows that edge instead of a grid square, at the measured height. US tree-canopy percent can add a cell only where that cover is denser and a measured height is already known. It does not replace the height. Cells on building footprints and on pavement or roads are cleared, and rings are cut around footprints (4 m buffer) and water, so canopy does not sit on roofs, parking, or ponds. If the canopy-height read times out, foliage is left out of the zip and the status says so. Buildings still export. Individual tree-point circles are not emitted. A compact crown is one tree: a round stem about 1 m across under a raised crown. A wider canopy stays one mass, with no stem.
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `attenuation_areas` are **buildings** by default. Buildings use Building - One/Two/Five/Ten Floor. With Include foliage on, canopy uses Foliage - Heavy or Foliage - Light. A measured canopy height that is not the stock 19.68 ft uses `Foliage - Heavy H.H` or `Foliage - Light H.H` at that height. Bottom height from floor is the terrain under the footprint (the same rule as buildings). Top height from floor is that bottom plus the measured canopy height. A lone tree point is not a circle.

**Import this zip in Hamina (Projects → Import → OpenIntent)** for the map and buildings. Check Include foliage before export when the site should include canopy. Do not use a GE screenshot as the map.

### Materials that import

Building `area_material` objects keep exactly these keys: `name`, `rf_properties.attenuation_per_m`, `top_height`, `display_color`. Foliage adds `transparencyEnabled: true`, the flag Hamina already uses for Transparent in 3D on an attenuating zone type. Buildings omit that key. No `itu_material_type`, no `bottom_height` on a flat site. The object deep-equals its catalog entry (a stock name with a different `top_height` is rejected). Buildings are always the gold prefix. A vegetation material is added only when an area uses it, so a buildings-only zip stays the four gold objects. Clipboard foliage types set the same `transparencyEnabled` flag; building types leave it false. Hamina only draws that transparency when Transparency effects are on in Settings.

| Name | Color | Top height | dB/m | Used for |
|---|---|---|---|---|
| Building - One Floor | `#C5CBD1` | 4.5 | 5 | buildings under 6 m |
| Building - Two Floor | `#BDC3C9` | 7.620092660326749 | 5 | buildings under 11 m |
| Building - Five Floor | `#B4BAC0` | 15.240185320653499 | 5 | buildings under 24 m |
| Building - Ten Floor | `#ABB1B7` | 32 | 5 | buildings through 32 m |
| Building - H.H | same gray, by height | measured metres | 5 | a measured height. Above 32.25 m, including a 187 m tower, the color is `#A2A8AE`. No height number is the middle gray `#B4BAC0` |
| Foliage - Heavy | `#3F7D2A` | 19.68 ft | 1.5 | stock canopy, and measured heights within 0.25 m of that |
| Foliage - Light | `#6FA84A` | 19.68 ft | 1 | lighter stock canopy |
| Foliage - Heavy H.H | `#3F7D2A` | measured metres | 1.5 | measured canopy at or above 12 m |
| Foliage - Light H.H | `#6FA84A` | measured metres | 1 | measured canopy under 12 m |
| Foliage - Trunk H.H | `#8B6B4F` | stem height | 3 | discrete-tree stem, about 1 m across, round |

These names emptied every `attenuation_area` when they were in the catalog, and they are not emitted: `Tree Trunk`, `Foliage N.N m`, `Tree Trunk N.N m`, `Hotel podium`, `Building N.N m`. With Include foliage on, measured canopy metres stay on the old clipboard download as `foliage-m-*` for the canopy polygons (not trunks, not tree-point circles, and not a file in the OpenIntent zip). Building metres stay on `bldg-m-*`. The stock names above are the picker types, emitted as full material objects (not a name string, and not with `itu_material_type` or `bottom_height`). Foliage materials are added only when Include foliage is on.

Rings over 40 vertices, or thinner than 4 px on either axis, are omitted. They do not drop the buildings. `stats.openIntentBuildingAreas` and `stats.openIntentTreeAreas` count what the OpenIntent JSON kept.

A/B from the gold schema: the default zip is the four gold objects. Include foliage adds an unmeasured canopy polygon as the exact `Foliage - Heavy` or `Foliage - Light` object (19.68 ft, 1.5 or 1 dB/m) and leaves the building `area_material` unchanged. A 14.2 m canopy adds `Foliage - Heavy 14.2` (top_height 14.2, 1.5 dB/m, `#3F7D2A`) instead of a 9 m or 15 m bucket. A discrete tree also adds `Foliage - Trunk H.H` at 3 dB/m. OpenIntent 2.0.1 does not enum-restrict material names. `Foliage - Heavy 14.2` is not `Foliage 14.2 m`. Each area deep-equals its catalog entry. Rings stay at ≤40 vertices. Buildings and canopy masses stay at ≥4 px on both axes. A discrete stem keeps its ~1 m circle instead of growing to that floor. NLCD patches of two or more cells are the cell outline. A lone tree point is omitted. If a Hamina import still drops every area, the next step is binning every canopy polygon into the two stock objects.

OpenIntent pixels (unit-tested; Y-up from SW, matching oiconvert / Hamina OI):

```
SW (west, south) → (0, 0) px
SE (east, south) → (imgW, 0) px
NW (west, north) → (0, imgH) px
NE (east, north) → (imgW, imgH) px

JPEG Y-down:  y_img from NW
OpenIntent Y-up: y_up from SW
y_up + y_img = imgH
```

Clipboard meters (silent fallback JSON inside the zip, same frame):

```
SW → (−widthM, −lengthM)   NE → (0, 0)
JPEG Y-down:  x_clip = x_img * mpuX − widthM ;  y_clip = −y_img * mpuY
```

With **Include foliage** checked, canopy extent and height come from the **Meta/WRI canopy height** window on the same extent. Each polygon is the traced canopy outline at that measured height, not a grid square, not a circle, and not a percent bucket. USFS/NLCD percent tree canopy (threshold ≥18%) can add a cell only where that cover is denser and a measured height is already known. A single NLCD cell, a placed tree point, and a parking-median dot are not emitted as circles. Aerial color is not used to place canopy. If the canopy-height read times out, foliage is omitted and the status says so. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8). Polygons are clipped to the JPEG and invalid rings are dropped so one bad ring cannot wipe the import.

`stats.includeFoliage` is `false` by default. `stats.treesSource` is `"none"` unless foliage is on, then `"nlcd-canopy"` or `"none"`. A canopy-height timeout keeps `includeFoliage` true and sets the status to foliage omitted.

## Use

1. Search an address.
2. Draw the site (under ~2 km on a side).
3. **Include foliage** — leave unchecked for buildings only. Check it to add canopy polygons.
4. **Export** — `{site}-openintent.zip` only. When USGS 3DEP returns a grid, **Copy terrain** pastes pads and slopes into Planner Plus. A DEM miss does not block the zip. Inside:
   - `openIntent_<slug>.json` — OpenIntent 2.0.1 with building `attenuation_areas` (gold Building materials). With Include foliage on, canopy polygons use Foliage - Heavy / Light, or a measured-height custom. Floorplan height 2.5 m (Hamina outdoor default)
   - `images/<slug>.jpg` — Esri aerial
5. Hamina: **Projects → Import → OpenIntent**.
6. The zip has those two files. `stats.attenuationAreasEmitted` matches the OpenIntent `attenuation_areas` length. `openIntentTreeAreas` is 0 unless Include foliage was on. Copy terrain is the page paste, not a file in the zip.

### Sloped sites (Granite Peak)

Terrain still cannot go in the OpenIntent zip. **Copy terrain** pastes open quads into Planner Plus. **Auto** fills the paste budget on a flat lot and on a hill: about 1 m cells, at most 20×20 quads. A larger draw is coarser because that cap is what Planner Plus accepts, not because relief under 20 m drops to 6×5. The 3DEP sample count is denser than that mesh and stays at most 576. **Default** is about 80 m quads, at most 12×12 (144 DEM samples) — the same mesh as v1.1.5. **Fine** is about 40 m, at most 16×16 (324 samples). **Finest** is about 25 m, at most 20×20 (576 samples). The page always uses that Auto and pastes one ramp per cell. Default, Fine, and Finest stay available on the API and stay inside 20×20 quads. Quads stay Jerry’s open-quad schema: four corners, ring not closed, sloped floors with one z on the low edge and a higher z on the opposite edge. The ring is counterclockwise in clipboard meters on a north, south, east, or west grade. The grade axis is the larger rise/run, not the larger raw `|Δz|`. `slabOnly` stays false.

Hamina’s attenuating-object fields are **bottom height from floor** and **top height from floor**. On a ski-hill DEM those are OpenIntent `bottom_height` and `top_height` (clipboard `bottomEdge` and `topEdge`):

- Bottom height from floor = the downhill ground under that piece (meters above the lowest DEM sample, same zero as the terrain paste). That is the low end of the pasted ramp under the piece. The uphill side of the piece is cut into the hill.
- Top height from floor = that bottom + the building height, so the roof stays the measured height above that ground. With Include foliage on, canopy still uses the uphill slope under that canopy, plus the foliage height.

The building material name is `Building - One Floor 86.4` (the number is the bottom). A lifted canopy is `Foliage - Heavy @ 86.4`, or `Foliage - Heavy 14.2 @ 86.4` when 14.2 m is the canopy thickness. Those are not the poisoned `Building N.N m` / `Foliage N.N m` forms, and they are not `bottom_height: 0` on a gold object. A pasted mesh sets that bottom on bare earth and on a surface DEM, including Oak Creek (~6 m), Long Meadow (~15 m), and the Las Vegas Sphere box (~17 m). On a slope the bottom is the downhill end of the ramp under that piece, so the downhill face meets the hill instead of hanging above it. A shared cell edge uses the height at that edge. A level pad keeps the building on the pad. Ground under 1 m still omits `bottom_height`. Foliage is on unless unchecked.

Retest Granite Peak / Rib Mountain, Wausau WI: draw the ski hill (under ~2 km on a side), Export, Import the zip, Copy terrain and paste it in Planner Plus, then check 3D. A building on the hill should meet the slope on the uphill side and run down into the hill on the downhill side, with the roof still the measured height above that ground. It should not float with a gap under the downhill face, and it should not hang past the slope. A building on flat ground stays on the floor. With Foliage checked, export again, Import and Copy terrain: foliage should be visible on the slope in 3D. A valley object whose ground is under 1 m stays on the floor.

The page has **Foliage**, checked by default. On the dev host only, a **Terrain** checkbox sits under it, on by default, and a Map menu sits under that. Terrain on pastes the sloped mesh. Export uses Auto for the lattice either way: about 1 m cells on a small hill, coarser on a large one, at most 20×20 quads. There is no resolution control. Terrain and the map menu are hidden wherever the dev badge is hidden. Tree source (NLCD canopy polygons when Foliage is checked), OSM, and calibration stay automatic or API-only.

## API

`POST /api/clutter`

```json
{
  "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site",
  "includeFoliage": false,
  "terrainResolution": "auto",
  "trees": [{ "lon": -115.16, "lat": 36.128 }],
  "treesSource": "nlcd-canopy",
  "osmTrees": false,
  "format": "bundle"
}
```

- `includeFoliage` — default `false`. `false` exports buildings only (tree points and canopy hits are ignored). `true` adds connected canopy polygons and skips individual tree-point circles. Query `includeFoliage=true` is the same switch.
- `terrainResolution` — `auto` (omit it, or send an unknown value, and the server uses this), `default`, `fine`, `finest`, `20`, `15`, `10`, `5`, or `1` (`20m` is the same as `20`). Query `terrainResolution=` is the same switch; a non-empty body value wins. On a ski hill (DEM relief at least 20 m) Auto sizes cells from the draw, about 1 m on a small hill and coarser on a large one, and stays at most 20×20 quads. Its 3DEP `sampleCount` is denser than that mesh and stays at most 576. The named manuals stay fixed: Default ~80 m / max 12×12 / 144 samples, Fine ~40 m / max 16×16 / 324, Finest ~25 m / max 20×20 / 576. The meter stops aim at that cell size and may pass 20×20, up to 500 quads on a side, so a 2.5 km draw can still fill at about 5 m. A 1 m mesh on that draw is capped and the warning says how much ground 1 m would cover. A paste that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download, and that reduction is named in the export status. If it still cannot, Copy terrain is left out and the zip still downloads. DEM samples for the meter stops step down when the budget is short (at most 2500). Relief under 20 m keeps the 2×2, 4×3, or 6×5 ladder for Auto and every manual. The dev page sends `auto` when Terrain is checked and skips the DEM when Terrain is off. The older Hamina paste expectation is about 20×20 quads.
- `format: "bundle"` (default) — JSON with `zipBase64`, `frame`, `stats`, `alignment`, `terrainStatus`, and `gpsClipboard`. `gpsClipboard` is a HaminaClipboard paste whose `tiePoints` are the southwest and northeast corners of the imported aerial (northeast local x/y is 0, 0). OpenIntent does not carry those points. When 3DEP returns a grid, `terrainClipboard` is the Planner Plus paste (**Copy terrain**) and includes the same two tie points. `terrainFilename` names that paste. The zip does not contain it. The page downloads only the OpenIntent zip. When the DEM is omitted, `terrainClipboard` is null and `terrainStatus` says so; `gpsClipboard` is still the two corners. `stats` includes `includeFoliage`, `buildingsKept`, `treesKept`, `treesSource`, `fetched`, and drop reasons. With foliage off, `treesSource` is `"none"` and `treesKept` is 0.
- `format: "zip"` — same OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch; old-Hamina fallback)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

Global ML (zoom-9 quadkey, clipped to the JPEG) is the base polygon. Overture Buildings release `2026-08-19.0` is read from one or two Azure GeoParquet row groups (committed bbox index, not a full scan). Esri MSBFP2 (paginated to 2000) and FEMA USA Structures fill centroids still uncovered. A candidate is the same roof when its centroid sits inside a kept ring or within 11 m of that ring’s centroid. Geometry is replaced only for a single exterior that is more detailed at a similar area, or when the kept ring is a stub inside a fuller outline. Height rank: Overture explicit height, then Microsoft Global ML `height` (values ≤ 2 m and −1 ignored), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m, then the nearest measured neighbor within 120 m, then stock One Floor / Five Floor / Hotel bins. Ties keep the height already on the ring. A stub whose area is outside 0.4–2.5× does not overwrite a larger footprint’s height. OpenIntent building `area_materials` stay the four Hamina outdoor Building - One/Two/Five/Ten Floor objects. Tree attenuation areas add stock Foliage - Heavy / Light, or `Foliage - Heavy H.H` / `Foliage - Light H.H` at a measured height (`compatibilityMode` `stock-foliage`). The old clipboard download still carries foliage zone names and exact metres. It is not in the zip. OSM building ways are not read.

A large smooth bright roof that none of those layers contain is filled from the Esri JPEG (connected membrane pixels, ≥2500 m², skipped when a vector already covers it). Boxes over ~2.5 km fail before the export runs. A Microsoft footprint tile larger than 80 MB (the Los Angeles quadkey is well over that; Oak Creek and Las Vegas are not) is left out of that one export. The zip still includes the other building sources, and the page status says the tile was omitted. If the campus still will not fit in one download, the zip keeps the largest roofs and says so. A draw that already has more than 1500 building footprints skips imagery roof fill, and that skip is the same kind of note. Campus-merge blobs &gt; 150,000 m² are dropped. When Include foliage is on, canopy comes from the Meta/WRI canopy height model and is cleared off building footprints and pavement. Individual tree points and median dots are not emitted. A canopy-height timeout leaves foliage out of the zip. The status says so, and buildings still export. On a large draw, canopy cells are merged until the zip still downloads. USGS 3DEP `getSamples` (no API key; Auto scales with the draw, at most 576 points; Default 144, Fine 324, Finest 576; 20/15/10/5/1 m step down from at most 2500 when the budget is short) becomes the Copy terrain paste only. That paste is not a file in the zip. On the dev host, a 3DEP miss reads Copernicus DEM GLO-30 for that same box (surface model; `bottom_height` stays off). Production does not. Flat pads are used when a cell’s corner relief is under 0.5 m, otherwise one open sloped quad (low edge, then the opposite high edge). OpenIntent stays free of raised and sloped floors. The DEM request starts after imagery metadata snaps the extent and overlaps the JPEG, so a long aerial download does not skip it. Overture starts with the aerial JPEG, before the Global ML download, on its own abort. A finished read is kept even if the core phase has passed 5 seconds. A read still in flight may run until 23 seconds from the start (about 4.5 seconds of grace after a slow map). The row group that contains the site center is read first, and only GeoParquet pages whose bbox stats hit the site are fetched. The Las Vegas Sphere is in that center row group and missing from Microsoft and USA Structures; aborting the read at 9 seconds dropped it on the live dev export. If the canopy-height read does not finish, foliage is left out and the page status says so. The OpenIntent zip still exports. A 3DEP miss is recorded the same way. The page does not ask for a smaller box when a source times out. FEMA, NLCD, and 3DEP are United States sources.

## Development

Feature work targets the long-lived **`dev`** branch (see [Production vs Dev](#production-vs-dev)). Promote `dev` → `main` only for production releases.

```bash
npm test
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev
```

`npm run eval` scores the default export (Include foliage off) against cached aerial fixtures: buildings only, no foliage attenuation areas. It fails if rooftops are missed, large footprints are dropped, the default zip emits foliage, measured building heights collapse back to stock bins, Overture does not add or upgrade a footprint, the terrain clipboard is empty on a sloped DEM, or the imagery mask cannot restore the Oak Creek white retail roof after that polygon is removed. Foliage-on coverage (canopy polygons only, no tree-point circles, foliage/building and foliage/foliage overlap) is in the test suite. Optional: `npm run eval -- --live` to refresh against live imagery.


## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL), Overture Maps Foundation, and FEMA USA Structures (ORNL / NGA). Canopy height © Meta / World Resources Institute. Elevation © USGS 3DEP. On the dev host, when that grid is missing: Copernicus DEM GLO-30, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
