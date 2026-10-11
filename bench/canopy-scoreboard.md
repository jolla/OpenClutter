# Canopy scoreboard

Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Precision samples every emitted canopy cell on that same grid. The cell counts only when the height model is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

CHM ≥ 3 m is the height-model share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres of canopy thickness versus the canopy-height sample at the polygon centroid, for polygons that sit on a measured crown.

| Site | Recall | Precision | CHM ≥ 3 m | Open ground | Height MAE | Crowns | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Rogers campground | 86% | 72.7% | 80.3% | 9.9% | 2.2 m | 1500 | no |
| Granite Peak ski slope | 80.7% | 65.8% | 72.2% | 8.7% | 3.4 m | 2780 | no |
| Wynn golf course | 80.4% | 45.8% | 49.6% | 7% | 3 m | 1162 | no |
| Montreal suburb | 89.4% | 58.5% | 60.5% | 4.3% | 3.7 m | 1257 | no |
| Oak Creek residential | 83.1% | 65% | 68.2% | 4% | 4.2 m | 1577 | no |
| Hoh rainforest edge | 71% | 74.1% | 92.2% | 19.3% | 7.7 m | 3167 | no |
| Innisbrook resort | 81.7% | 65.6% | 67.5% | 3.4% | 4.3 m | 2088 | no |
| Saguaro west desert | 0% | — | — | — | — | 0 | no |
| Brackenridge Park | 91.7% | 70.1% | 74.1% | 5.5% | 3.3 m | 2206 | no |
| Moraine Park campground | 89.1% | 55.5% | 57% | 5% | 4 m | 2018 | no |
| Lincoln Square street trees | 78.5% | 60.6% | 64% | 4.8% | 5.4 m | 2239 | no |
| Manuel Antonio | 97.2% | 94.2% | 94.6% | 0.8% | 4.1 m | 503 | yes |
