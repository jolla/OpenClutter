# Vehicle scoreboard

Recall and precision use the hand-checked pads only. A pad that was not reviewed is not in the score. The label source is on each row. A detector output is not a label. A white roof has to sit on that pad. A roof a few meters away is the next site. A site passes a class at 85% recall and 85% precision. Dense car lots are one 1.5 m layer. Mapped RV pads stay one box each. JSON bytes are the OpenIntent document for those vehicle boxes on this plate, foliage off, against the 4.9 MB budget.

| Site | Class | Recall | Precision | Labels | Predictions | Source | Merged | JSON | Pass |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| Rogers campground | rv | 90.0% | 78.6% | 10 | 14 | manual image labels | no | 37360 / 4900000 | no |
| Mesa RV resorts | rv | 100.0% | 75.0% | 12 | 16 | manual image labels | no | 59772 / 4900000 | no |
| Wentworth marina | boat | 70.8% | 100.0% | 24 | 25 | manual image labels | no | 52767 / 4900000 | no |
| Citrus Gardens | mobile-home | 100.0% | 100.0% | 24 | 36 | manual image labels | no | 132458 / 4900000 | yes |
| Iowa 80 truck stop | semi | 80.0% | 90.5% | 15 | 21 | manual image labels | no | 19783 / 4900000 | no |
| Walmart Davenport lot | car | 100.0% | 98.1% | 1 | 8 | manual image labels | yes | 8246 / 4900000 | yes |
