// produce.js — turn a solved layout into the final RGBA8 pixel block.
//
// The important special case: when the output resolution equals the source region's (scale ≈ 1),
// there is nothing to resample. We snap the region to integer source pixels and copy them verbatim,
// so a 1:1 crop — and the "small image, pass-through" case — keeps every original bit.

import { resample, cropCopy } from "./resample.js";

const EPS = 1e-3;

/**
 * True when the solve can be satisfied by copying source pixels verbatim — the output matches the
 * crop's footprint exactly *and* that footprint lands on whole source pixels. Both halves matter:
 * with a fractional `src.x/y` the sample grid sits between pixels, so even at an identical pixel
 * count every output pixel would be interpolated.
 *
 * Exported because the UI promises "1:1" on the strength of it. A looser test there (say, scale
 * within a fraction of a percent) would claim an untouched crop while this function sends the
 * pixels down the resample path — so both sides must ask the same question.
 *
 * @param {object} sol   result of crop.solve()
 */
export function isPassThrough(sol) {
  if (!sol.place) return false;
  const { src, out } = sol;
  return (
    Math.abs(out.w - src.w) < EPS &&
    Math.abs(out.h - src.h) < EPS &&
    Math.abs(src.x - Math.round(src.x)) < EPS &&
    Math.abs(src.y - Math.round(src.y)) < EPS
  );
}

/**
 * @param {Uint8Array|Uint8ClampedArray} srcRGBA
 * @param {number} srcW,srcH
 * @param {object} sol            result of crop.solve()
 * @param {string} kernel         KERNEL.* (used only when actual resampling is needed)
 * @returns {{data:Uint8ClampedArray, w:number, h:number}|null}
 */
export function produce(srcRGBA, srcW, srcH, sol, kernel) {
  if (!sol.place) return null;
  const { src, out } = sol;

  // Pure-crop fast path: output already matches the source footprint 1:1.
  if (isPassThrough(sol)) {
    const data = cropCopy(
      srcRGBA,
      srcW,
      srcH,
      Math.round(src.x),
      Math.round(src.y),
      out.w,
      out.h,
    );
    return { data, w: out.w, h: out.h };
  }

  const data = new Uint8ClampedArray(out.w * out.h * 4);
  resample(srcRGBA, srcW, srcH, data, out.w, out.h, src, kernel);
  return { data, w: out.w, h: out.h };
}
