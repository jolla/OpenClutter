"use strict";

/**
 * GET /api/feedback-image?id=<32 hex>. Serves a screenshot attached to a
 * PUBLIC feedback issue. Private reports never use this store. The id is
 * 128 random bits, the bytes are checked to be JPEG or WebP again before
 * they are sent, and the response cannot run as a page.
 */

const fb = require("../lib/feedback");

let storeOverride = null;
function setStoreForTests(s) {
  storeOverride = s;
}

function store() {
  if (storeOverride) return storeOverride;
  try {
    return require("@netlify/blobs").getStore({ name: fb.PUBLIC_IMAGE_STORE });
  } catch {
    return null;
  }
}

function notFound() {
  return { statusCode: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" }, body: "Not found" };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return { statusCode: 405, headers: { "content-type": "text/plain" }, body: "GET only" };
  }
  if (event.blobs) {
    try {
      const headers = {};
      for (const k of Object.keys(event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
      require("@netlify/blobs").connectLambda({ blobs: event.blobs, headers });
    } catch {
      /* Falls through to 404. */
    }
  }
  const id = (event.queryStringParameters || {}).id;
  if (!fb.validImageId(id)) return notFound();
  const s = store();
  if (!s) return notFound();
  let data;
  try {
    data = await s.get("img/" + id, { type: "arrayBuffer" });
  } catch {
    return notFound();
  }
  if (!data) return notFound();
  const buf = Buffer.from(data);
  const type = fb.sniffImage(buf);
  if (!type || buf.length > fb.IMAGE_MAX_BYTES) return notFound();
  return {
    statusCode: 200,
    headers: {
      "content-type": type,
      "content-length": String(buf.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": "inline",
      "x-robots-tag": "noindex",
    },
    isBase64Encoded: true,
    body: event.httpMethod === "HEAD" ? "" : buf.toString("base64"),
  };
};

exports.setStoreForTests = setStoreForTests;
