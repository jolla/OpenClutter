const { userAgent: UA } = require("../lib/version");

exports.handler = async (event) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const q = (event.queryStringParameters || {}).q || "";
  if (!q || q.length > 200) {
    return { statusCode: 400, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: "q required" }) };
  }
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" +
    encodeURIComponent(q);
  const r = await fetch(url, { headers: { "user-agent": UA } });
  const data = await r.json();
  return {
    statusCode: r.ok ? 200 : 502,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(data),
  };
};