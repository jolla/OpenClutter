# OpenIntent Clutter

Public tool: type an address, draw the site, download an [OpenIntent](https://github.com/google/openintent) `.zip` with building clutter for [Hamina Planner](https://hamina.com).

https://github.com/jolla/openintent-clutter

## Use

1. Open the deployed site (Netlify).
2. Search an address.
3. Draw a rectangle over the site (keep it under ~2 km).
4. Download the zip → Hamina **Projects → Import → OpenIntent**.

Scale comes from the bounding box, not Hamina auto-scale. Buildings are [Microsoft US Building Footprints](https://github.com/microsoft/USBuildingFootprints) via Esri. The map image is Esri World Imagery.

v1 is **US buildings + map + correct meters**. Trees / heights are next.

## Local

```bash
npx netlify dev
```

## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL).
