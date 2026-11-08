// Image helpers: quantization + indexed PNG encoder (works in browser and Node 18+).
// Used as a fallback when WebP encoding is unavailable (iOS Safari) or the file is > 512 KB.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function zlibDeflate(bytes) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Median-cut quantizer. rgba: Uint8ClampedArray. Returns { palette: [[r,g,b,a]...], lookup(r,g,b,a) }
export function buildPalette(rgba, maxColors = 256) {
  // Collect pixels, treating (nearly) transparent as one special entry.
  const px = [];
  let hasTransparent = false;
  const step = Math.max(1, Math.floor(rgba.length / 4 / 60000)); // sample up to ~60k pixels
  for (let i = 0; i < rgba.length; i += 4 * step) {
    const a = rgba[i + 3];
    if (a < 8) { hasTransparent = true; continue; }
    px.push([rgba[i], rgba[i + 1], rgba[i + 2], a]);
  }
  const limit = hasTransparent ? maxColors - 1 : maxColors;
  let boxes = [px.length ? px : [[0, 0, 0, 255]]];

  while (boxes.length < limit) {
    // pick the box with the largest channel range * population
    let bi = -1, best = -1, bch = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      for (let ch = 0; ch < 4; ch++) {
        let mn = 255, mx = 0;
        for (let j = 0; j < b.length; j++) { const v = b[j][ch]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const score = (mx - mn) * Math.sqrt(b.length);
        if (score > best) { best = score; bi = i; bch = ch; }
      }
    }
    if (bi < 0 || best <= 0) break;
    const b = boxes[bi];
    b.sort((p, q) => p[bch] - q[bch]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }

  const palette = [];
  if (hasTransparent) palette.push([0, 0, 0, 0]);
  for (const b of boxes) {
    let r = 0, g = 0, bl = 0, a = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; a += p[3]; }
    const n = b.length || 1;
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(bl / n), Math.round(a / n)]);
  }
  return { palette, hasTransparent };
}

// Map every pixel to nearest palette entry with Floyd–Steinberg dithering.
export function applyPalette(rgba, w, h, palette, hasTransparent) {
  const cache = new Map();
  const start = hasTransparent ? 1 : 0;
  const nearest = (r, g, b, a) => {
    const key = ((r >> 2) << 18) | ((g >> 2) << 12) | ((b >> 2) << 6) | (a >> 2);
    const c = cache.get(key);
    if (c !== undefined) return c;
    let bi = start, bd = Infinity;
    for (let i = start; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2], da = a - p[3];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bd) { bd = d; bi = i; }
    }
    cache.set(key, bi);
    return bi;
  };

  const idx = new Uint8Array(w * h);
  // error buffers (float) for current and next row, 4 channels
  let cur = new Float32Array((w + 2) * 4), nxt = new Float32Array((w + 2) * 4);
  for (let y = 0; y < h; y++) {
    nxt.fill(0);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] < 8 && hasTransparent) { idx[y * w + x] = 0; continue; }
      const e = (x + 1) * 4;
      const r = Math.max(0, Math.min(255, rgba[o] + cur[e]));
      const g = Math.max(0, Math.min(255, rgba[o + 1] + cur[e + 1]));
      const b = Math.max(0, Math.min(255, rgba[o + 2] + cur[e + 2]));
      const a = Math.max(0, Math.min(255, rgba[o + 3] + cur[e + 3]));
      const pi = nearest(r | 0, g | 0, b | 0, a | 0);
      idx[y * w + x] = pi;
      const p = palette[pi];
      const er = r - p[0], eg = g - p[1], eb = b - p[2], ea = a - p[3];
      const add = (arr, pos, f) => { arr[pos] += er * f; arr[pos + 1] += eg * f; arr[pos + 2] += eb * f; arr[pos + 3] += ea * f; };
      add(cur, e + 4, 7 / 16);
      add(nxt, e - 4, 3 / 16);
      add(nxt, e, 5 / 16);
      add(nxt, e + 4, 1 / 16);
    }
    [cur, nxt] = [nxt, cur];
  }
  return idx;
}

export async function encodeIndexedPNG(w, h, idx, palette) {
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = new Uint8Array(palette.length * 3);
  const trns = new Uint8Array(palette.length);
  palette.forEach((p, i) => { plte[i * 3] = p[0]; plte[i * 3 + 1] = p[1]; plte[i * 3 + 2] = p[2]; trns[i] = p[3]; });

  // scanlines with filter type 0 (None) — simple and robust; deflate does the rest
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(idx.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const idat = await zlibDeflate(raw);
  const parts = [sig, chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("tRNS", trns), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export async function quantizedPng(rgba, w, h) {
  const { palette, hasTransparent } = buildPalette(rgba, 256);
  const idx = applyPalette(rgba, w, h, palette, hasTransparent);
  return encodeIndexedPNG(w, h, idx, palette);
}
