# Canopy bench baseline

Gate: the 18-site recall mean must not drop more than 0.5 points from this baseline.

Baseline from v1.2.15 (Oct 22, 2026): **75.11** over 18 sites. The previous baseline, 75.72 from v1.2.14, was recorded with the Chicago streets street map missing: the bench runs four sites at once and the single-try Overpass read lost that map, so about 845 buildings were kept instead of about 1850 and recall read 89.2. v1.2.15 reads the map through the retrying Overpass client, Chicago keeps its mapped buildings and reads 78.4 (v1.2.10 read 78.7 with the map). The other 17 sites average 74.93 on v1.2.14 and 74.91 on v1.2.15.

| Site | v1.2.14 recall | v1.2.15 recall |
| --- | ---: | ---: |
| arizona-desert | 56 | 56 |
| chicago-streets | 89.2 | 78.4 |
| colorado-camp | 83.7 | 83.7 |
| florida-resort | 88.5 | 88.6 |
| granite-peak | 94.9 | 94.9 |
| indio-palms | 71.9 | 71.9 |
| lancaster-nh | 93.6 | 93.6 |
| lebanon-dc | 41.9 | 43.1 |
| manuel-antonio | 97 | 97 |
| montreal-suburb | 88.6 | 87.2 |
| oak-creek | 63.7 | 63.7 |
| palm-creek-rv | 77.8 | 77.8 |
| pnw-conifer | 58.8 | 55.2 |
| sodus-orchard | 83.8 | 83.8 |
| syracuse-leafoff | 36.4 | 39.1 |
| texas-live-oak | 89 | 89 |
| vegas-tower-shadow | 73.7 | 73.7 |
| wynn-golf | 74.5 | 75.2 |
| mean | 75.72 | 75.11 |

## Site-type set (v1.2.18)

`node scripts/sitetype-bench.js` exports 10 RV parks, campgrounds, marinas, and fairgrounds (`bench/sitetype-sites.json`) with the page defaults and scores them against USGS 3DEP lidar (`bench/sitetype-scoreboard.md`). Set mean on v1.2.17 code: **63.48**. On v1.2.18: **63.74**. The lidar is two to eleven years older than the imagery, so parked vehicles and boats that moved count against both recall and precision; small-object numbers at marinas are a rough guide only. Pleasant Harbor's lidar predates its current slip layout, so its object scores are not counted.

v1.2.18 on the 18-site canopy set: 74.88 (same-day v1.2.17 reruns of the sites that moved: lebanon-dc 41.9, syracuse-leafoff 36.6, chicago-streets 78.3; v1.2.18 reads 41.9, 36.6, 78.0). The drift from 75.11 is upstream data, not the change.

v1.2.19 (marina walkways and shore strips, /dev hosts): site-type set **63.80** (Marina del Rey 67.6 to 67.9 with small-object precision 36.6 to 42.1, Sunrise Cove 73.9 to 74.2). 18-site canopy set 74.84. Wentworth boats on the vehicle bench read 75.0 recall (1.2.18 read 83.3; the two extra matches were boxes laid along a walkway beside the labelled boats).
