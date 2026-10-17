# Canopy scoreboard

Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model. RF error compares fifty random 40 to 100 m links at 4 m above the ground. Predicted loss follows the exported foliage. Reference loss is 1.5 dB/m where that reference canopy is at least 4 m. The columns are the median and the 90th percentile of the absolute error.

| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | RF median | RF p90 | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Rogers campground | 94.8% | 55.9% | 63% | 11.1% | 4.5 m | 0.1 m | 3 | 0 | lidar | 59 dB | 106.8 dB | no |
| Granite Peak ski slope | 94.1% | 67.4% | 75% | 10.2% | 3.8 m | 0.2 m | 104 | 0 | lidar | 60.4 dB | 102.1 dB | no |
| Wynn golf course | 78.7% | 57.8% | 63.8% | 10.5% | 3.8 m | 0 m | 7 | 0 | lidar | 11.7 dB | 30.3 dB | no |
| Montreal suburb | 85.9% | 61.4% | 63.9% | 4.5% | 2.4 m | 0 m | 1 | 0 | chm | 17.7 dB | 59.4 dB | no |
| Oak Creek residential | 63.3% | 67.7% | 70.8% | 3.8% | 2.3 m | 0 m | 21 | 0 | lidar | 11.6 dB | 30.6 dB | no |
| Hoh rainforest edge | 54.5% | 17.6% | 30.5% | 37.8% | 5.5 m | 0 m | 15 | 0 | lidar | 0 dB | 12 dB | no |
| Innisbrook resort | 88.8% | 55.4% | 58.1% | 4.8% | 2.6 m | 0 m | 56 | 0 | lidar | 5.9 dB | 41.1 dB | no |
| Saguaro west desert | 57.9% | 32.8% | 34.8% | 6.3% | 1.9 m | 0 m | 18 | 0 | lidar | 11.8 dB | 30.4 dB | no |
| Brackenridge Park | 88.8% | 40.3% | 43.1% | 6.1% | 2.1 m | 0 m | 42 | 0 | lidar | 17.3 dB | 47.3 dB | no |
| Moraine Park campground | 85% | 59.8% | 61.9% | 4.8% | 3 m | 0 m | 178 | 0 | lidar | 6.1 dB | 47.8 dB | no |
| Lincoln Square street trees | 59.4% | 52.5% | 55.3% | 7.1% | 4.5 m | 0 m | 47 | 0 | lidar | 12.4 dB | 41.1 dB | no |
| Manuel Antonio | 98.4% | 93.1% | 93.5% | 0.8% | 3.5 m | 0.6 m | 61 | 0 | chm | 78.8 dB | 126.9 dB | yes |
| Syracuse leaf-off woods | 36.4% | 59.7% | 62.7% | 5.8% | 4.2 m | 0.3 m | 16 | 0 | lidar | 30.7 dB | 53.5 dB | no |
| Sodus apple orchard | 83.7% | 63.9% | 72.9% | 13.5% | 3.1 m | 0 m | 34 | 0 | lidar | 12.1 dB | 55.4 dB | no |
| Indio date grove | 73.6% | 48.4% | 53.1% | 9.3% | 2.8 m | 0 m | 4 | 0 | lidar | 6.2 dB | 24.3 dB | no |
| Las Vegas tower shadow | 76.2% | 45.9% | 52.3% | 13.2% | 3.4 m | 0 m | 2 | 0 | lidar | 0 dB | 30.3 dB | no |
| Palm Creek RV resort | 78% | 52.7% | 56.9% | 8.7% | 2.6 m | 0 m | 4 | 0 | lidar | 6.1 dB | 24.3 dB | no |
| Lebanon IN distribution center | 42.8% | 64.7% | 77.2% | 17% | 1.2 m | — | 4 | 0 | lidar | 0 dB | 21.7 dB | no |
