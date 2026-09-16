// crop.js — pure geometry for the crop selection.
//
// Model: the image is the fixed reference and the crop is a rectangle in **source-pixel space**
// (`{x,y,w,h}`, locked to the frame's aspect). Whatever the crop rectangle encloses is mapped onto
// the frame. Shrinking the crop = zooming in (a smaller region fills the frame); growing it = zoom
// out. This is what the draggable, aspect-locked dashed rectangle in the UI manipulates directly.
//
// Coordinate systems:
//   • "source px"   — pixels of the decoded image; the crop rectangle lives here.
//   • "frame units" — the frame's own pixel space (1 unit === 1 Figma px); the placement lives here.
//   • "output px"   — pixels of the final PNG.

export const FIT = {
  COVER: "cover",
  CONTAIN: "contain",
  NONE: "none",
  CUSTOM: "custom",
};

// Alignment fractions: 0 = left/top, 0.5 = center, 1 = right/bottom.
export const ALIGN = { START: 0, CENTER: 0.5, END: 1 };

// Figma resamples imported images whose longest side exceeds this — the very artifacts this plugin
// exists to avoid — so we never emit anything larger.
export const MAX_DIM = 4096;

// How close to the crop's own pixel count counts as "the same size". Within this band, solve() emits
// the crop's exact pixels instead of the literal requested ratio: the size difference is invisible,
// while the alternative is resampling every pixel to shave a handful — all of the cost, none of the
// benefit. The UI reads the same constant to decide when to call a result 1:1, so the label and the
// geometry can't drift apart.
export const PIXEL_EXACT_TOL = 0.005;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The crop size for a given fit, in source px, at the frame's aspect ratio.
//   • cover   — largest frame-aspect rectangle that fits *inside* the image (trims to fill).
//   • contain — smallest frame-aspect rectangle that *contains* the whole image (letterbox).
//   • none    — exactly the frame's pixel dimensions (1 source px → 1 output px at 1×).
function fitSize(fit, frameW, frameH, srcW, srcH) {
  // An image that fits entirely within the frame isn't really being cropped — there's nothing to
  // trim — so every fit just spans the whole slide and places the image inside it.
  if (srcW <= frameW && srcH <= frameH) return { w: frameW, h: frameH };
  const aspect = frameW / frameH;
  if (fit === FIT.NONE) return { w: frameW, h: frameH };
  const imgWider = srcW / srcH >= aspect;
  if (fit === FIT.CONTAIN) {
    return imgWider
      ? { w: srcW, h: srcW / aspect }
      : { w: srcH * aspect, h: srcH };
  }
  // cover (default)
  return imgWider
    ? { w: srcH * aspect, h: srcH }
    : { w: srcW, h: srcW / aspect };
}

/**
 * Settle a crop rectangle onto whole source pixels, holding its centre.
 *
 * Whole-pixel bounds are the precondition for a verbatim copy (see produce.isPassThrough): a
 * rectangle offset by even a fraction of a pixel has its sample grid falling *between* source
 * pixels, so every output pixel has to be interpolated even when the pixel count is unchanged. Since
 * any pan or resize lands on fractional coordinates, an unsnapped crop is almost never exact —
 * snapping is what makes the untouched-pixel path reachable in normal use rather than only on the
 * fit presets.
 *
 * The rounded size can't hold the frame aspect *exactly*: that would need w to be a multiple of the
 * reduced aspect's denominator — 16px steps for a 16:9 frame, and impossibly coarse for an arbitrary
 * frame size (a 1000×667 frame would step by 1000). So it lands within half a pixel of the aspect,
 * and solve() absorbs that residual in the placement rather than letting it open a hairline gap at
 * the frame edge.
 */
export function snapCrop(crop, aspect) {
  const w = Math.max(1, Math.round(crop.w));
  const h = Math.max(1, Math.round(w / aspect));
  return {
    x: Math.round(crop.x + (crop.w - w) / 2),
    y: Math.round(crop.y + (crop.h - h) / 2),
    w,
    h,
  };
}

// Build a fresh crop rectangle for a fit + alignment.
export function initCrop(fit, frameW, frameH, srcW, srcH, alignX, alignY) {
  const { w, h } = fitSize(fit, frameW, frameH, srcW, srcH);
  return reposition({ x: 0, y: 0, w, h }, srcW, srcH, alignX, alignY);
}

