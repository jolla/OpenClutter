# Canopy scoreboard

Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Spot precision counts a drawn crown as correct when that reference agrees or the aerial pixel is green, because a dark stand the 10 m map missed is still a tree. Strict precision is the reference alone.

Height error is metres of canopy thickness versus the canopy-height sample at the polygon centroid, for polygons that sit on a measured crown.

The pass line is 85% recall and 85% spot precision. v1.1.122 is the local-handler baseline. v1.1.123 was re-exported for every site that missed that line, plus Lancaster, Montreal, Oak Creek, the Wynn, Texas, Colorado, and Chicago. Granite Peak, the Hoh, and Manuel Antonio already cleared the line on v1.1.122 and were not exported again.

| Site | Version | Recall | Spot | Strict | Height MAE | Pass |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Rogers campground | 1.1.123 | 99.1% | 98.6% | 77.5% | 2.5 m | yes |
| Granite Peak ski slope | 1.1.122 | 96.8% | 94.4% | 87.7% | 5.4 m | yes |
| Wynn golf course | 1.1.123 | 96.2% | 85.1% | 56.4% | 3.7 m | yes |
| Montreal suburb | 1.1.123 | 92.3% | 89.9% | 69.1% | 4.3 m | yes |
| Oak Creek residential | 1.1.123 | 91.3% | 86.8% | 79.4% | 3.4 m | yes |
| Hoh rainforest edge | 1.1.122 | 98.4% | 99.3% | 99.0% | 10.4 m | yes |
| Innisbrook resort | 1.1.123 | 84.1% | 92.3% | 80.0% | 3.5 m | no |
| Saguaro west desert | 1.1.123 | 0% | — | — | — | no |
| Brackenridge Park | 1.1.123 | 83.0% | 90.4% | 81.7% | 3.7 m | no |
| Moraine Park campground | 1.1.123 | 96.9% | 87.7% | 70.4% | 5.2 m | yes |
| Lincoln Square street trees | 1.1.123 | 92.2% | 81.9% | 63.6% | 3.9 m | no |
| Manuel Antonio | 1.1.122 | 99.0% | 99.4% | 95.5% | 4.8 m | yes |

## What changed in v1.1.123

- Shrub and bare ground no longer become a woods from color. The Saguaro frame had been painted solid (spot precision 25.8%, strict precision 0). It now draws no crowns.
- Broadleaf color on grass or crop stays a meadow. Spruce on a grass label still fills. Colorado spot precision went from 83.3% to 87.7%, and the Wynn from 81.9% to 85.1%.
- WorldCover tree cover still fills gaps, including beside a measured crown. That is what lifted Montreal (80.8% to 92.3%), Oak Creek (82.6% to 91.3%), and Chicago recall (74.9% to 92.2%).
- A simplified outline adds vertices until the measured cells sit inside the ring.

Lancaster’s four conifer regions on the v1.1.123 zip, against aerial conifer color: west 98.9%, north 99.7%, hedge 94.6%, southeast 95.5%. The open center of the field stays mostly open (8.6% of that window). Roof overlap is about 10 m².

## Still short

- Innisbrook recall is 84.1% (was 66.1% on a coarser plate). Spot precision is 92.3%. The miss is measured palm and oak canopy the outline does not cover. Another vertex pass did not close the last point.
- Brackenridge recall is 83.0% (was 77.9%). Spot precision is 90.4%. Same edge gap on live oaks, and the polygon cap was not what dropped them.
- Lincoln Square recall is 92.2%, spot precision 81.9% (was about 71.6%). Half of the extra canopy is not green in that aerial, so counting only the reference would be 63.6%. The photo and the green test disagree on a lot of the street trees (aerial green covers 40% of the reference).
- Saguaro west has 14 canopy-height cells, all 3 m, and 10 reference samples. A single export cell under 5 m is treated as noise, and coloring the shrub map painted the desert. The export draws nothing there. Recall against those spikes is 0. That is the stop, not a woods.
- Hoh height error is 10.4 m. A large stand stores its tallest cell, and the score samples the centroid. Coverage there is 98.4% / 99.3%.
