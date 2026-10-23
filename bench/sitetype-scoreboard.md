# Site-type scoreboard

RV parks, campgrounds, marinas, and fairgrounds, exported with the page defaults. Canopy recall is the canopy bench measure. Small and big objects are solid USGS 3DEP lidar cells (class-6 or flat single-return patches at least 1.5 m over ground or water), split at 150 m² connected size. Recall is the share an emitted non-vegetation area covers within 2 m; precision is the share of emitted solid area with a lidar return of at least 1.5 m within 2 m. Lidar predates the imagery, so moved vehicles and boats count against both. Site score is the mean of canopy recall (sites with canopy), small F1, and big F1.

| Site | Kind | Canopy recall | Small recall | Small precision | Big recall | Big precision | Score | Lidar |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Westwind RV resort | desert rv park | 58.9 | 46.7 | 91.8 | 86 | 96.8 | 70.6 | AZ_Southwest_5_D23 |
| Fort Wilderness campground | leafy campground | 86.4 | 17.6 | 96.4 | 93.5 | 92 | 69.6 | FL_Peninsular_FDEM_Orange_2018 |
| Pismo Coast Village RV resort | coastal rv park | 75.7 | 48 | 83.7 | 91.1 | 98.8 | 77.2 | CA_FEMA_Z4_B2_2018 |
| Marina del Rey basins | coastal marina | 74.2 | 37.2 | 36.6 | 86.2 | 97.8 | 67.6 | USGS_LPC_CA_LosAngeles_2016_LAS_2018 |
| Sunrise Cove marina | leafy lake marina, covered slips | 97.8 | 54.8 | 53.5 | 92.1 | 56.1 | 73.9 | GA_Statewide_B3_2018 |
| Pleasant Harbor marina | desert lake marina | 14.8 | 4.3 | 24.4 | 2.8 | 10.5 | 14.8 | AZ_MaricopaPinal_1_2020 |
| Minnesota State Fairgrounds | state fairgrounds | 82.4 | 9.5 | 70.5 | 93.4 | 92.4 | 64 | MN_CentralMissRiver_5_B22 |
| Iowa State Fairgrounds | state fairgrounds | 71.6 | 34.9 | 93.3 | 94.8 | 97.8 | 72.9 | IA_NorthCentral_2_2020 |
| Erie County Fairgrounds | county fairgrounds | 85.8 | 14.7 | 94.3 | 96 | 96.6 | 69.2 | NY_3County_2019 |
| Del Mar Fairgrounds | coastal county fairgrounds | 60.3 | 11 | 94.4 | 88.2 | 97.7 | 57.6 | CA_SanDiegoQL2_2014 |

Pleasant Harbor marina: The only lidar (2020) shows an older slip layout than the imagery, so object scores are shown but not counted.

Set mean: **63.74** over 10 sites.
