// test.js — validates the pieces that run without a browser: crop geometry, the MIN (no-upscale)
// rule, resampling, the pass-through fast path, and PNG/ICC encoding (round-tripped through the
// platform's inflate). DOM-bound modules (decode.js, view.js, ui.js) are exercised manually in Figma.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIT,
  ALIGN,
  solve,
  initCrop,
  reposition,
  clampCropPos,
  resizeCrop,
  snapCrop,
  MAX_DIM,
} from "./src/ui/crop.js";
import { resample, cropCopy, KERNEL } from "./src/ui/resample.js";
import { produce, isPassThrough } from "./src/ui/produce.js";
import { encodePNG, COLOR_SPACE } from "./src/ui/encode.js";
import { detectColorSpace } from "./src/ui/colorspace.js";
import { inflate } from "./src/ui/zlib.js";
import { readChunks, ChunkType, decode_iCCP, readIHDR } from "png-tools";
import { displayP3Profile } from "./src/ui/icc.js";

const sol = (crop, over = {}) =>
  solve({
    crop,
    frameW: 1920,
    frameH: 1080,
    srcW: 4000,
    srcH: 3000,
    ratio: 1,
    alignX: ALIGN.CENTER,
    alignY: ALIGN.CENTER,
    noUpscale: true,
    ...over,
  });

test("initCrop cover: largest frame-aspect rectangle inside the image, centred", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  assert.equal(c.w, 4000); // width-bound (image is narrower than 16:9)
  assert.ok(Math.abs(c.h - 2250) < 1e-6); // 4000 / (16/9)
  assert.equal(c.x, 0);
  assert.ok(Math.abs(c.y - 375) < 1e-6); // (3000-2250)/2
});

test("cover crop fills the frame and downsamples", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = sol(c);
  assert.deepEqual(
    { x: s.place.x, y: s.place.y, w: s.place.w, h: s.place.h },
    { x: 0, y: 0, w: 1920, h: 1080 },
  );
  assert.equal(s.out.w, 1920);
  assert.equal(s.out.h, 1080);
  assert.ok(s.scale < 1);
});

test("ratio 2x supersamples within the source budget", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = sol(c, { ratio: 2 });
  assert.equal(s.out.w, 3840); // source (4000) still covers it
  assert.equal(s.out.h, 2160);
});

test("NO UPSCALE on: 8x caps at native resolution, never upscaling", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = sol(c, { ratio: 8, noUpscale: true });
  assert.equal(s.out.w, 4000); // capped to the source's 4000px, not 1920*8
  assert.ok(!s.upscaleClamped); // still fills the frame, just at lower DPI
});

test("NO UPSCALE off: 8x scales up to the requested ratio (capped only by MAX_DIM)", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = sol(c, { ratio: 8, noUpscale: false });
  assert.equal(s.out.w, MAX_DIM); // 1920*8 clamped to 4096
});

test("MAX: native source resolution, bounded by MAX_DIM on the longest edge", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  // cover crop is 4000×2250 of source → native output, under the cap
  const s = sol(c, { ratio: "max" });
  assert.equal(s.out.w, 4000);
  assert.equal(s.out.h, 2250);

  // a bigger source: native (10000×5625) clamps to 4096 on the long edge, aspect kept
  const big = initCrop(
    FIT.COVER,
    1920,
    1080,
    10000,
    7500,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const sb = solve({
    crop: big,
    frameW: 1920,
    frameH: 1080,
    srcW: 10000,
    srcH: 7500,
    ratio: "max",
    alignX: 0.5,
    alignY: 0.5,
  });
  assert.equal(sb.out.w, MAX_DIM);
  assert.ok(Math.abs(sb.out.w / sb.out.h - 1920 / 1080) < 0.01);
});

test("small image isn't cropped: cover spans the whole slide, whole image placed inside", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    512,
    512,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  assert.equal(c.w, 1920); // marquee = the whole slide, not a 512×288 trim
  assert.equal(c.h, 1080);
  const s = solve({
    crop: c,
    frameW: 1920,
    frameH: 1080,
    srcW: 512,
    srcH: 512,
    ratio: 1,
    alignX: 0.5,
    alignY: 0.5,
  });
  assert.equal(s.out.w, 512); // the whole image, native
  assert.equal(s.out.h, 512);
  assert.ok(Math.abs(s.place.w - 512) < 1e-6);
  assert.ok(Math.abs(s.place.x - (1920 - 512) / 2) < 1e-6); // centred in the slide
  assert.ok(Math.abs(s.place.y - (1080 - 512) / 2) < 1e-6);
});

