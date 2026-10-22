"use strict";

/**
 * Credits and licenses for the data an export can contain. ATTRIBUTION.txt
 * in every zip, the API v1 source list, and /licenses.html read the same
 * wording. OpenClutter's MIT license covers the code only.
 */

const ODBL_NOTICE =
  "Contains information from OpenStreetMap (c) OpenStreetMap contributors, " +
  "Microsoft Global ML Building Footprints, and Overture Maps Foundation, " +
  "available under the Open Database License (ODbL) 1.0. " +
  "The vector data in this file (the attenuation areas in the OpenIntent JSON) " +
  "is made available under the ODbL: https://opendatacommons.org/licenses/odbl/1-0/";

const SOURCES = [
  {
    id: "osm",
    name: "OpenStreetMap",
    role: "building parts, poles, lamps, water, parking, walls, rail, map notes, place search",
    credit: "(c) OpenStreetMap contributors",
    license: "ODbL 1.0",
    url: "https://www.openstreetmap.org/copyright",
  },
  {
    id: "ms-global",
    name: "Microsoft Global ML Building Footprints",
    role: "building footprints and heights",
    credit: "Microsoft Global ML Building Footprints, ODbL",
    license: "ODbL 1.0",
    url: "https://github.com/microsoft/GlobalMLBuildingFootprints",
  },
  {
    id: "overture",
    name: "Overture Maps Foundation buildings",
    role: "building footprints and heights",
    credit:
      "Overture Maps Foundation, buildings theme (ODbL), which includes (c) OpenStreetMap contributors, " +
      "Microsoft (ODbL), Esri Community Maps contributors (CC BY 4.0), and Google Open Buildings (CC BY 4.0); " +
      "see https://docs.overturemaps.org/attribution/",
    license: "ODbL 1.0",
    url: "https://docs.overturemaps.org/attribution/",
  },
  {
    id: "usa-structures",
    name: "FEMA USA Structures",
    role: "US building footprints",
    credit: "Courtesy of FEMA USA Structures (US government work, public domain)",
    license: "Public domain",
    url: "https://gis-fema.hub.arcgis.com/pages/usa-structures",
  },
  {
    id: "meta-chm",
    name: "Meta / WRI Canopy Height Maps v2 (CHMv2)",
    role: "tree canopy outlines and heights",
    credit:
      "Meta and World Resources Institute (WRI) - 2026. Version 2 High Resolution Canopy Height Maps (CHMv2). " +
      "Source imagery for CHM (c) 2016 Vantor. CC BY 4.0 (AWS Open Data Registry listing). " +
      "The CHMv2 paper also names the DINOv3 License (https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md), " +
      "which restricts some end uses; OpenClutter follows the CC BY 4.0 listing while that is unresolved",
    license: "CC BY 4.0",
    url: "https://registry.opendata.aws/dataforgood-fb-forestsv2/",
  },
  {
    id: "esa-worldcover",
    name: "ESA WorldCover 2021",
    role: "tree cover gap fill",
    credit:
      "(c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
    license: "CC BY 4.0",
    url: "https://esa-worldcover.org/en/data-access",
  },
  {
    id: "nlcd-tcc",
    name: "USFS NLCD Tree Canopy Cover",
    role: "US canopy percent",
    credit: "Courtesy of the USDA Forest Service, NLCD Tree Canopy Cover (public domain)",
    license: "Public domain",
    url: "https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/",
  },
  {
    id: "usgs-3dep",
    name: "USGS 3D Elevation Program",
    role: "terrain and lidar heights (US)",
    credit: "Courtesy of the U.S. Geological Survey, 3D Elevation Program (3DEP) (public domain)",
    license: "Public domain",
    url: "https://www.usgs.gov/3d-elevation-program",
  },
  {
    id: "copernicus-glo30",
    name: "Copernicus DEM GLO-30",
    role: "terrain outside the US",
    credit:
      "Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 " +
      "provided under COPERNICUS by the European Union and ESA; all rights reserved",
    license: "Copernicus DEM licence",
    url: "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model",
  },
  {
    id: "nls-laser",
    name: "National Land Survey of Finland laser scanning",
    role: "building heights (one Finnish tile)",
    credit: "Contains data from the National Land Survey of Finland Laser scanning data 2008-2019, CC BY 4.0",
    license: "CC BY 4.0",
    url: "https://www.maanmittauslaitos.fi/en/opendata-licence-cc40",
  },
];

/** Esri credit wherever an Esri map image or tile is shown or shipped. */
const ESRI_POWERED = "Powered by Esri";
const ESRI_SOURCE = "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";

function sourceById(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

module.exports = { ODBL_NOTICE, SOURCES, ESRI_POWERED, ESRI_SOURCE, sourceById };
