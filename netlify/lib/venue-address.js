"use strict";

/**
 * Nominatim has no point for many venue names. A public search snippet often
 * still prints the street address ("Casa Evexía, 298 Lakeshore, Pointe-Claire, QC").
 * That address is geocoded with the existing Nominatim path. A snippet that
 * does not name the venue next to a street is ignored.
 */

function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function plainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 65536 ? String.fromCharCode(c) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A house number plus a street type is already an address, not a venue name. */
function looksLikeVenueName(raw) {
  const q = String(raw || "").replace(/\s+/g, " ").trim();
  if (q.length < 3 || q.length > 80) return false;
  if (/^\d/.test(q)) return false;
  if (/\b(?:chem\.|chemin|rue|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd|boul\.)\b/i.test(q)) {
    return false;
  }
  if (/\b\d{1,6}\s+\S+/.test(q)) return false;
  return true;
}

function queryTokens(q) {
  return fold(q)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

/**
 * Street address printed next to the venue name. Null when the page does not
 * tie this name to a numbered street.
 */
function addressFromVenueText(query, html) {
  const text = plainText(html);
  const folded = fold(text);
  const tokens = queryTokens(query);
  if (!tokens.length || !text) return null;
  const re =
    /\b(\d{1,6})\s+([A-Za-zÀ-ÿ0-9][^,]{1,60}?),\s*([A-Za-zÀ-ÿ][^,]{1,40}?),\s*([A-Z]{2})\b/g;
  let best = null;
  let bestScore = 0;
  let match;
  while ((match = re.exec(text))) {
    const address = (match[1] + " " + match[2].trim() + ", " + match[3].trim() + ", " + match[4]).replace(
      /\s+/g,
      " "
    );
    const at = folded.indexOf(fold(address));
    const window = at >= 0 ? folded.slice(Math.max(0, at - 180), at + fold(address).length) : "";
    let score = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (window.includes(tokens[i])) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = address;
    }
  }
  return bestScore > 0 ? best : null;
}

module.exports = { looksLikeVenueName, addressFromVenueText, plainText };
