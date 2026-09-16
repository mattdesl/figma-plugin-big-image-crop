// A Display P3 ICC profile, generated in-memory from first principles — no bytes copied from any
// vendor profile, so it carries no third-party copyright (the embedded cprt dedicates it via
// CC0 1.0). encode.js embeds it as the iCCP chunk on P3 exports so wide-gamut output carries its
// color tag; nothing is read from (or written to) disk.
//
// "Display P3" is fully specified by public constants: DCI-P3 primaries (SMPTE RP 431-2), a D65
// white point, and the sRGB transfer curve (IEC 61966-2-1). An ICC display profile stores that as:
//   - rXYZ/gXYZ/bXYZ: the RGB→XYZ colorant columns, Bradford-adapted from D65 to the D50 PCS
//     illuminant (ICC profiles always connect through D50; 'chad' records the adaptation so a
//     CMM can recover the true D65 white).
//   - wtpt: the PCS illuminant itself (per ICC v4, a display's media white point is D50 when
//     'chad' is present).
//   - rTRC/gTRC/bTRC: one shared parametricCurveType (type 3) holding the sRGB curve constants.
//
// The output is deterministic (fixed header date; everything else is pure arithmetic). To eyeball
// it against ColorSync, from the repo root:
//   node -e "import('./src/ui/icc.js').then(m => process.stdout.write(m.displayP3Profile()))" > /tmp/p3.icc
//   sips --verify /tmp/p3.icc
//
// Plain JS, no host dependencies (runs in the browser too) — the profile ID's MD5 is embedded
// below; it fingerprints the profile per ICC §7.2.18 and has no security role.

// CIE xy chromaticities: DCI-P3 primaries (SMPTE RP 431-2) + D65 white (ITU-R BT.709/sRGB).
const P3_PRIMARIES = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] };
const D65_XY = [0.3127, 0.329];

// The ICC PCS illuminant — D50 exactly as the spec encodes it (0x F6D6 / 1.0000 / 0x D32D in
// s15Fixed16), so wtpt, the header illuminant, and the adaptation target agree byte-for-byte.
const D50_PCS = [0xf6d6 / 65536, 1, 0xd32d / 65536];

// sRGB transfer curve as ICC parametricCurveType function type 3:
//   Y = (a·X + b)^g for X ≥ d, Y = c·X for X < d   (IEC 61966-2-1 constants)
const SRGB_PARA = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const matVec = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const matMul = (a, b) =>
  a.map((_, i) =>
    b[0].map(
      (_, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j],
    ),
  );
const matInv = (m) => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
};

// RGB→XYZ under the native (D65) white: columns are the primaries' XYZ scaled so white maps to
// the white point — the standard primaries-to-matrix derivation.
function rgbToXYZMatrix(primaries, whiteXY) {
  const cols = [
    xyToXYZ(primaries.r),
    xyToXYZ(primaries.g),
    xyToXYZ(primaries.b),
  ];
  const m = [0, 1, 2].map((row) => cols.map((c) => c[row]));
  const s = matVec(matInv(m), xyToXYZ(whiteXY));
  return m.map((row) => row.map((v, j) => v * s[j]));
}

// Bradford chromatic adaptation matrix taking src-white XYZ to dst-white XYZ.
function bradfordAdaptation(srcWhite, dstWhite) {
  const s = matVec(BRADFORD, srcWhite);
  const d = matVec(BRADFORD, dstWhite);
  const scale = [
    [d[0] / s[0], 0, 0],
    [0, d[1] / s[1], 0],
    [0, 0, d[2] / s[2]],
  ];
  return matMul(matInv(BRADFORD), matMul(scale, BRADFORD));
}

// --- ICC byte encoding (big-endian throughout; plain Uint8Array, browser-safe) -----------------

const s15f16 = (v) => {
  const fixed = Math.round(v * 65536);
  if (fixed < -0x80000000 || fixed > 0x7fffffff)
    throw new Error(`s15Fixed16 overflow: ${v}`);
  return fixed >>> 0; // two's complement as u32
};

function be32(...values) {
  const b = new Uint8Array(values.length * 4);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
  return b;
}

function ascii(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function utf16be(s) {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c >> 8;
    b[i * 2 + 1] = c & 0xff;
  }
  return b;
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const xyzTag = (v) => concat(ascii("XYZ "), be32(0, ...v.map(s15f16)));

// One mluc record, en-US. v4's localized-text type (desc and cprt both use it).
const mlucTag = (text) =>
  concat(
    ascii("mluc"),
    be32(0, 1, 12), // reserved, record count, record size
    ascii("enUS"),
    be32(text.length * 2, 28), // byte length, offset from tag start
    utf16be(text),
  );

// parametricCurveType, function type 3 (the piecewise sRGB form): [g, a, b, c, d].
const paraTag = (params) =>
  concat(
    ascii("para"),
    be32(0),
    new Uint8Array([0, 3, 0, 0]), // u16 function type, u16 reserved
    be32(...params.map(s15f16)),
  );

const sf32Tag = (m) => concat(ascii("sf32"), be32(0, ...m.flat().map(s15f16)));

// --- MD5 (RFC 1321), for the ICC profile ID — a content fingerprint, not a security boundary ---

// prettier-ignore
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
].flatMap((q) => [...q, ...q, ...q, ...q]);

