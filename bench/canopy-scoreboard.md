# Canopy scoreboard

Recall uses the Meta/WRI canopy height grid. A cell of at least 3 m is canopy. Where that grid measured no height, ESA WorldCover tree cover is also canopy. Roof pixels are ignored. Precision samples every emitted canopy cell on that same grid. The cell counts only when the height model is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

CHM ≥ 3 m is the height-model share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m².

| Site | Recall | Precision | CHM ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Rogers campground | 86% | 72.7% | 80.3% | 9.9% | 1.2 m | 0.2 m | 3 | 0 | no |
| Granite Peak ski slope | 80.7% | 65.8% | 72.2% | 8.7% | 2.6 m | 0 m | 18 | 0 | no |
| Wynn golf course | 79.3% | 46.5% | 50.2% | 6.4% | 1.1 m | 0 m | 5 | 0 | no |
| Montreal suburb | 89.3% | 58.5% | 60.5% | 4.3% | 2 m | 0 m | 7 | 0 | no |
| Oak Creek residential | 83.3% | 66.2% | 68.3% | 2.5% | 1.8 m | 0 m | 15 | 0 | no |
| Hoh rainforest edge | 70.7% | 74.3% | 92.2% | 19.2% | 5.6 m | 0 m | 10 | 0 | no |
| Innisbrook resort | 83% | 66.1% | 67.2% | 2.1% | 2.2 m | 0 m | 20 | 0 | no |
| Saguaro west desert | 0% | — | — | — | — | — | 0 | 0 | no |
| Brackenridge Park | 91.6% | 70.2% | 74.2% | 5.5% | 1.6 m | 0 m | 13 | 0 | no |
| Moraine Park campground | 89.1% | 55.5% | 57% | 5% | 2.1 m | 0 m | 1 | 0 | no |
| Lincoln Square street trees | 80.5% | 60.6% | 64% | 4.8% | 2.6 m | 0 m | 105 | 0 | no |
| Manuel Antonio | 98.2% | 94.1% | 94.5% | 0.8% | 1.4 m | 0.1 m | 5 | 5 | yes |
