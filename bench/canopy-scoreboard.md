# Canopy scoreboard

Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Precision is the share of emitted canopy whose canopy-height sample is at least 3 m, sampled on the same uniform grid. Aerial green and a WorldCover tree label do not count as a hit. Open ground is the share of that emitted area the aerial reads as mown lawn, a dirt pitch, or a road. A site passes at 85% recall, 85% precision, and open ground at or under 8%.

These rows are the local handler that shipped as 1.1.125. The two-layer stand does not change the horizontal crowns, so recall and precision are the same. They are not a later `/dev` export. Floating is a crown whose bottom is more than 3 m above the terrain under it, not counting a band sitting on the crown below.

| Site | Recall | Precision (CHM ≥ 3 m) | Open ground | WorldCover recall | Height MAE | Crowns | Floating | Buried | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Rogers campground | 86% | 80.3% | 9.9% | 86.5% | 2.2 m | 1500 | 3 | 0 | no |
| Granite Peak ski slope | 80.7% | 72.2% | 8.7% | 80.7% | 3.4 m | 2780 | 18 | 0 | no |
| Wynn golf course | 80.4% | 49.6% | 7% | 77.6% | 3 m | 1162 | 7 | 0 | no |
| Montreal suburb | 89.4% | 60.5% | 4.3% | 90.7% | 3.7 m | 1257 | 8 | 4 | no |
| Oak Creek residential | 83.1% | 68.2% | 4% | 82% | 4.2 m | 1577 | 12 | 0 | no |
| Hoh rainforest edge | 71% | 92.2% | 19.3% | 71% | 7.7 m | 3167 | 8 | 0 | no |
| Innisbrook resort | 81.7% | 67.5% | 3.4% | 81.8% | 4.3 m | 2088 | 31 | 0 | no |
| Saguaro west desert | 0% | — | — | — | — | 0 | 0 | 0 | no |
| Brackenridge Park | 91.7% | 74.1% | 5.5% | 92.6% | 3.3 m | 2206 | 16 | 1 | no |
| Moraine Park campground | 89.1% | 57% | 5% | 91.3% | 4 m | 2018 | 3 | 0 | no |
| Lincoln Square street trees | 78.5% | 64% | 4.8% | 81.6% | 5.4 m | 2239 | 107 | 0 | no |
| Manuel Antonio | 97.2% | 94.6% | 0.8% | 97.7% | 4.1 m | 503 | 3 | 4 | yes |

One site clears the line. The other rows do not. Saguaro west has no crown to score: the height grid there is a handful of 3 m cells, and those stay out.

Rogers campground floating is 3, down from the 150 on the preview that was reviewed. Granite Peak no longer has a woods buried in the hill (buried 0). Hoh recall is 71%, up from 35% when forest blocks were dropped to fit the outline cap. Precision on several sites is still under 85% because part of the drawn canopy is not a 3 m height cell.