test("small image: cover and contain agree (nothing to crop)", () => {
  const cov = initCrop(
    FIT.COVER,
    1920,
    1080,
    512,
    512,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const con = initCrop(
    FIT.CONTAIN,
    1920,
    1080,
    512,
    512,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  assert.deepEqual(cov, con);
});

test("MAX honours NO UPSCALE on a zoomed-in crop: native-size vs stretch-to-fill", () => {
  const base = {
    crop: { x: 1000, y: 800, w: 100, h: 56.25 },
    frameW: 1920,
    frameH: 1080,
    srcW: 4000,
    srcH: 3000,
    ratio: "max",
    alignX: 0.5,
    alignY: 0.5,
  };
  const on = solve({ ...base, noUpscale: true });
  assert.ok(on.upscaleClamped);
  assert.ok(Math.abs(on.place.w - 100) < 1e-6); // placed at native size
  assert.equal(on.out.w, 100);
  const off = solve({ ...base, noUpscale: false });
  assert.ok(!off.upscaleClamped);
  assert.equal(off.place.w, 1920); // fills the frame
  assert.equal(off.out.w, 100); // ...with native pixels (Figma stretches them)
});

test("sourceLimited flags when the chosen scale outruns the source pixels", () => {
  const c = initCrop(
    FIT.COVER,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  assert.ok(!sol(c, { ratio: 1 }).sourceLimited); // 1920 ≤ 4000
  assert.ok(!sol(c, { ratio: 2 }).sourceLimited); // 3840 ≤ 4000
  assert.ok(sol(c, { ratio: 8 }).sourceLimited); // 15360 wanted, only 4000 available
});

test("zoom past native: NO UPSCALE places at 1:1, off fills the frame by upscaling", () => {
  const crop = { x: 1000, y: 800, w: 100, h: 56.25 }; // tiny 16:9 region
  const on = sol(crop, { noUpscale: true });
  assert.ok(on.upscaleClamped);
  assert.equal(on.out.w, 100); // native, no upscale
  assert.ok(Math.abs(on.place.w - 100) < 1e-6); // placed at native size...
  assert.ok(Math.abs(on.place.x - (1920 - 100) / 2) < 1e-6); // ...centred in the frame

  const off = sol(crop, { noUpscale: false });
  assert.ok(!off.upscaleClamped);
  assert.equal(off.place.w, 1920); // fills the frame
  assert.equal(off.out.w, 1920); // upscaled output
});

test("none/1:1: crop is frame-sized, output is a no-resample pass-through", () => {
  const c = initCrop(
    FIT.NONE,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  assert.equal(c.w, 1920);
  assert.equal(c.h, 1080);
  const s = sol(c);
  assert.equal(s.out.w, 1920);
  assert.equal(s.out.h, 1080);
  assert.ok(Math.abs(s.scale - 1) < 1e-9);
});

// The UI shows "1:1" only when isPassThrough() is true, and that claim means literally untouched
// pixels — so the predicate must not be satisfiable by matching pixel counts alone. A crop nudged by
// a fraction of a pixel keeps its size but samples between source pixels: still a resample.
test("isPassThrough demands whole-pixel offsets, not just a matching pixel count", () => {
  const c = initCrop(
    FIT.NONE,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const exact = sol(c);
  assert.ok(isPassThrough(exact));

  // Same size, offset by a third of a pixel — what any pan gesture produces.
  const nudged = sol({ ...c, x: c.x + 0.37 });
  assert.equal(nudged.out.w, exact.out.w); // pixel count is unchanged...
  assert.ok(Math.abs(1 / nudged.scale - 1) < 0.005); // ...and scale still rounds to 1:1
  assert.ok(!isPassThrough(nudged)); // ...but it is NOT an untouched crop
});

// Ties the predicate to the pixels: whenever it's true, produce() must return the source bytes
// verbatim. If the fast path ever regressed to interpolating, this would catch it.
test("isPassThrough true ⇒ produce copies source bytes untouched", () => {
  const srcW = 64,
    srcH = 48;
  const rgba = new Uint8Array(srcW * srcH * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 0xff;

  const s = solve({
    crop: { x: 8, y: 6, w: 32, h: 18 },
    frameW: 32,
    frameH: 18,
    srcW,
    srcH,
    ratio: 1,
    alignX: ALIGN.CENTER,
    alignY: ALIGN.CENTER,
  });
  assert.ok(isPassThrough(s));

  const got = produce(rgba, srcW, srcH, s, KERNEL.BICUBIC);
  const want = cropCopy(rgba, srcW, srcH, 8, 6, 32, 18);
  assert.deepEqual(
    new Uint8Array(got.data.buffer),
    new Uint8Array(want.buffer),
  );
});

test("snapCrop lands on whole pixels, holds the centre and the aspect", () => {
  const aspect = 1920 / 1080;
  const c = snapCrop({ x: 100.37, y: 50.62, w: 3999.4, h: 2249.66 }, aspect);
  for (const v of [c.x, c.y, c.w, c.h]) assert.equal(v, Math.round(v));
  // Aspect can't be exact on integers, but must land within half a pixel of it.
  assert.ok(Math.abs(c.h - c.w / aspect) <= 0.5);
  // Centre is preserved to within the half-pixel the rounding costs.
  assert.ok(Math.abs(c.x + c.w / 2 - (100.37 + 3999.4 / 2)) <= 0.5);
  assert.ok(Math.abs(c.y + c.h / 2 - (50.62 + 2249.66 / 2)) <= 0.5);
});

// The point of snapping: gestures produce fractional crops, and a fractional crop can never be
// copied out verbatim. Every pan/resize must settle onto pixels that produce() can copy.
test("snapped drag and resize gestures yield untouched-pixel crops", () => {
  const frameW = 1920,
    frameH = 1080,
    srcW = 4000,
    srcH = 3000;
  const aspect = frameW / frameH;
  const snap = (c) => snapCrop(c, aspect);
  const base = snap(
    initCrop(FIT.COVER, frameW, frameH, srcW, srcH, ALIGN.CENTER, ALIGN.CENTER),
  );

  for (const d of [0.37, 1.5, 12.84, -7.2, 0.5, -0.5]) {
    const gestures = {
      pan: snap(
        clampCropPos({ ...base, x: base.x + d, y: base.y + d }, srcW, srcH),
      ),
      resize: snap(resizeCrop(base, "se", d * 3, d * 3, aspect, false)),
      "resize+alt": snap(resizeCrop(base, "nw", d * 2, d * 2, aspect, true)),
    };
    for (const [name, crop] of Object.entries(gestures)) {
      const s = solve({
        crop,
        frameW,
        frameH,
        srcW,
        srcH,
        ratio: "max",
        alignX: ALIGN.CENTER,
        alignY: ALIGN.CENTER,
      });
      assert.ok(
        isPassThrough(s),
        `${name} by ${d}px should be an untouched crop, got src ${s.src.w}×${s.src.h} @${s.src.x},${s.src.y} → out ${s.out.w}×${s.out.h}`,
      );
      assert.equal(s.scale, 1);
    }
  }
});

// Snapping leaves the crop up to half a pixel off the frame aspect. That residual must be spent as an
// imperceptible aspect difference, never as a visible gap along a frame edge.
test("a snapped crop inside the image still fills the frame exactly", () => {
  for (const [frameW, frameH] of [
    [1920, 1080],
    [1000, 667],
    [333, 777],
  ]) {
    const aspect = frameW / frameH;
    const srcW = 4000,
      srcH = 3000;
    const base = snapCrop(
      initCrop(
        FIT.COVER,
        frameW,
        frameH,
        srcW,
        srcH,
        ALIGN.CENTER,
        ALIGN.CENTER,
      ),
      aspect,
    );
    // Nudge to a size whose exact-aspect height is decidedly fractional.
    const crop = snapCrop(
      { ...base, w: base.w - 3, h: (base.w - 3) / aspect },
      aspect,
    );
    assert.ok(crop.x >= 0 && crop.y + crop.h <= srcH); // still inside the image
    const s = solve({
      crop,
      frameW,
      frameH,
      srcW,
      srcH,
      ratio: "max",
      alignX: ALIGN.CENTER,
      alignY: ALIGN.CENTER,
    });
    assert.deepEqual(s.place, { x: 0, y: 0, w: frameW, h: frameH });
  }
});

// The pixel-exact snap must never become a loophole around the two hard limits.
test("pixel-exact snapping never upscales nor breaks MAX_DIM", () => {
  const frameW = 1920,
    frameH = 1080;
  const aspect = frameW / frameH;
  for (const [srcW, srcH] of [
    [6000, 4000],
    [4100, 4100],
    [4097, 2304],
    [1600, 1000],
  ]) {
    const base = snapCrop(
      initCrop(
        FIT.COVER,
        frameW,
        frameH,
        srcW,
        srcH,
        ALIGN.CENTER,
        ALIGN.CENTER,
      ),
      aspect,
    );
    for (const ratio of ["max", 1, 2, 4, 8]) {
      const s = solve({
        crop: base,
        frameW,
        frameH,
        srcW,
        srcH,
        ratio,
        alignX: ALIGN.CENTER,
        alignY: ALIGN.CENTER,
      });
      assert.ok(
        s.out.w <= MAX_DIM && s.out.h <= MAX_DIM,
        `${srcW}×${srcH} @${ratio} exceeded MAX_DIM`,
      );
      assert.ok(
        s.out.w <= Math.ceil(s.src.w) && s.out.h <= Math.ceil(s.src.h),
        `${srcW}×${srcH} @${ratio} upscaled past the source`,
      );
    }
  }
});

test("contain: whole image visible, centred with letterbox", () => {
  const c = initCrop(
    FIT.CONTAIN,
    1920,
    1080,
    4000,
    3000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = sol(c);
  // entire image is the content
  assert.equal(s.src.w, 4000);
  assert.equal(s.src.h, 3000);
  assert.ok(Math.abs(s.place.h - 1080) < 1e-6); // height-bound
  assert.ok(s.place.w < 1920); // letterboxed sides
  assert.ok(Math.abs(s.place.x - (1920 - s.place.w) / 2) < 1e-6); // centred
});

test("output never exceeds MAX_DIM", () => {
  const c = initCrop(
    FIT.COVER,
    3000,
    2000,
    12000,
    8000,
    ALIGN.CENTER,
    ALIGN.CENTER,
  );
  const s = solve({
    crop: c,
    frameW: 3000,
    frameH: 2000,
    srcW: 12000,
    srcH: 8000,
    ratio: 8,
    alignX: 0.5,
    alignY: 0.5,
    noUpscale: false,
  });
  assert.ok(
    s.out.w <= MAX_DIM && s.out.h <= MAX_DIM,
    `got ${s.out.w}x${s.out.h}`,
  );
});

test("resizeCrop: anchored corner, locked aspect, free to go outside the image", () => {
  const aspect = 1920 / 1080;
  const c = { x: 100, y: 100, w: 400, h: 400 / aspect };
  const se = resizeCrop(c, "se", 200, 0, aspect, false); // drag SE corner
  assert.equal(se.x, 100); // TL anchored
  assert.equal(se.y, 100);
  assert.ok(se.w > c.w); // grew (size projected onto the diagonal)
  assert.ok(Math.abs(se.w / se.h - aspect) < 1e-6); // aspect preserved

  // dragging the W edge left past 0 is allowed (no image-bounds clamp)
  const out = resizeCrop(
    { x: 0, y: 0, w: 400, h: 400 / aspect },
    "w",
    -500,
    0,
    aspect,
    false,
  );
  assert.ok(out.x < 0, `expected negative x, got ${out.x}`);
});

test("resizeCrop: Alt grows symmetrically about the centre", () => {
  const aspect = 1920 / 1080;
  const c = { x: 100, y: 100, w: 400, h: 400 / aspect };
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const r = resizeCrop(c, "se", 100, 0, aspect, true); // alt
  assert.ok(r.w > c.w); // grew
  assert.ok(Math.abs(r.x + r.w / 2 - cx) < 1e-6); // centre fixed
  assert.ok(Math.abs(r.y + r.h / 2 - cy) < 1e-6);
});

test("resizeCrop: corner follows the diagonal smoothly (no dominant-axis jump)", () => {
  // A drag exactly along the aspect diagonal (dx = aspect·dy) grows width by dx — and the result is
  // a continuous function of the pointer, so there's no jump when one axis overtakes the other.
  const aspect = 2;
  const c = { x: 0, y: 0, w: 100, h: 50 };
  const r = resizeCrop(c, "se", 40, 20, aspect, false);
  assert.ok(Math.abs(r.w - 140) < 1e-6); // dw = (40·4 + 40)/5 = 40
});

test("reposition aligns the crop within the image", () => {
  const c = reposition(
    { x: 9, y: 9, w: 400, h: 225 },
    4000,
    3000,
    ALIGN.END,
    ALIGN.START,
  );
  assert.equal(c.x, 3600);
  assert.equal(c.y, 0);
});

test("reposition leaves a null axis untouched", () => {
  const crop = { x: 9, y: 17, w: 400, h: 225 };
  const h = reposition(crop, 4000, 3000, ALIGN.CENTER, null);
  assert.equal(h.x, 1800);
  assert.equal(h.y, 17);
  const v = reposition(crop, 4000, 3000, null, ALIGN.CENTER);
  assert.equal(v.x, 9);
  assert.equal(v.y, 1387.5);
});

test("clampCropPos allows going outside but keeps the crop recoverable", () => {
  const c = clampCropPos({ x: -1000, y: -1000, w: 400, h: 225 }, 4000, 3000);
  assert.equal(c.x, -360); // 40px overlap kept (40 - 400)
  assert.equal(c.y, -185); // 40 - 225
  const c2 = clampCropPos({ x: 99999, y: 0, w: 400, h: 225 }, 4000, 3000);
  assert.equal(c2.x, 3960); // 4000 - 40
});

test("cropCopy extracts exact bytes (u32 row copy)", () => {
  const W = 6,
    H = 5;
  const src = new Uint8Array(W * H * 4);
  for (let i = 0; i < src.length; i++) src[i] = (i * 31) & 255;
  const out = cropCopy(src, W, H, 2, 1, 3, 2);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++) {
      const si = ((y + 1) * W + (x + 2)) * 4;
      const di = (y * 3 + x) * 4;
      for (let c = 0; c < 4; c++) assert.equal(out[di + c], src[si + c]);
    }
});

test("produce: pass-through path returns exact source pixels", () => {
  const W = 400,
    H = 300;
  const src = new Uint8Array(W * H * 4);
  for (let i = 0; i < src.length; i++) src[i] = (i * 17) & 255;
  const crop = initCrop(FIT.NONE, 200, 150, W, H, ALIGN.CENTER, ALIGN.CENTER);
  const s = solve({
    crop,
    frameW: 200,
    frameH: 150,
    srcW: W,
    srcH: H,
    ratio: 1,
    alignX: 0.5,
    alignY: 0.5,
    noUpscale: true,
  });
  const px = produce(src, W, H, s, KERNEL.BICUBIC);
  assert.equal(px.w, 200);
  assert.equal(px.h, 150);
  for (let y = 0; y < 150; y++)
    for (let x = 0; x < 200; x++) {
      const si = ((y + 75) * W + (x + 100)) * 4;
      const di = (y * 200 + x) * 4;
      for (let c = 0; c < 4; c++) assert.equal(px.data[di + c], src[si + c]);
    }
});

test("resample: solid colour is preserved across kernels and scales", () => {
  const W = 64,
    H = 64;
  const src = new Uint8Array(W * H * 4);
  for (let i = 0; i < src.length; i += 4) {
    src[i] = 200;
    src[i + 1] = 100;
    src[i + 2] = 50;
    src[i + 3] = 255;
  }
  for (const k of [KERNEL.NEAREST, KERNEL.BILINEAR, KERNEL.BICUBIC]) {
    const dst = new Uint8ClampedArray(20 * 20 * 4);
    resample(src, W, H, dst, 20, 20, { x: 0, y: 0, w: W, h: H }, k);
    for (let i = 0; i < dst.length; i += 4) {
      assert.ok(Math.abs(dst[i] - 200) <= 1, `${k} R`);
      assert.ok(Math.abs(dst[i + 1] - 100) <= 1, `${k} G`);
      assert.ok(Math.abs(dst[i + 2] - 50) <= 1, `${k} B`);
      assert.equal(dst[i + 3], 255, `${k} A`);
    }
  }
});

test("resample: 2x2 → 1x1 box-averages (bilinear)", () => {
  const src = new Uint8Array([
    0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 40, 40, 40, 255,
  ]);
  const dst = new Uint8ClampedArray(4);
  resample(src, 2, 2, dst, 1, 1, { x: 0, y: 0, w: 2, h: 2 }, KERNEL.BILINEAR);
  const mean = (0 + 100 + 200 + 40) / 4;
  assert.ok(Math.abs(dst[0] - mean) <= 1, `got ${dst[0]} want ~${mean}`);
});

// --- PNG / ICC --------------------------------------------------------------------------------

function idatBytes(png) {
  const parts = readChunks(png)
    .filter((c) => c.type === ChunkType.IDAT)
    .map((c) => c.data);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("encodePNG: sRGB round-trips pixels exactly (filter None)", async () => {
  const W = 8,
    H = 4;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 53) & 255;
  const png = await encodePNG(data, W, H, {
    colorSpace: COLOR_SPACE.SRGB,
    filter: 0,
  });

  const ihdr = readIHDR(png);
  assert.equal(ihdr.width, W);
  assert.equal(ihdr.height, H);
  const chunks = readChunks(png);
  assert.ok(chunks.some((c) => c.type === ChunkType.sRGB));
  assert.ok(!chunks.some((c) => c.type === ChunkType.iCCP));

  const raw = await inflate(idatBytes(png));
  const stride = W * 4;
  for (let y = 0; y < H; y++) {
    assert.equal(raw[y * (stride + 1)], 0, "filter None");
    for (let x = 0; x < stride; x++)
      assert.equal(raw[y * (stride + 1) + 1 + x], data[y * stride + x]);
  }
});

test("encodePNG: P3 embeds the exact Display P3 ICC profile", async () => {
  const W = 4,
    H = 4;
  const data = new Uint8ClampedArray(W * H * 4).fill(128);
  const png = await encodePNG(data, W, H, { colorSpace: COLOR_SPACE.P3 });
  const iccp = readChunks(png).find((c) => c.type === ChunkType.iCCP);
  assert.ok(iccp);
  const decoded = decode_iCCP(iccp.data);
  assert.equal(decoded.name, "Display P3");
  const profile = await inflate(decoded.data);
  const expected = displayP3Profile();
  assert.equal(profile.length, expected.length);
  for (let i = 0; i < expected.length; i++)
    assert.equal(profile[i], expected[i]);
});

test("encodePNG: default filter produces a valid IDAT stream", async () => {
  const W = 16,
    H = 16;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i++)
    data[i] = (Math.sin(i) * 127 + 128) & 255;
  const png = await encodePNG(data, W, H);
  const raw = await inflate(idatBytes(png));
  assert.equal(raw.length, H * (W * 4 + 1));
});

// --- colour-space detection + ICC pass-through ------------------------------------------------

test("detectColorSpace: a pass-through ICC round-trips byte-exact and reads as P3", async () => {
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(128);
  const icc = displayP3Profile();
  const png = await encodePNG(data, 4, 4, { icc, iccName: "Display P3" });
  const det = await detectColorSpace(png);
  assert.equal(det.space, "display-p3");
  assert.ok(det.icc, "extracted an ICC");
  assert.equal(det.icc.length, icc.length);
  for (let i = 0; i < icc.length; i++) assert.equal(det.icc[i], icc[i]);
});

test("detectColorSpace: generated-P3 PNG is detected as display-p3", async () => {
  const png = await encodePNG(
    new Uint8ClampedArray(4 * 4 * 4).fill(100),
    4,
    4,
    { colorSpace: COLOR_SPACE.P3 },
  );
  const det = await detectColorSpace(png);
  assert.equal(det.space, "display-p3");
});

test("detectColorSpace: plain sRGB PNG → srgb, no ICC", async () => {
  const png = await encodePNG(new Uint8ClampedArray(4 * 4 * 4), 4, 4, {
    colorSpace: COLOR_SPACE.SRGB,
  });
  const det = await detectColorSpace(png);
  assert.equal(det.space, "srgb");
  assert.equal(det.icc, null);
});
