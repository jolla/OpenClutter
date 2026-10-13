"use strict";

// package.json is the only version number. The page stamp and API user-agent both read it.
const { version } = require("../../package.json");

const userAgent = `openclutter/${version} (https://github.com/jolla/OpenClutter)`;

module.exports = { version, userAgent };
