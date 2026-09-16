// resample.js — RGBA8 resampling. Three kernels (nearest, bilinear, bicubic) over a generic
// separable engine, plus a zero-cost pure-crop path for the 1:1 case.
//
// Why separable + strips: a single-tap bilinear/bicubic read point-samples, which aliases badly
// when downscaling a 10k image into a 2k frame — the headline use case here. Instead we run a
// horizontal pass then a vertical pass, each with a kernel whose footprint *widens* with the
// downscale factor so it area-averages. To keep memory bounded for huge sources we process the
// output in horizontal bands, materialising only the source rows each band touches.

export const KERNEL = {
  NEAREST: "nearest",
  BILINEAR: "bilinear",
  BICUBIC: "bicubic",
};

// Mitchell–Netravali (B=C=1/3): a well-rounded photographic cubic — sharper than a pure B-spline,
// without the ringing of Catmull-Rom. Support radius 2.
function cubicMitchell(x) {
  x = Math.abs(x);
  const B = 1 / 3;
  const C = 1 / 3;
  if (x < 1) {
    return (
      ((12 - 9 * B - 6 * C) * x * x * x +
        (-18 + 12 * B + 6 * C) * x * x +
        (6 - 2 * B)) /
      6
    );
  } else if (x < 2) {
    return (
      ((-B - 6 * C) * x * x * x +
        (6 * B + 30 * C) * x * x +
        (-12 * B - 48 * C) * x +
        (8 * B + 24 * C)) /
      6
    );
  }
  return 0;
}

const triangle = (x) => {
  x = Math.abs(x);
  return x < 1 ? 1 - x : 0;
};

const KERNELS = {
  [KERNEL.BILINEAR]: { fn: triangle, radius: 1 },
  [KERNEL.BICUBIC]: { fn: cubicMitchell, radius: 2 },
};

// Per-output-pixel contributions along one axis.
// Output pixel i samples the source at  srcStart + (i+0.5)*scale ; converting to a fractional
// pixel-center index c = that − 0.5, the taps are the integer source indices within `radius` of c.
// When downscaling (scale>1) the kernel is stretched by `filterScale` so its support covers the
// whole input footprint (anti-aliasing); when upscaling it stays at unit width (interpolation).
function buildContrib(dstLen, srcLen, srcStart, srcSize, kernel) {
  const scale = srcSize / dstLen;
  const filterScale = Math.max(1, scale);
  const radius = kernel.radius * filterScale;
  const starts = new Int32Array(dstLen);
  const counts = new Int32Array(dstLen);
  const offsets = new Int32Array(dstLen + 1);
  // First pass: measure.
  let total = 0;
  for (let i = 0; i < dstLen; i++) {
    const c = srcStart + (i + 0.5) * scale - 0.5;
    const left = Math.ceil(c - radius);
    const right = Math.floor(c + radius);
    starts[i] = left;
    counts[i] = right - left + 1;
    offsets[i] = total;
    total += counts[i];
  }
  offsets[dstLen] = total;
  // Second pass: fill normalised weights and edge-clamped source indices.
  const weights = new Float32Array(total);
  const indices = new Int32Array(total);
  for (let i = 0; i < dstLen; i++) {
    const c = srcStart + (i + 0.5) * scale - 0.5;
    const left = starts[i];
    const n = counts[i];
    let sum = 0;
    const o = offsets[i];
    for (let k = 0; k < n; k++) {
      const w = kernel.fn((c - (left + k)) / filterScale);
      weights[o + k] = w;
      sum += w;
    }
    const inv = sum !== 0 ? 1 / sum : 0;
    for (let k = 0; k < n; k++) {
      weights[o + k] *= inv;
      indices[o + k] = clampIndex(left + k, srcLen);
    }
  }
  return { weights, indices, offsets, dstLen };
}

const clampIndex = (i, len) => (i < 0 ? 0 : i >= len ? len - 1 : i);

/**
 * Resample a (possibly sub-pixel) region of an RGBA8 source into an RGBA8 destination.
 *
 * @param {Uint8Array|Uint8ClampedArray} src
 * @param {number} srcW,srcH
 * @param {Uint8ClampedArray} dst   length dstW*dstH*4
 * @param {number} dstW,dstH
 * @param {{x:number,y:number,w:number,h:number}} region  source region, px (floats allowed)
 * @param {string} kernelName
 */
