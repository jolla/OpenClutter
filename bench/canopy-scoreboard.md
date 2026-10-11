# Canopy scoreboard

Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Spot precision counts a drawn crown as correct when that reference agrees or the aerial pixel is green, because a dark stand the 10 m map missed is still a tree. Strict precision is the reference alone.

Height error is metres of canopy thickness versus the canopy-height sample at the polygon centroid, for polygons that sit on a measured crown.

The pass line is 85% recall and 85% spot precision. Scores are from a live `/dev` export of v1.1.123 except where the note says otherwise. Granite Peak is the v1.1.124 local handler, after the ski-run fix. Lincoln Square’s live export was still assembling buildings when the background job ran out of time, so that row is the local handler.

| Site | Version | Recall | Spot | Strict | Height MAE | Pass |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Rogers campground | 1.1.123 live | 99.0% | 98.9% | 80.0% | 2.6 m | yes |
| Granite Peak ski slope | 1.1.124 | 84.3% | 97.9% | 90.3% | 4.1 m | no |
| Wynn golf course | 1.1.123 live | 96.1% | 85.4% | 56.1% | 2.3 m | yes |
| Montreal suburb | 1.1.123 live | 92.3% | 89.9% | 69.1% | 4.3 m | yes |
| Oak Creek residential | 1.1.123 live | 91.3% | 86.8% | 79.4% | 3.4 m | yes |
| Hoh rainforest edge | 1.1.123 live | 98.6% | 99.3% | 99.0% | 8.8 m | yes |
| Innisbrook resort | 1.1.123 live | 84.1% | 92.3% | 80.0% | 3.5 m | no |
| Saguaro west desert | 1.1.123 live | 0% | — | — | — | no |
| Brackenridge Park | 1.1.123 live | 83.0% | 90.4% | 81.7% | 3.7 m | no |
| Moraine Park campground | 1.1.123 live | 96.9% | 87.7% | 70.4% | 5.2 m | yes |
| Lincoln Square street trees | 1.1.123 local | 92.2% | 81.9% | 63.6% | 3.9 m | no |
| Manuel Antonio | 1.1.123 live | 99.0% | 99.4% | 95.5% | 4.7 m | yes |

Seven sites clear the line. Five do not.

## What changed

v1.1.122 keeps dark conifer stands, fills gaps from canopy height and WorldCover, and notches roofs one at a time so the campground tree row stays.

v1.1.123 keeps shrub flats and meadow lawns out of the canopy. A WorldCover tree cell still fills a gap beside a measured crown. Crown outlines add vertices until the measured cells sit inside the ring. That is what lifted Montreal, Oak Creek, the Wynn, Colorado, and Chicago recall. Saguaro west no longer paints the desert.

v1.1.124 stops a mapped ski run from cutting the measured woods beside it. The live v1.1.123 Granite Peak export scored 18.8% recall because those corridors deleted the forest. A same-box export with no street-map answer had scored 96.8% on v1.1.122, which hid the cut. With the fix, recall is 84.3% and spot precision is 97.9%. A measured tree on the run stays. Color does not grow a new crown on the run.

Lancaster’s four conifer regions on the v1.1.123 zip, against aerial conifer color: west 98.9%, north 99.7%, hedge 94.6%, southeast 95.5%. The open center of the field stays mostly open (8.6% of that window). Roof overlap is about 10 m².

## Hamina preview

`scripts/hamina-preview.js` reads an OpenIntent zip and the Copy terrain paste. `scripts/hamina_preview.py` draws an oblique view without WebGL: the aerial on the floors, buildings in gray, trees extruded from bottom height to top height. Flat means thickness under 1 m. On all twelve benchmark zips that count is 0. Median tree thickness is 6.5–19.4 m. Saguaro west draws the terrain and the aerial only.

## Still short

- Granite Peak recall is 84.3%, spot precision 97.9%. Of the canopy-height samples (3 m and taller), the zip covers 96.8%. The miss that keeps the site under 85% is WorldCover tree cells the height model measured as empty. Those cells sit on the mapped ski runs. Color does not grow a crown there. A traced crown grid with the gaps filled, before the exporter cuts the rings, scores 99.9% recall and 94.1% spot precision on the same box.
- Innisbrook recall is 84.1% on the live plate (was 66.1% on a coarser one). Spot precision is 92.3%. The same filled crown grid, before export, scores 94.7% recall and 91.8% spot precision. The rings that leave `treesToOi` score 83%. Raising the canopy corner cap from 40 to 160, and unioning a self-intersecting ring before the half-split, left that emit score at 83%. Those two edits were not shipped.
- Brackenridge recall is 83.0%. Spot precision is 90.4%. The filled crown grid scores 87.2% recall and 89.9% spot precision before export. The zip is the step that falls short. The polygon cap was not what dropped them.
- Lincoln Square recall is 92.2%, spot precision 81.9%. Half of the extra canopy is not green in that aerial, so strict precision is 63.6%. The live export did not finish: it was still on buildings when the background job ran out of time. The row above is the local handler on the same code.
- Saguaro west has 14 canopy-height cells, all 3 m, and about 10 reference samples. A single export cell under 5 m is treated as noise, and coloring the shrub map painted the desert. The export draws nothing there.
- Hoh height error is 8.8 m on the live zip (10.4 m on the earlier local zip). A large stand stores its tallest cell, and the score samples the centroid. Coverage there is 98.6% / 99.3%.
