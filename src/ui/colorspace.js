// colorspace.js — sniff a dropped image's working colour space and embedded ICC profile straight
// from its container bytes (no full decode). This lets us:
//   • decode into the matching canvas colour space, and
//   • re-embed the *original* profile byte-for-byte on export — so an exact/licensed profile (e.g.
//     Apple's "Display P3") is preserved rather than swapped for a generated one.
// Combined with a `colorSpaceConversion: "none"` decode (which never alters the pixels), the
// pass-through is colour-exact for any profile, not just the two the canvas can natively hold.

import { readChunks, ChunkType, decode_iCCP } from "png-tools";
import { inflate } from "./zlib.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes, sig, off = 0) =>
  sig.every((b, i) => bytes[off + i] === b);

// Tell a wide-gamut (Display P3) matrix profile from sRGB by its red colorant's X in the D50 PCS:
// sRGB ≈ 0.436, Display P3 ≈ 0.515. Only used to pick the canvas colour space / label — the actual
// fidelity comes from passing the profile through, so this never needs to be exhaustive.
function iccLooksP3(icc) {
  try {
    if (!icc || icc.length < 132) return false;
    const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    if (dv.getUint32(36) !== 0x61637370) return false; // 'acsp'
    const count = dv.getUint32(128);
    for (let i = 0, off = 132; i < count; i++, off += 12) {
      if (dv.getUint32(off) === 0x7258595a) {
        // 'rXYZ' → 'XYZ ' type (4) + reserved (4) + X as s15Fixed16
        const tagOff = dv.getUint32(off + 4);
        return dv.getInt32(tagOff + 8) / 65536 > 0.48;
      }
    }
  } catch {
    /* malformed profile → treat as not-P3 */
  }
  return false;
}

// JPEG: ICC lives in one or more APP2 segments each prefixed with "ICC_PROFILE\0" + seq + count.
function extractJPEGICC(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const ID = "ICC_PROFILE\0";
  const segs = [];
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    } // padding
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    } // RST (no length)
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe2) {
      const start = i + 4;
      let match = true;
      for (let k = 0; k < ID.length; k++)
        if (bytes[start + k] !== ID.charCodeAt(k)) {
          match = false;
          break;
        }
      if (match)
        segs.push({
          seq: bytes[start + 12],
          data: bytes.subarray(start + 14, i + 2 + len),
        });
    }
    i += 2 + len;
  }
  if (!segs.length) return null;
  segs.sort((a, b) => a.seq - b.seq);
  const out = new Uint8Array(segs.reduce((n, s) => n + s.data.length, 0));
  let o = 0;
  for (const s of segs) {
    out.set(s.data, o);
    o += s.data.length;
  }
  return out;
}

// WebP (RIFF): an "ICCP" chunk carries the raw profile.
function extractWebPICC(bytes) {
  if (
    !startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) ||
    !startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 12; i + 8 <= bytes.length; ) {
    const fourcc = String.fromCharCode(
      bytes[i],
      bytes[i + 1],
      bytes[i + 2],
      bytes[i + 3],
    );
    const size = dv.getUint32(i + 4, true);
    if (fourcc === "ICCP") return bytes.slice(i + 8, i + 8 + size);
    i += 8 + size + (size & 1);
  }
  return null;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer  the dropped file's bytes
 * @returns {Promise<{ space: "srgb"|"display-p3", icc: Uint8Array|null, label: string }>}
 */
export async function detectColorSpace(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let icc = null;

  if (startsWith(bytes, PNG_SIG)) {
    const iccp = readChunks(bytes, { copy: false }).find(
      (c) => c.type === ChunkType.iCCP,
    );
    if (iccp) {
      try {
        icc = await inflate(decode_iCCP(iccp.data).data);
      } catch {
        icc = null;
      }
    }
  } else {
    icc = extractJPEGICC(bytes) || extractWebPICC(bytes);
  }

  const space = iccLooksP3(icc) ? "display-p3" : "srgb";
  return { space, icc, label: space === "display-p3" ? "Display P3" : "sRGB" };
}
