// encode.js — RGBA8 → PNG, with the correct colour tag for the chosen working space.
//
// We assemble the file at the chunk level (png-tools) rather than via its all-in-one encode(),
// because that wants a *synchronous* deflate and we'd rather lean on the browser's native, fast,
// dependency-free zlib (see zlib.js) — which is async.

import {
  ChunkType,
  ColorType,
  FilterMethod,
  Intent,
  encode_IDAT_raw,
  encode_IHDR,
  encode_iCCP,
  encode_sRGB,
  writeChunks,
} from "png-tools";
import { displayP3Profile } from "./icc.js";
import { deflate } from "./zlib.js";

export const COLOR_SPACE = { SRGB: "srgb", P3: "display-p3" };

// Cache the (deterministic, ~600-byte) P3 profile and its compressed form across crops.
let _p3Raw = null;
let _p3Deflated = null;
async function p3ICCPChunk() {
  if (!_p3Raw) _p3Raw = displayP3Profile();
  if (!_p3Deflated) _p3Deflated = await deflate(_p3Raw);
  return {
    type: ChunkType.iCCP,
    data: encode_iCCP({ name: "Display P3", data: _p3Deflated }),
  };
}

/**
 * Encode RGBA8 pixels to a PNG Uint8Array.
 *
 * @param {Uint8Array|Uint8ClampedArray} data  width*height*4 RGBA
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {string} [opts.colorSpace]  COLOR_SPACE.* — used only when no `icc` is supplied
 * @param {Uint8Array} [opts.icc]     raw ICC profile from the source, embedded verbatim (iCCP)
 * @param {string} [opts.iccName]     iCCP keyword for the passed-through profile
 * @param {number} [opts.filter]      png-tools FilterMethod (default Sub — cheap, decent ratio)
 * @returns {Promise<Uint8Array>}
 */
export async function encodePNG(data, width, height, opts = {}) {
  const colorSpace = opts.colorSpace || COLOR_SPACE.SRGB;
  // Sub is a single cheap subtraction per byte — much less work than Paeth. Since the PNG is handed
  // to Figma in-process (not over a network) the slightly larger payload is a fine trade for speed.
  const filter = opts.filter ?? FilterMethod.Sub;
  const image = {
    width,
    height,
    data,
    depth: 8,
    colorType: ColorType.RGBA,
    filter,
  };

  let ancillary;
  if (opts.icc) {
    // Pass the source's exact profile through, so a licensed/precise profile is preserved.
    ancillary = [
      {
        type: ChunkType.iCCP,
        data: encode_iCCP({
          name: opts.iccName || "ICC Profile",
          data: await deflate(opts.icc),
        }),
      },
    ];
  } else if (colorSpace === COLOR_SPACE.P3) {
    ancillary = [await p3ICCPChunk()];
  } else {
    ancillary = [
      { type: ChunkType.sRGB, data: encode_sRGB(Intent.Perceptual) },
    ];
  }

  const compressed = await deflate(encode_IDAT_raw(data, image));
  return writeChunks([
    { type: ChunkType.IHDR, data: encode_IHDR(image) },
    ...ancillary,
    { type: ChunkType.IDAT, data: compressed },
    { type: ChunkType.IEND },
  ]);
}