// Move a crop rectangle (keeping its size) to an alignment within the image. Pass `null` for an
// axis to leave the crop where it is on that axis.
export function reposition(crop, srcW, srcH, alignX, alignY) {
  return {
    x: alignX == null ? crop.x : (srcW - crop.w) * alignX,
    y: alignY == null ? crop.y : (srcH - crop.h) * alignY,
    w: crop.w,
    h: crop.h,
  };
}

// Constrain a crop during a pan so it can't be lost entirely: it may extend well past the image
// (useful for 1:1 / letterbox framing), but must keep at least `OVERLAP` px over the image on each
// axis so it's always recoverable.
const OVERLAP = 40;
export function clampCropPos(crop, srcW, srcH) {
  const ovx = Math.min(OVERLAP, crop.w / 2, srcW / 2);
  const ovy = Math.min(OVERLAP, crop.h / 2, srcH / 2);
  return {
    x: clamp(crop.x, ovx - crop.w, srcW - ovx),
    y: clamp(crop.y, ovy - crop.h, srcH - ovy),
    w: crop.w,
    h: crop.h,
  };
}

const MIN_CROP = 8; // source px on the short side — keeps resizing from collapsing the rectangle

/**
 * Aspect-locked resize. The crop is free to extend past the image (letterbox / 1:1).
 *
 * @param {{x,y,w,h}} base   crop at the gesture's current reference point
 * @param {string} handle    n,s,e,w,ne,nw,se,sw
 * @param {number} dx,dy     pointer movement since the reference, in source px
 * @param {number} aspect    frame aspect (locked)
 * @param {boolean} alt      resize symmetrically about the crop's centre
 *
 * Without alt the opposite edge/corner is anchored and the perpendicular axis grows about its
 * centre. With alt the centre is fixed and both sides move together.
 */
export function resizeCrop(base, handle, dx, dy, aspect, alt) {
  const bl = base.x,
    bt = base.y,
    br = base.x + base.w,
    bb = base.y + base.h;
  const cxMid = base.x + base.w / 2;
  const cyMid = base.y + base.h / 2;
  const minW = Math.max(MIN_CROP, MIN_CROP * aspect);

  const hasE = handle.includes("e");
  const hasW = handle.includes("w");
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");

  // Single-side growth of the dragged handle, expressed as a width delta.
  const sx = hasE ? dx : hasW ? -dx : null;
  const sy = hasS ? dy * aspect : hasN ? -dy * aspect : null;
  let dw;
  if (sx != null && sy != null) {
    // Corner: project the pointer movement onto the aspect diagonal so the size grows smoothly.
    // (Picking the dominant axis caused a jump whenever the larger axis flipped.)
    dw = (sx * aspect ** 2 + sy) / (aspect ** 2 + 1);
  } else dw = sx != null ? sx : sy;

  // alt grows both sides → twice the single-side delta.
  const w = Math.max(minW, base.w + (alt ? 2 * dw : dw));
  const h = w / aspect;

  let x, y;
  if (alt) {
    x = cxMid - w / 2;
    y = cyMid - h / 2;
  } else {
    x = hasE ? bl : hasW ? br - w : cxMid - w / 2;
    y = hasS ? bt : hasN ? bb - h : cyMid - h / 2;
  }
  return { x, y, w, h };
}

/**
 * Solve placement + output sizing from a crop rectangle.
 *
 * @param {object} p
 * @param {{x,y,w,h}} p.crop          crop rectangle in source px (aspect == frame aspect)
 * @param {number} p.frameW,p.frameH  frame size (frame units)
 * @param {number} p.srcW,p.srcH      source image size (px)
 * @param {number|"max"} p.ratio      supersample factor, or "max" for native source resolution
 * @param {number} p.alignX,p.alignY  alignment for the no-upscale fallback
 * @param {boolean} p.noUpscale       true (default) = never enlarge past native resolution
 * @param {number} [p.maxDim]
 * @returns {{
 *   crop, src:{x,y,w,h}, place:({x,y,w,h}|null), out:{w,h}, scale:number, upscaleClamped:boolean
 * }}
 */
