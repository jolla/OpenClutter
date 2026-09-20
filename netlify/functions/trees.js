function tryDecode(buf) {
  try {
    const jpeg = require("jpeg-js");
    return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 20 });
  } catch {
    return null;
  }
}

function isVeg(r, g, b) {
  if (b > 130 && b > g && b > r) return false;
  if (r > 190 && g > 180 && b > 160) return false;
  const olive = r > 50 && r < 175 && g > 48 && g < 155 && b < 115 && g >= r - 20 && g > b + 6;
  const green = g > r + 6 && g > b + 6 && g > 42 && g < 145 && r < 125;
  return olive || green;
}

function treesFromJpeg(imgBuf, imgW, imgH, mpu, bboxCoords, material) {
  const raw = tryDecode(imgBuf);
  if (!raw || !raw.data) return [];
  const w = raw.width, h = raw.height, data = raw.data;
  const step = Math.max(10, Math.round(14 / mpu));
  const half = Math.max(4, Math.round(5.5 / mpu));
  const out = [];
  for (let yTop = step; yTop < h - step && out.length < 160; yTop += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (yTop * w + x) * 4;
      if (!isVeg(data[i], data[i + 1], data[i + 2])) continue;
      let hits = 0, n = 0;
      for (let dy = -3; dy <= 3; dy += 3) {
        for (let dx = -3; dx <= 3; dx += 3) {
          const j = ((yTop + dy) * w + (x + dx)) * 4;
          if (j < 0 || j >= data.length) continue;
          n++;
          if (isVeg(data[j], data[j + 1], data[j + 2])) hits++;
        }
      }
      if (n && hits / n < 0.45) continue;
      const yUp = imgH - yTop;
      const coords = bboxCoords([x - half, x + half], [yUp - half, yUp + half], imgW, imgH);
      if (coords) out.push({ area: { coordinates: coords }, area_material: material });
    }
  }
  return out;
}

module.exports = { treesFromJpeg };
