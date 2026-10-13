# Canopy scoreboard

Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model. RF error compares fifty random 40 to 100 m links at 4 m above the ground. Predicted loss follows the exported foliage. Reference loss is 1.5 dB/m where that reference canopy is at least 4 m. The columns are the median and the 90th percentile of the absolute error.

| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | RF median | RF p90 | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Rogers campground | 89.9% | 52.5% | 58.4% | 13.4% | 4.2 m | 0.1 m | 0 | 0 | lidar | 59 dB | 106.8 dB | no |
| Granite Peak ski slope | 88.3% | 60.7% | 65.8% | 7.8% | 5.4 m | 0 m | 18 | 0 | lidar | 60.4 dB | 102.1 dB | no |
| Wynn golf course | 48% | 54% | 56.7% | 4.4% | 4.7 m | 0 m | 7 | 0 | lidar | 11.9 dB | 30.3 dB | no |
| Montreal suburb | 85% | 59.7% | 61.8% | 4.3% | 2.3 m | 0 m | 4 | 0 | chm | 12 dB | 59.4 dB | no |
| Oak Creek residential | 54.1% | 52.8% | 54.8% | 3% | 3.8 m | 0 m | 7 | 0 | lidar | 7 dB | 29.7 dB | no |
| Hoh rainforest edge | 90.1% | 39.7% | 50.1% | 29.6% | 15 m | 0.2 m | 18 | 13 | lidar | 54.8 dB | 107.8 dB | no |
| Innisbrook resort | 68.5% | 41% | 42.4% | 3.1% | 3 m | 0 m | 17 | 0 | lidar | 4.7 dB | 41.1 dB | no |
| Saguaro west desert | 1.2% | 30.3% | 31.2% | 2.4% | 8.6 m | — | 5 | 0 | lidar | 11.8 dB | 30.4 dB | no |
| Brackenridge Park | 88.8% | 33.4% | 35.5% | 5.4% | 3.4 m | 0 m | 19 | 0 | lidar | 17.3 dB | 43 dB | no |
| Moraine Park campground | 87.5% | 46.9% | 48.2% | 3.7% | 4.2 m | 0 m | 3 | 0 | lidar | 6.1 dB | 47.8 dB | no |
| Lincoln Square street trees | 49.4% | 53.5% | 55.4% | 4.2% | 4.3 m | 0 m | 87 | 0 | lidar | 19.9 dB | 47.3 dB | no |
| Manuel Antonio | 98.5% | 92.4% | 92.8% | 0.8% | 1.5 m | 0.1 m | 5 | 6 | chm | 79.4 dB | 126.9 dB | yes |
| Syracuse leaf-off woods | 36.7% | 58.4% | 61.3% | 6.2% | 4.2 m | 0 m | 14 | 0 | lidar | 34.5 dB | 53.5 dB | no |
| Sodus apple orchard | 88.2% | 55.5% | 59.4% | 8.3% | 5.2 m | 0 m | 4 | 0 | lidar | 4 dB | 59.5 dB | no |
| Indio date grove | 36.6% | 29.1% | 30.1% | 3.2% | 2.9 m | 0 m | 5 | 0 | lidar | 17.7 dB | 30.1 dB | no |
| Las Vegas tower shadow | 29.2% | 34.3% | 37.3% | 8.4% | 12.8 m | 0 m | 4 | 0 | lidar | 0 dB | 34.8 dB | no |
| Palm Creek RV resort | 53.2% | 41% | 42.6% | 4.3% | 3 m | 0 m | 2 | 0 | lidar | 9.9 dB | 27.6 dB | no |