export function solve(p) {
  const maxDim = p.maxDim ?? MAX_DIM;
  const isMax = p.ratio === "max";
  const noUpscale = p.noUpscale !== false; // default on
  const crop = p.crop;
  // frame units per source px if the crop filled the frame.
  const dRaw = p.frameW / crop.w;

  // Visible content = crop ∩ image bounds (source px). Areas of the crop outside the image are
  // empty (a letterbox), so the actual pixels we emit cover only the intersection.
  const vx0 = Math.max(crop.x, 0);
  const vy0 = Math.max(crop.y, 0);
  const vx1 = Math.min(crop.x + crop.w, p.srcW);
  const vy1 = Math.min(crop.y + crop.h, p.srcH);
  const cw = vx1 - vx0;
  const ch = vy1 - vy0;
  if (cw <= 0 || ch <= 0) {
    return {
      crop,
      src: { x: 0, y: 0, w: 0, h: 0 },
      place: null,
      out: { w: 0, h: 0 },
      scale: 0,
      upscaleClamped: false,
    };
  }
  const src = { x: vx0, y: vy0, w: cw, h: ch };
  // Nothing was trimmed by the image edges, so the crop maps onto the frame in its entirety.
  const wholeCropVisible =
    Math.abs(cw - crop.w) < 1e-6 && Math.abs(ch - crop.h) < 1e-6;

  let place;
  let upscaleClamped = false;
  if (dRaw <= 1 || !noUpscale) {
    // The crop maps straight onto the frame; content lands at its mapped sub-rectangle (the full
    // frame when the crop is wholly inside the image). With no-upscale off this also covers the
    // enlarge case — the frame is filled even though the source has fewer pixels.
    //
    // When the whole crop is visible that sub-rectangle *is* the frame, so state it exactly rather
    // than deriving it through dRaw. Algebraically identical for a crop at the exact frame aspect —
    // but a snapped crop sits within half a pixel of that aspect, and routing it through dRaw would
    // turn the residual into a sub-pixel gap along one frame edge. Absorbing it here instead spends
    // it as a ~0.04% aspect difference, which the fill's centre-crop swallows invisibly.
    place = wholeCropVisible
      ? { x: 0, y: 0, w: p.frameW, h: p.frameH }
      : {
          x: (vx0 - crop.x) * dRaw,
          y: (vy0 - crop.y) * dRaw,
          w: cw * dRaw,
          h: ch * dRaw,
        };
  } else {
    // Filling the frame would mean enlarging the source — the loss of fidelity we avoid. Fall back
    // to placing the selected pixels at their native 1:1 size, aligned within the frame.
    upscaleClamped = true;
    place = {
      w: cw,
      h: ch,
      x: (p.frameW - cw) * p.alignX,
      y: (p.frameH - ch) * p.alignY,
    };
  }

  // Output resolution. MAX targets the crop's native pixel count; a numeric ratio targets the
  // placement at `ratio` DPI. Either way it's capped at Figma's resize ceiling (longest edge) and —
  // unless upscaling is explicitly allowed — at the source pixels available. One uniform factor
  // keeps the aspect.
  const idealW = isMax ? src.w : place.w * p.ratio;
  const idealH = isMax ? src.h : place.h * p.ratio;
  const kMax = Math.min(maxDim / idealW, maxDim / idealH);
  const kSource = noUpscale
    ? Math.min(src.w / idealW, src.h / idealH)
    : Infinity;
  const k = Math.min(1, kMax, kSource);
  const wantW = idealW * k;
  const wantH = idealH * k;
  let out = {
    w: Math.max(1, Math.round(wantW)),
    h: Math.max(1, Math.round(wantH)),
  };
  // Land exactly on the crop's own pixel count when the request is already within PIXEL_EXACT_TOL of
  // it. Both axes must agree, so this can never fire on a genuine downscale, and since the result
  // *is* the source footprint it can never upscale either — the trade is a sub-percent deviation
  // from the requested ratio in exchange for pixels that are copied rather than interpolated.
  // Skipped when the source itself is over the ceiling, which stays a hard cap.
  const tol = (n) => Math.max(1, n * PIXEL_EXACT_TOL);
  if (
    Math.abs(wantW - src.w) <= tol(src.w) &&
    Math.abs(wantH - src.h) <= tol(src.h) &&
    src.w <= maxDim &&
    src.h <= maxDim
  ) {
    out = {
      w: Math.max(1, Math.round(src.w)),
      h: Math.max(1, Math.round(src.h)),
    };
  }
  // The requested scale couldn't be met because the source ran out of pixels (rather than hitting
  // the 4096 ceiling) — surfaced in the UI so the chosen ratio's limit is visible.
  const sourceLimited = kSource < 0.999 && kSource <= kMax;
  return {
    crop,
    src,
    place,
    out,
    scale: out.w / src.w,
    upscaleClamped,
    sourceLimited,
  };
}
