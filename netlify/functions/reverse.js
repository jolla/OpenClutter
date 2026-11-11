"use strict";

const { userAgent: UA } = require("../lib/version");
const { parseBbox, labelForBox } = require("../lib/reverse-geocode");

exports.handler = async (event) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const json = (body, status) => ({
    statusCode: status || 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const box = parseBbox(event.queryStringParameters || {});
  if (!box) return json({ label: "" }, 400);
  try {
    const named = await labelForBox(box, { userAgent: UA });
    return json({ label: named.label || "", feature: named.feature, place: named.place });
  } catch {
    return json({ label: "" });
  }
};
