# Vehicle scoreboard

Recall and precision use the hand-checked pads only. A pad that was not reviewed is not in the score. The label source is on each row. A detector output is not a label. A site passes a class at 85% recall and 85% precision. Dense car lots are one 1.5 m layer. Rogers has mapped pads, so each kept vehicle is its own box. JSON bytes are the OpenIntent document for those vehicle boxes on this plate, foliage off, against the 4.9 MB budget.

| Site | Class | Recall | Precision | Labels | Predictions | Source | Merged | JSON | Pass |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| Rogers campground | rv | 90.0% | 51.5% | 10 | 33 | manual image labels | no | 75307 / 4900000 | no |
| Mesa RV resorts | rv | 91.7% | 78.6% | 12 | 14 | manual image labels | no | 54035 / 4900000 | no |
