// decode.js — image decoding, split so we never hold the whole image in memory during editing.
//
//   • decodePreview — a downscaled bitmap (capped to PREVIEW_MAX) kept while you set up the crop.
//     The preview window is tiny, so this is plenty crisp yet a fraction of the memory.
//   • decodeFull    — the full-resolution RGBA, read only at crop time and discarded right after.
//
// Both decode with `colorSpaceConversion: "none"` so pixels are never altered (the re-embedded ICC
// still describes them) and `imageOrientation: "from-image"` so EXIF rotation is applied up front.

// Chromium caps canvas dimensions; beyond this a single OffscreenCanvas can't hold the image.
const MAX_CANVAS = 16384;
const PREVIEW_MAX = 2048; // longest preview edge — far more than the plugin window needs

async function decodeBitmap(blob) {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: "from-image",
    colorSpaceConversion: "none",
  });
  if (bitmap.width > MAX_CANVAS || bitmap.height > MAX_CANVAS) {
    bitmap.close?.();
    throw new Error(
      `Image is ${bitmap.width}×${bitmap.height}px; this build supports up to ${MAX_CANVAS}px per side.`,
    );
  }
  return bitmap;
}

/** @returns {Promise<{bitmap:ImageBitmap, width:number, height:number}>} oriented full dimensions. */
export async function decodePreview(blob) {
  const full = await decodeBitmap(blob);
  const width = full.width;
  const height = full.height;
  const longest = Math.max(width, height);
  if (longest <= PREVIEW_MAX) return { bitmap: full, width, height };
  const s = PREVIEW_MAX / longest;
  const bitmap = await createImageBitmap(full, {
    resizeWidth: Math.round(width * s),
    resizeHeight: Math.round(height * s),
    resizeQuality: "high",
  });
  full.close?.();
  return { bitmap, width, height };
}

/** @returns {Promise<{rgba:Uint8Array, width:number, height:number}>} full-resolution pixels. */
export async function decodeFull(blob, colorSpace = "srgb") {
  const bitmap = await decodeBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    colorSpace,
    willReadFrequently: true,
  });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height, { colorSpace });
  bitmap.close?.();
  return { rgba: new Uint8Array(data.buffer), width, height };
}
