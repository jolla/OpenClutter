# Canopy scoreboard

Where USGS 3DEP covers the draw, recall uses lidar: first returns minus ground, and a cell of at least 3 m is canopy. Elsewhere recall uses the Meta/WRI canopy height grid the same way, plus ESA WorldCover tree cover where that grid measured no height. Roof pixels are ignored. Precision samples every emitted canopy cell. The cell counts only when that reference is at least 3 m and the aerial is not an open lawn, mown field, RV pitch, or road. A green aerial pixel is not a hit. A site passes at 85% recall and 85% precision. Green on the overlay is emitted canopy that passes that test. Red is reference canopy still missing. Yellow is emitted canopy that fails it.

Height ≥ 3 m is the reference share alone, before the aerial open-ground rejection. Open ground is the share of emitted canopy the aerial reads as lawn or field, pitch, or road. Height error is metres between the canopy top above local ground and the canopy-height sample at that stack. A crown seated on a trunk or understory uses the full stack. Gap is the ground-to-crown distance versus the intended gap (about 3 m, or 30–40% of height on a tall conifer) for stands of at least 800 m². Floating is a preview piece whose base is more than 3 m above the terrain and is not sitting on another canopy piece. A slab is one crown of at least 8,000 m², or a connected sheet of crowns whose tops stay within 2 m and whose area is at least 12,000 m². Where USGS 3DEP covers the draw, recall, precision, and height error use first returns minus ground. A cell counts at 3 m. A site outside that coverage keeps the canopy-height model. RF error compares fifty random 40 to 100 m links at 4 m above the ground. Predicted loss follows the exported foliage. Reference loss is 1.5 dB/m where that reference canopy is at least 4 m. The columns are the median and the 90th percentile of the absolute error.

| Site | Recall | Precision | Height ≥ 3 m | Open ground | Height MAE | Gap MAE | Floating | Slabs | Ref | RF median | RF p90 | Pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Rogers campground | 95.5% | 52.6% | 59.8% | 15% | 4.3 m | 0.1 m | 8 | 0 | lidar | 59 dB | 106.8 dB | no |
| Granite Peak ski slope | 90.9% | 56.9% | 63.5% | 10.4% | 5 m | 0 m | 78 | 2 | lidar | 58.8 dB | 95.2 dB | no |
| Wynn golf course | 50.2% | 54.4% | 57.8% | 5.3% | 4.8 m | 0 m | 19 | 0 | lidar | 11.9 dB | 30.3 dB | no |
| Montreal suburb | 88.2% | 59.6% | 63.1% | 6.3% | 2.3 m | 0 m | 13 | 0 | chm | 12.4 dB | 59.4 dB | no |
| Oak Creek residential | 60.5% | 51.5% | 53.6% | 3.1% | 3.8 m | 0 m | 26 | 0 | lidar | 9.5 dB | 28.5 dB | no |
| Hoh rainforest edge | 95% | 46.5% | 57.6% | 22% | 22.8 m | 0 m | 6 | 0 | lidar | 47.4 dB | 103 dB | no |
| Innisbrook resort | 69.3% | 41.2% | 42.6% | 3.2% | 3.1 m | 0 m | 63 | 0 | lidar | 4.7 dB | 41.1 dB | no |
| Saguaro west desert | 1.1% | 30.5% | 31.3% | 2.2% | 8.8 m | — | 5 | 0 | lidar | 11.8 dB | 30.4 dB | no |
| Brackenridge Park | 88.8% | 33.6% | 35.7% | 5.4% | 3.5 m | 0 m | 27 | 0 | lidar | 17.3 dB | 43 dB | no |
| Moraine Park campground | 87.7% | 47% | 48.4% | 3.7% | 4.3 m | 0 m | 12 | 0 | lidar | 6.1 dB | 47.8 dB | no |
| Lincoln Square street trees | 50.2% | 54.1% | 56.2% | 4.5% | 4.6 m | 0 m | 224 | 0 | lidar | 19.9 dB | 43.1 dB | no |
| Manuel Antonio | 98.5% | 93.1% | 93.5% | 0.8% | 1.6 m | 0.1 m | 6 | 6 | chm | 78.8 dB | 126.9 dB | yes |
| Syracuse leaf-off woods | 36.4% | 59.9% | 63% | 5.9% | 5 m | 0 m | 48 | 0 | lidar | 34.5 dB | 53.5 dB | no |
| Sodus apple orchard | 86.7% | 54.3% | 60.4% | 12.9% | 4.9 m | 0 m | 28 | 0 | lidar | 6.1 dB | 55.4 dB | no |
| Indio date grove | 37.4% | 30.4% | 31.6% | 3.1% | 3.2 m | 0 m | 14 | 0 | lidar | 12.2 dB | 30.9 dB | no |
| Las Vegas tower shadow | 26.9% | 37.7% | 41.4% | 9% | 12.3 m | 0 m | 3 | 0 | lidar | 0 dB | 34.8 dB | no |
| Palm Creek RV resort | 56.1% | 42.8% | 43.3% | 1.3% | 2.8 m | 0.2 m | 5 | 0 | lidar | 6.2 dB | 27.6 dB | no |
