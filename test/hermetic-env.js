"use strict";

/**
 * node --test must not inherit leftover cache paths from a hostexp or
 * official bench on this machine. OPENCLUTTER_*_CACHE_DIR would otherwise
 * bypass NODE_TEST_CONTEXT (before 1.3.79) or feed Overpass a prior site's
 * extract. Tests that need a cache set a temp dir in their own before()
 * hook, or call setDir() / setMsCacheDir() / setUsaCacheDir() /
 * setLidarCacheDir().
 */
const CACHE_ENV = [
  "OPENCLUTTER_MS_CACHE_DIR",
  "OPENCLUTTER_USA_CACHE_DIR",
  "OPENCLUTTER_OVERTURE_CACHE_DIR",
  "OPENCLUTTER_OVERPASS_CACHE_DIR",
  "OPENCLUTTER_OVERPASS_ENDPOINTS",
  "OPENCLUTTER_LIDAR_CACHE_DIR",
  "OPENCLUTTER_CHM_CACHE_DIR",
  "OPENCLUTTER_DEM_CACHE_DIR",
  "OPENCLUTTER_FOREST_CACHE_DIR",
  "OPENCLUTTER_GAP_CACHE_DIR",
];

for (const name of CACHE_ENV) {
  if (process.env[name] != null) delete process.env[name];
}

module.exports = { CACHE_ENV };
