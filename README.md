# OpenIntent Clutter

Turn a map box into an [OpenIntent](https://github.com/google/openintent) zip for [Hamina Planner](https://hamina.com): a georeferenced aerial plus buildings and trees as attenuating objects, so you do not have to trace clutter by hand.

Live: https://openintent-clutter.netlify.app · Source: https://github.com/jolla/openintent-clutter

## Use

1. Open the deployed site.
2. Search an address.
3. Draw a rectangle over the site (keep it under ~2 km on a side).
4. Download the zip → Hamina **Projects → Import → OpenIntent**.

Scale comes from the bounding box. Buildings are [Microsoft US Building Footprints](https://github.com/microsoft/USBuildingFootprints) via Esri. The map image is Esri World Imagery. Trees are sampled from green pixels on that aerial.

## Limits

US footprints only. Boxes over ~2.5 km fail. Large campus polygons are dropped. Tree and height accuracy is heuristic, not survey-grade.

## Local

```bash
npx netlify dev
```

## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL).