export function resample(src, srcW, srcH, dst, dstW, dstH, region, kernelName) {
  if (kernelName === KERNEL.NEAREST) {
    return resampleNearest(src, srcW, srcH, dst, dstW, dstH, region);
  }
  const kernel = KERNELS[kernelName] || KERNELS[KERNEL.BICUBIC];
  const cx = buildContrib(dstW, srcW, region.x, region.w, kernel);
  const cy = buildContrib(dstH, srcH, region.y, region.h, kernel);

  // Process output in horizontal bands to cap the intermediate buffer. For each band we only
  // horizontally-resample the source rows that band's vertical taps reference.
  const BAND = 64;
  let band = new Float32Array(0);
  let bandTop = -1;
  let bandRows = 0;

  for (let by = 0; by < dstH; by += BAND) {
    const byEnd = Math.min(dstH, by + BAND);
    // Source-row span needed by these output rows.
    let rowMin = Infinity;
    let rowMax = -Infinity;
    for (let oy = by; oy < byEnd; oy++) {
      const o = cy.offsets[oy];
      const n = cy.offsets[oy + 1] - o;
      if (cy.indices[o] < rowMin) rowMin = cy.indices[o];
      if (cy.indices[o + n - 1] > rowMax) rowMax = cy.indices[o + n - 1];
    }
    const rows = rowMax - rowMin + 1;
    if (rows > bandRows) {
      band = new Float32Array(rows * dstW * 4);
      bandRows = rows;
    }
    bandTop = rowMin;

    // Horizontal pass: source rows [rowMin..rowMax] → band (dstW wide).
    for (let r = 0; r < rows; r++) {
      const srcRow = (rowMin + r) * srcW * 4;
      const dstRow = r * dstW * 4;
      for (let ox = 0; ox < dstW; ox++) {
        const o = cx.offsets[ox];
        const n = cx.offsets[ox + 1] - o;
        let a0 = 0,
          a1 = 0,
          a2 = 0,
          a3 = 0;
        for (let k = 0; k < n; k++) {
          const w = cx.weights[o + k];
          const si = srcRow + cx.indices[o + k] * 4;
          a0 += w * src[si];
          a1 += w * src[si + 1];
          a2 += w * src[si + 2];
          a3 += w * src[si + 3];
        }
        const di = dstRow + ox * 4;
        band[di] = a0;
        band[di + 1] = a1;
        band[di + 2] = a2;
        band[di + 3] = a3;
      }
    }

    // Vertical pass: band → dst output rows [by..byEnd).
    for (let oy = by; oy < byEnd; oy++) {
      const o = cy.offsets[oy];
      const n = cy.offsets[oy + 1] - o;
      const dstRow = oy * dstW * 4;
      for (let ox = 0; ox < dstW; ox++) {
        let a0 = 0,
          a1 = 0,
          a2 = 0,
          a3 = 0;
        const col = ox * 4;
        for (let k = 0; k < n; k++) {
          const w = cy.weights[o + k];
          const bi = (cy.indices[o + k] - bandTop) * dstW * 4 + col;
          a0 += w * band[bi];
          a1 += w * band[bi + 1];
          a2 += w * band[bi + 2];
          a3 += w * band[bi + 3];
        }
        const di = dstRow + col;
        dst[di] = a0;
        dst[di + 1] = a1;
        dst[di + 2] = a2;
        dst[di + 3] = a3;
      }
    }
  }
  return dst;
}

// Point-sampling nearest, single pass, with a u32 fast path (one 32-bit copy per pixel).
function resampleNearest(src, srcW, srcH, dst, dstW, dstH, region) {
  const s32 = new Uint32Array(
    src.buffer,
    src.byteOffset,
    (src.byteLength / 4) | 0,
  );
  const d32 = new Uint32Array(
    dst.buffer,
    dst.byteOffset,
    (dst.byteLength / 4) | 0,
  );
  const sx = region.w / dstW;
  const sy = region.h / dstH;
  for (let oy = 0; oy < dstH; oy++) {
    const syi = clampIndex(Math.floor(region.y + (oy + 0.5) * sy), srcH);
    const srcRow = syi * srcW;
    const dstRow = oy * dstW;
    for (let ox = 0; ox < dstW; ox++) {
      const sxi = clampIndex(Math.floor(region.x + (ox + 0.5) * sx), srcW);
      d32[dstRow + ox] = s32[srcRow + sxi];
    }
  }
  return dst;
}

/**
 * Pure crop — copy an integer-aligned, same-resolution rectangle. No resampling, no precision loss;
 * a small image dropped into a large frame round-trips its bytes exactly. Uses 32-bit row copies.
 */
export function cropCopy(src, srcW, srcH, x, y, w, h) {
  x = Math.max(0, Math.min(x, srcW - w));
  y = Math.max(0, Math.min(y, srcH - h));
  const out = new Uint8ClampedArray(w * h * 4);
  const s32 = new Uint32Array(
    src.buffer,
    src.byteOffset,
    (src.byteLength / 4) | 0,
  );
  const d32 = new Uint32Array(out.buffer);
  for (let row = 0; row < h; row++) {
    const sStart = (y + row) * srcW + x;
    d32.set(s32.subarray(sStart, sStart + w), row * w);
  }
  return out;
}
