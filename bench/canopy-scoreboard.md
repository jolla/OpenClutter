# Canopy scoreboard

Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model.

| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Rogers campground | 89.9% | 52.5% | 58.4% | 13.4% | 4.2 m | 0.1 m | 0 | 0 | lidar | no |
| Granite Peak ski slope | 88.3% | 60.7% | 65.8% | 7.8% | 5.4 m | 0 m | 18 | 0 | lidar | no |
| Wynn golf course | 48% | 54% | 56.7% | 4.4% | 4.7 m | 0 m | 7 | 0 | lidar | no |
| Montreal suburb | 85% | 59.7% | 61.8% | 4.3% | 2.3 m | 0 m | 4 | 0 | chm | no |
| Oak Creek residential | 54.1% | 52.8% | 54.8% | 3% | 3.8 m | 0 m | 7 | 0 | lidar | no |
| Hoh rainforest edge | 90.1% | 39.7% | 50.1% | 29.6% | 15 m | 0.2 m | 18 | 13 | lidar | no |
| Innisbrook resort | 68.5% | 41% | 42.4% | 3.1% | 3 m | 0 m | 17 | 0 | lidar | no |
| Saguaro west desert | 1.2% | 30.3% | 31.2% | 2.4% | 8.6 m | — | 5 | 0 | lidar | no |
| Brackenridge Park | 88.8% | 33.4% | 35.5% | 5.4% | 3.4 m | 0 m | 19 | 0 | lidar | no |
| Moraine Park campground | 87.5% | 46.9% | 48.2% | 3.7% | 4.2 m | 0 m | 3 | 0 | lidar | no |
| Lincoln Square street trees | 49.4% | 53.5% | 55.4% | 4.2% | 4.3 m | 0 m | 87 | 0 | lidar | no |
| Manuel Antonio | 98.5% | 92.4% | 92.8% | 0.8% | 1.5 m | 0.1 m | 5 | 6 | chm | yes |
