# Site-type scoreboard

RV parks, campgrounds, marinas, and fairgrounds, exported with the page defaults. Canopy recall is the canopy bench measure. Small and big objects are solid USGS 3DEP lidar cells (class-6 or flat single-return patches at least 1.5 m over ground or water), split at 150 m² connected size. Recall is the share an emitted non-vegetation area covers within 2 m; precision is the share of emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar predates the imagery, so moved vehicles and boats count against both. Site score is the mean of canopy recall (sites with canopy), small F1, and big F1. Worst-case pad fills (RVs drawn on pads the photo shows empty) are not in recall or precision; the pad columns count them and give the share of their area over a lidar solid object (within 2 m), over nothing within 2 m (gravel pad, bare ground, road or water), on a building roof, on a tree crown, and on mapped water. Sites marked with hand labels (lidar years older than the photo) score RVs against boxes drawn on the current photo instead of lidar small objects: one-to-one match at IoU 0.2 or a label holding the centre of a prediction under 40 m², pad fills excluded, uncertain boxes ignored, a building area matching a park model counts; the RV F1 replaces the small F1 in the score.

| Site | Kind | Canopy recall | Small recall | Small precision | Big recall | Big precision | Score | Pad fills | Pad on object % | Pad lidar-empty % | Pad on roof % | Pad on crown % | Pad on water % | Lidar |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Westwind RV resort | desert rv park | 57 | 47.6 | 90.4 | 86.2 | 96.8 | 70.2 | 107 | 16.3 | 79.9 | 1.1 | 2.8 | 0 | AZ_Southwest_5_D23 |
| Fort Wilderness campground | leafy campground | 89.3 | 20.1 | 94.3 | 93.5 | 92 | 71.7 | 8 | 15.3 | 2.7 | 0 | 82 | 0 | FL_Peninsular_FDEM_Orange_2018 |
| Pismo Coast Village RV resort | coastal rv park | 75.4 | 49.6 | 83.4 | 92 | 98.8 | 77.6 | 40 | 36.6 | 45.3 | 6.5 | 11.6 | 0 | CA_FEMA_Z4_B2_2018 |
| Marina del Rey basins | coastal marina | 74.2 | 33.9 | 42.1 | 86 | 99 | 67.9 | 0 | n/a | n/a | n/a | n/a | n/a | USGS_LPC_CA_LosAngeles_2016_LAS_2018 |
| Sunrise Cove marina | leafy lake marina, covered slips | 97.8 | 54.7 | 55.8 | 92.1 | 56.1 | 74.2 | 0 | n/a | n/a | n/a | n/a | n/a | GA_Statewide_B3_2018 |
| Pleasant Harbor marina | desert lake marina | 14.8 | 3.7 | 19.7 | 1.6 | 10.6 | 14.8 | 0 | n/a | n/a | n/a | n/a | n/a | AZ_MaricopaPinal_1_2020 |
| Minnesota State Fairgrounds | state fairgrounds | 82.4 | 9.5 | 70.5 | 93.4 | 92.4 | 64 | 0 | n/a | n/a | n/a | n/a | n/a | MN_CentralMissRiver_5_B22 |
| Iowa State Fairgrounds | state fairgrounds | 71.4 | 34.9 | 93.3 | 94.8 | 97.6 | 72.8 | 0 | n/a | n/a | n/a | n/a | n/a | IA_NorthCentral_2_2020 |
| Erie County Fairgrounds | county fairgrounds | 86.1 | 14.7 | 94.3 | 96 | 96.6 | 69.3 | 0 | n/a | n/a | n/a | n/a | n/a | NY_3County_2019 |
| Del Mar Fairgrounds | coastal county fairgrounds | 60.3 | 11 | 94.4 | 88.2 | 97.7 | 57.6 | 0 | n/a | n/a | n/a | n/a | n/a | CA_SanDiegoQL2_2014 |
| Silver View RV resort | hillside rv park | 63.7 | 53.5 | 51.7 | 98.1 | 57.5 | 65.9 | 131 | 12.7 | 75.5 | 0 | 11.8 | 0 | AZ_LowerColoradoRiver_B2_2018 |
| Silver View RV resort, south-west 150 m | hillside rv park, small draw | 7.4 | 21.2 | 24.7 | n/a | n/a | 71.1 | 22 | 8.1 | 88.3 | 0 | 3.6 | 0 | AZ_LowerColoradoRiver_B2_2018 |

Silver View RV resort: RVs vs hand labels, Vantor 2025-08-16: 48 labels, 30 predictions, 24 matched, recall 50, precision 80, F1 61.5 (replaces the lidar small F1).

Silver View RV resort, south-west 150 m: RVs vs hand labels, Vantor 2025-08-16: 29 labels, 16 predictions, 16 matched, recall 55.2, precision 100, F1 71.1 (replaces the lidar small F1).

Pleasant Harbor marina: The only lidar (2020) shows an older slip layout than the imagery, so object scores are shown but not counted.

Set mean: **64.76** over 12 sites.

Baseline (Oct 24, 2026, Silver View RVs scored against hand labels): 1.2.28 59.38 and 1.2.29 59.36 over 12 sites (Silver View south-west 150 m 12.9, whole park 60.4); 1.2.30 64.76.
