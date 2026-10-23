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
