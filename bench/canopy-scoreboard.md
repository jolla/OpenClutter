# Canopy scoreboard

Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model.

| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Rogers campground | 88.5% | 55.7% | 62% | 9.9% | 4.4 m | 0.2 m | 3 | 0 | lidar | no |
| Granite Peak ski slope | 90.7% | 56.9% | 62.3% | 8.7% | 5.5 m | 0 m | 18 | 0 | lidar | no |
| Wynn golf course | 51.3% | 48.9% | 52.3% | 6.4% | 5.4 m | 0 m | 5 | 0 | lidar | no |
| Montreal suburb | 89.3% | 58.5% | 60.5% | 4.3% | 2 m | 0 m | 7 | 0 | chm | no |
| Oak Creek residential | 62.7% | 51.3% | 53.1% | 2.5% | 3.9 m | 0 m | 15 | 0 | lidar | no |
| Hoh rainforest edge | 83.5% | 48.6% | 59.4% | 19.2% | 24.6 m | 0 m | 10 | 0 | lidar | no |
| Innisbrook resort | 75.5% | 41.2% | 42% | 2.1% | 2.9 m | 0 m | 20 | 0 | lidar | no |
| Saguaro west desert | 0% | — | — | — | — | — | 0 | 0 | lidar | no |
| Brackenridge Park | 89.5% | 33.2% | 35.3% | 5.5% | 3.3 m | 0 m | 13 | 0 | lidar | no |
| Moraine Park campground | 88% | 45.5% | 47.3% | 5% | 4.4 m | 0 m | 1 | 0 | lidar | no |
| Lincoln Square street trees | 53.8% | 54% | 56.4% | 4.8% | 4.2 m | 0 m | 105 | 0 | lidar | no |
| Manuel Antonio | 98.2% | 94.1% | 94.5% | 0.8% | 1.4 m | 0.1 m | 5 | 5 | chm | yes |
