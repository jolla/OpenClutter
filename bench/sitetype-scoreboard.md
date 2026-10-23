# Site-type scoreboard

RV parks, campgrounds, marinas, and fairgrounds, exported with the page defaults. Canopy recall is the canopy bench measure. Small and big objects are solid USGS 3DEP lidar cells (class-6 or flat single-return patches at least 1.5 m over ground or water), split at 150 m² connected size. Recall is the share an emitted non-vegetation area covers within 2 m; precision is the share of emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar predates the imagery, so moved vehicles and boats count against both. Site score is the mean of canopy recall (sites with canopy), small F1, and big F1. Worst-case pad fills (RVs drawn on pads the photo shows empty) are not in recall or precision; the pad columns count them and give the share of their area over a lidar solid object (within 2 m), over nothing within 2 m (gravel pad, bare ground, road or water), on a building roof, on a tree crown, and on mapped water.

| Site | Kind | Canopy recall | Small recall | Small precision | Big recall | Big precision | Score | Pad fills | Pad on object % | Pad lidar-empty % | Pad on roof % | Pad on crown % | Pad on water % | Lidar |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Westwind RV resort | desert rv park | 58.5 | 46.7 | 91.8 | 86 | 96.8 | 70.5 | 155 | 18.9 | 71.4 | 5.5 | 4.3 | 0 | AZ_Southwest_5_D23 |
| Fort Wilderness campground | leafy campground | 87.9 | 17.6 | 96.4 | 93.5 | 92 | 70.1 | 9 | 26.8 | 2.5 | 0 | 70.6 | 0 | FL_Peninsular_FDEM_Orange_2018 |
| Pismo Coast Village RV resort | coastal rv park | 75.7 | 48 | 84.4 | 91 | 98.8 | 77.2 | 144 | 31.4 | 52.1 | 6.4 | 10 | 0 | CA_FEMA_Z4_B2_2018 |
| Marina del Rey basins | coastal marina | 73.5 | 33.7 | 43 | 85.9 | 99 | 67.8 | 0 | n/a | n/a | n/a | n/a | n/a | USGS_LPC_CA_LosAngeles_2016_LAS_2018 |
| Sunrise Cove marina | leafy lake marina, covered slips | 97.3 | 54.7 | 57.1 | 92.5 | 55.6 | 74.2 | 0 | n/a | n/a | n/a | n/a | n/a | GA_Statewide_B3_2018 |
| Pleasant Harbor marina | desert lake marina | 15.1 | 3.7 | 19.7 | 1.6 | 10.6 | 15.1 | 0 | n/a | n/a | n/a | n/a | n/a | AZ_MaricopaPinal_1_2020 |
| Minnesota State Fairgrounds | state fairgrounds | 82.4 | 9.4 | 72.4 | 93.3 | 92.3 | 63.9 | 0 | n/a | n/a | n/a | n/a | n/a | MN_CentralMissRiver_5_B22 |
| Iowa State Fairgrounds | state fairgrounds | 71.5 | 34.9 | 93.6 | 94.3 | 97.6 | 72.7 | 0 | n/a | n/a | n/a | n/a | n/a | IA_NorthCentral_2_2020 |
| Erie County Fairgrounds | county fairgrounds | 86.1 | 14.7 | 94.3 | 96 | 96.6 | 69.3 | 0 | n/a | n/a | n/a | n/a | n/a | NY_3County_2019 |
| Del Mar Fairgrounds | coastal county fairgrounds | 60.3 | 11 | 94.4 | 88.2 | 97.7 | 57.6 | 0 | n/a | n/a | n/a | n/a | n/a | CA_SanDiegoQL2_2014 |
| Silver View RV resort | hillside rv park | 64 | 53.5 | 66.5 | 98.1 | 57.5 | 65.3 | 143 | 14.7 | 64.1 | 0 | 21.2 | 0 | AZ_LowerColoradoRiver_B2_2018 |
| Silver View RV resort, south-west 150 m | hillside rv park, small draw | 7.5 | 21.2 | 74.4 | n/a | n/a | 33 | 42 | 8.3 | 87.5 | 0 | 4.2 | 0 | AZ_LowerColoradoRiver_B2_2018 |

Pleasant Harbor marina: The only lidar (2020) shows an older slip layout than the imagery, so object scores are shown but not counted.

Set mean: **61.39** over 12 sites.

Baseline (Oct 23, 2026, pad fills scored apart): 1.2.26 61.39 over 12 sites; 1.2.25 rescored with the same scorer 61.39 (every site within 0.1 after an Erie rerun). Pad fills differ only on the Silver View south-west 150 m draw: 1.2.25 draws 0, 1.2.26 draws 42 there (87.5% of their area over lidar-empty ground, 8.3% by a lidar object, 4.2% on crowns). The 10 sites before Silver View: 63.84 on both.