export function md5(data) {
  const n = data.length;
  const padded = new Uint8Array((((n + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  // bit length, 64-bit little-endian. The low word uses `n * 8 >>> 0` (not `n << 3`, which truncates
  // to 32-bit signed and corrupts the length for inputs ≥ 256 MB) so the hash stays correct for any
  // byte length, not just the 608-byte profile this module hashes today.
  dv.setUint32(padded.length - 8, (n * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, n / 0x20000000, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0 >>> 0, true);
  ov.setUint32(4, b0 >>> 0, true);
  ov.setUint32(8, c0 >>> 0, true);
  ov.setUint32(12, d0 >>> 0, true);
  return out;
}

// --- The profile ------------------------------------------------------------------------------

/**
 * Build the Display P3 ICC profile (608 bytes, deterministic). Computed on every call — callers
 * that embed it (e.g. the PNG iCCP chunk) should cache the result.
 */
export function displayP3Profile() {
  const toD65 = rgbToXYZMatrix(P3_PRIMARIES, D65_XY);
  const chad = bradfordAdaptation(xyToXYZ(D65_XY), D50_PCS);
  const colorants = matMul(chad, toD65); // columns: r, g, b under the D50 PCS
  const col = (j) => colorants.map((row) => row[j]);

  // The construction must land white exactly on the PCS illuminant: chad·whiteD65 = D50 and the
  // colorant columns sum to it. A failure here means the matrix math above was edited wrong.
  const white = matVec(chad, xyToXYZ(D65_XY));
  for (let i = 0; i < 3; i++) {
    const sum = colorants[i][0] + colorants[i][1] + colorants[i][2];
    if (
      Math.abs(white[i] - D50_PCS[i]) > 1e-9 ||
      Math.abs(sum - D50_PCS[i]) > 1e-9
    )
      throw new Error("iro: Display P3 profile self-check failed");
  }

  // The three TRC entries alias one shared 'para' block (ICC explicitly allows tag sharing).
  // Tag order matters more than the spec says: macOS `sips --verify` re-serializes the profile
  // into ColorSync's canonical layout before checking the MD5, so any other (still spec-valid)
  // arrangement is reported as a bad digest. This is the layout ColorSync's own writer produces:
  // table order desc..gTRC with the chad data placed after the shared TRC block.
  const trc = paraTag(SRGB_PARA);
  const tags = [
    ["desc", mlucTag("Display P3")],
    [
      "cprt",
      mlucTag("Public domain (CC0 1.0). Generated from spec constants by iro."),
    ],
    ["wtpt", xyzTag(D50_PCS)],
    ["rXYZ", xyzTag(col(0))],
    ["gXYZ", xyzTag(col(1))],
    ["bXYZ", xyzTag(col(2))],
    ["rTRC", trc],
    ["chad", sf32Tag(chad)],
    ["bTRC", trc],
    ["gTRC", trc],
  ];

  // Tag table: shared data blocks get one offset; every block here is already 4-byte aligned.
  let offset = 128 + 4 + tags.length * 12;
  const entries = [];
  const blocks = [];
  const placed = new Map();
  for (const [sig, data] of tags) {
    if (!placed.has(data)) {
      placed.set(data, offset);
      blocks.push(data);
      offset += data.length;
    }
    entries.push([sig, placed.get(data), data.length]);
  }

  const header = new Uint8Array(128);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, offset); // profile size
  // CMM (4) left zero: no preferred CMM
  dv.setUint32(8, 0x04000000); // version 4.0.0
  header.set(ascii("mntrRGB XYZ "), 12); // class, color space, PCS
  // Fixed creation date — the profile is a pure function of the constants above; a stable byte
  // stream is what the golden-hash test (and reproducible PNG output) relies on.
  dv.setUint16(24, 2026);
  dv.setUint16(26, 6);
  dv.setUint16(28, 11);
  header.set(ascii("acsp"), 36);
  // platform, flags, manufacturer, model, attributes (40..63) zero; rendering intent (64):
  // perceptual
  header.set(be32(...D50_PCS.map(s15f16)), 68); // PCS illuminant
  // creator (80) zero; bytes 84-99 receive the profile ID below

  const profile = concat(
    header,
    be32(tags.length),
    ...entries.map(([sig, off, size]) => concat(ascii(sig), be32(off, size))),
    ...blocks,
  );

  // Profile ID: MD5 over the profile with flags, rendering intent, and the ID field zeroed
  // (ICC 4.3 §7.2.18). Those fields are already zero here, so hash in place, then store.
  profile.set(md5(profile), 84);
  return profile;
}
