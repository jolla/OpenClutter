"use strict";

/**
 * Nominatim queries for one search box. The bilingual Montreal street
 * "Chem. du Bord-du-Lac-Lakeshore" plus a postal code returns nothing.
 * "298 Lakeshore Road, Pointe-Claire" and "298 Chemin du Bord-du-Lac,
 * Pointe-Claire" both hit. Try the typed string, then those splits.
 * The hyphen split stays on the street, so "Pointe-Claire" is left whole.
 */

function tidy(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,(\S)/g, ", $1")
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

function splitBilingualStreet(street) {
  const m = String(street || "").match(
    /^(.*?)\b((?:Chem\.|Chemin|Rue|Avenue|Boulevard|Bd|Boul\.)\s+)(.+)$/i
  );
  if (!m) return null;
  const house = m[1];
  const type = m[2];
  const parts = m[3].trim().split("-");
  if (parts.length < 2) return null;
  const english = parts.pop();
  const frenchName = parts.join("-").trim();
  if (!/^[A-Za-z]{4,}$/.test(english)) return null;
  if (!/\b(du|de|des|la|le|les)\b/i.test(frenchName)) return null;
  return { house, type, frenchName, english };
}

function geocodeQueries(raw) {
  const q = tidy(raw);
  const out = [];
  const add = (s) => {
    const t = tidy(s);
    if (t.length < 3 || out.includes(t)) return;
    out.push(t);
  };
  add(q);
  const noPostal = tidy(
    q.replace(/\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi, " ")
  );
  add(noPostal);
  const bits = noPostal.split(",");
  const split = splitBilingualStreet(bits[0]);
  if (split) {
    const rest = bits
      .slice(1)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
    const tail = rest ? ", " + rest : "";
    const frenchType = split.type.replace(/Chem\./i, "Chemin ");
    add(split.house + split.english + " Road" + tail);
    add(split.house + frenchType + split.frenchName + tail);
  }
  return out.slice(0, 4);
}

module.exports = { geocodeQueries };
