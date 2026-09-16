// ui.js — plugin window controller. Owns the state, wires the controls, runs decode → solve →
// preview, and on "Crop" runs produce → encode → postMessage back to the Figma sandbox.

import {
  FIT,
  ALIGN,
  solve,
  initCrop,
  reposition,
  snapCrop,
  PIXEL_EXACT_TOL,
} from "./crop.js";
import { KERNEL } from "./resample.js";
import { COLOR_SPACE } from "./encode.js";
import { decodePreview, decodeFull } from "./decode.js";
import { detectColorSpace } from "./colorspace.js";
import { produce, isPassThrough } from "./produce.js";
import { encodePNG } from "./encode.js";
import { CropView, ZOOM_MIN, ZOOM_MAX } from "./view.js";
import { alignIcon, loupeIcon } from "./icons.js";

const state = {
  frame: null, // {width,height,name} from the sandbox
  blob: null, // original dropped file — full pixels are re-decoded from it at crop time
  img: null, // {bitmap,width,height} — downscaled preview; full pixels are read at crop time
  crop: null, // crop rectangle in source px, or null until frame+image known
  fit: FIT.COVER,
  alignX: ALIGN.CENTER,
  alignY: ALIGN.CENTER,
  ratio: "max", // 1 | 2 | 4 | 8 | "max"; output never upscales past native (implicit)
  viewZoom: 1, // preview zoom (1 = fit); does not affect output
  viewCenter: null, // explicit pan centre (source px) once scrolled/pinched, else focus on the crop
  kernel: KERNEL.BICUBIC,
  colorSpace: COLOR_SPACE.SRGB, // auto-detected from the dropped image
  icc: null, // source ICC bytes, re-embedded verbatim on export
  iccLabel: "sRGB",
  loading: false,
  busy: false,
};

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
// Resolve only after the browser has painted the latest DOM change: the first rAF flushes the style
// change, the second fires after the ensuing paint. Used so the LOADING overlay is on screen before
// any thread-blocking work begins.
const afterPaint = async () => {
  await raf();
  await raf();
};
const isImage = (x) => x?.type?.startsWith("image/");

const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"),
  canvas: $("canvas"),
  drop: $("drop"),
  loading: $("loading"),
  file: $("file"),
  fit: document.querySelectorAll("[data-fit]"),
  alignX: document.querySelectorAll("[data-ax]"),
  alignY: document.querySelectorAll("[data-ay]"),
  ratio: document.querySelectorAll("[data-ratio]"),
  cslabel: $("cslabel"),
  viewzoom: $("viewzoom"),
  viewicon: $("viewicon"),
  crop: $("crop"),
  status: $("status"),
  hint: $("hint"),
};

// Every crop rectangle passes through here before it reaches the state, so the crop is *always* a
// whole number of source pixels — dragged, resized, realigned or preset. That's what keeps the
// verbatim-copy path reachable during ordinary editing instead of only on a fresh preset.
const snap = (crop) =>
  state.frame ? snapCrop(crop, state.frame.width / state.frame.height) : crop;

const view = new CropView(els.canvas, {
  onCrop(next) {
    // Direct manipulation (drag/resize) takes over from any preset.
    state.crop = snap(next);
    state.fit = FIT.CUSTOM;
    render();
  },
  onView(v) {
    setView(v.zoom, v.center); // scroll/pinch
  },
});

// View zoom is a log scale: slider midpoint (50) = fit (1×), ends = 1/ZOOM_MAX … ZOOM_MAX.
const OCTAVES = Math.log2(ZOOM_MAX);
const sliderToZoom = (v) => 2 ** ((v / 50 - 1) * OCTAVES);
const zoomToSlider = (z) => 50 * (1 + Math.log2(z) / OCTAVES);
function setView(zoom, center) {
  state.viewZoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
  state.viewCenter = center;
  els.viewzoom.value = zoomToSlider(state.viewZoom);
  render();
}

// Per-frame editing state, kept only for this plugin session (no data written to the document; the
// map dies with the iframe on close). Lets a carefully positioned marquee survive clicking away and
// back onto the same frame.
const cropMemory = new Map();

function rememberCrop() {
  if (state.frame && state.img && state.crop)
    cropMemory.set(state.frame.id, {
      crop: state.crop,
      fit: state.fit,
      alignX: state.alignX,
      alignY: state.alignY,
      frameW: state.frame.width,
      frameH: state.frame.height,
      imgW: state.img.width,
      imgH: state.img.height,
    });
}

// On (re)selecting a frame: restore a remembered crop if it still matches the current frame size and
// loaded image; otherwise build a fresh one from the fit. Either way, reset the view to fit.
function applyFrame() {
  const m = cropMemory.get(state.frame.id);
  if (
    m &&
    state.img &&
    m.frameW === state.frame.width &&
    m.frameH === state.frame.height &&
    m.imgW === state.img.width &&
    m.imgH === state.img.height
  ) {
    state.crop = m.crop;
    state.fit = m.fit;
    state.alignX = m.alignX;
    state.alignY = m.alignY;
  } else {
    resetCropFromFit();
  }
  state.viewZoom = 1;
  state.viewCenter = null;
  els.viewzoom.value = 50;
}

// Rebuild the crop rectangle for the current fit (used on load, frame change, and fit clicks).
function resetCropFromFit() {
  if (!state.frame || !state.img) {
    state.crop = null;
    return;
  }
  const fit = state.fit === FIT.CUSTOM ? FIT.COVER : state.fit;
  state.fit = fit;
  state.viewCenter = null; // re-centre the view on the new crop
  state.crop = snap(
    initCrop(
      fit,
      state.frame.width,
      state.frame.height,
      state.img.width,
      state.img.height,
      state.alignX,
      state.alignY,
    ),
  );
}

function currentSolve() {
  if (!state.frame || !state.img || !state.crop) return null;
  return solve({
    crop: state.crop,
    frameW: state.frame.width,
    frameH: state.frame.height,
    srcW: state.img.width,
    srcH: state.img.height,
    ratio: state.ratio,
    alignX: state.alignX,
    alignY: state.alignY,
  });
}

function render() {
  syncButtons();
  const hasFrame = !!state.frame;
  const hasImg = !!state.img;
  els.loading.style.display = state.loading || state.busy ? "flex" : "none";
  els.drop.style.display = !hasImg && !state.loading ? "flex" : "none";
  els.canvas.style.display = hasImg ? "block" : "none";

  const sol = hasImg && hasFrame && state.crop ? currentSolve() : null;
  // Nothing to crop until an image is loaded — hide the button rather than show it disabled.
  els.crop.style.display = hasImg ? "" : "none";
  els.crop.disabled = state.busy || !sol || !sol.place;

  if (state.loading) {
    els.hint.textContent = "";
    els.status.textContent = "";
    return;
  }

  // The image, once loaded, stays on screen whether or not a frame is selected — only the crop
  // overlay depends on having a frame.
  if (hasImg) {
    view.setScene({
      bitmap: state.img.bitmap,
      srcW: state.img.width,
      srcH: state.img.height,
      crop: sol ? state.crop : null,
      frameRect: frameOutline(sol), // shown only when the result won't fill the frame
      aspect: hasFrame
        ? state.frame.width / state.frame.height
        : state.img.width / state.img.height,
      viewZoom: state.viewZoom,
      viewCenter: state.viewCenter,
    });
  }

  els.status.title = "";
  if (!hasImg) {
    els.hint.textContent = hasFrame
      ? "Drop an image, or click to browse."
      : "Drop an image to begin.";
    els.status.textContent = hasFrame ? frameLabel() : "";
  } else if (!hasFrame) {
    els.hint.textContent = "Select a frame to set the crop area.";
    els.status.textContent = `src:${state.img.width}×${state.img.height}`;
  } else if (sol && sol.place) {
    const samp = sampling(sol);
    els.hint.textContent = "";
    els.status.textContent =
      `${frameLabel()} · src:${state.img.width}×${state.img.height}` +
      ` · out:${sol.out.w}×${sol.out.h}px · ${samp.text}`;
    els.status.title = samp.title;
  } else {
    els.hint.textContent = "";
    els.status.textContent = "Crop is off the image.";
  }
  rememberCrop();
}

function syncButtons() {
  const set = (nodes, attr, val) =>
    nodes.forEach((n) =>
      n.classList.toggle("on", n.dataset[attr] === String(val)),
    );
  set(els.fit, "fit", state.fit);
  // Alignment buttons are momentary "nudge" actions (they reposition the crop), not a persisted
  // mode — so they're never shown selected.
  set(els.ratio, "ratio", state.ratio);
  els.cslabel.textContent = state.img ? state.iccLabel : "";
  els.cslabel.title = state.img
    ? state.icc
      ? "Original ICC profile detected — embedded on export"
      : "No embedded profile — tagged sRGB"
    : "";
}

const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
// Two decimals at most, no trailing zeros: 1.6, 2.45, 3.
const fmt2 = (n) => String(+n.toFixed(2));

const frameLabel = () =>
  `frame:${fmt(state.frame.width)}×${fmt(state.frame.height)}`;

// The sampling ratio — source px per output px — collapses "1:1 (no resample)" and "source-limited"
// into one number, because they aren't independent flags: they're two points on the same scale.
//
//   2.4:1 — 2.4 source px feed each output px. Downsampling, so there's detail held in reserve
//           (though the 4096px ceiling may be what's holding it back, not the chosen ratio).
//   1:1   — the crop is copied out verbatim. Not one pixel is modified.
//   ~1:1  — the output has the crop's pixel count, but it is still resampled. See below.
//
// A source-limited export can only ever land *at* 1:1: the source ran out of pixels before the
// requested ratio was reached, so the output is exactly the crop's native pixels. That makes it not
// a third state but 1:1 arrived at as a ceiling rather than as a choice — the only thing left to
// distinguish, hence the "max" suffix. (Upsampling can't happen unless no-upscale is turned off, but
// it's handled so the ratio never lies if it ever is.)
//
// A bare "1:1" is a promise of *untouched pixels*, so it is spent only when produce() will actually
// take its cropCopy path — hence isPassThrough() rather than a tolerance on `scale`. Matching pixel
// counts are not sufficient: drag the crop by a third of a pixel and the output is still 4000×2250,
// but it now samples between source pixels and every one is interpolated. That case is real and
// common (any pan or resize lands on fractional coordinates), so it gets a tilde instead.
function sampling(sol) {
  const r = 1 / sol.scale; // source px per output px
  if (isPassThrough(sol)) {
    return sol.sourceLimited
      ? {
          text: "1:1 max",
          title:
            "1:1 pure crop — the selected pixels are copied out untouched. The export ratio is" +
            " capped by the source: this is already every pixel the crop has, so a higher ratio" +
            " would only invent detail.",
        }
      : {
          text: "1:1",
          title:
            "1:1 pure crop — the selected pixels are copied out untouched, not one is resampled",
        };
  }
  if (Math.abs(r - 1) < PIXEL_EXACT_TOL) {
    // solve() snaps anything this close to the crop's own pixels, so the only way to be near 1:1
    // *without* being exact is for the crop to exceed the 4096px ceiling, where snapping is refused.
    return {
      text: "~1:1",
      title:
        "Nearly 1:1, but the crop is larger than the 4096px ceiling, so it has to be scaled down to" +
        " fit and every pixel is resampled. Tighten the crop to stay under 4096px for an" +
        " untouched one.",
    };
  }
  return r > 1
    ? {
        text: `${fmt2(r)}:1`,
        title: `${fmt2(r)} source px per output px — downsampling, so there's source detail in reserve`,
      }
    : {
        text: `1:${fmt2(sol.scale)}`,
        title: `${fmt2(sol.scale)} output px per source px — upsampling past the source's detail`,
      };
}

// The frame's footprint in source-pixel space, so the preview can show the result sitting inside the
// slide. Returns null when the result fills the frame exactly (then the marquee already *is* the
// frame, and drawing it would just double the marquee border).
function frameOutline(sol) {
  if (!sol || !sol.place || !state.frame) return null;
  const { place, src, crop } = sol;
  const fills =
    Math.abs(place.x) < 0.5 &&
    Math.abs(place.y) < 0.5 &&
    Math.abs(place.w - state.frame.width) < 0.5 &&
    Math.abs(place.h - state.frame.height) < 0.5;
  if (fills) return null;
  const dPlace = place.w / src.w; // frame units per source px, as actually placed
  const r = {
    x: src.x - place.x / dPlace,
    y: src.y - place.y / dPlace,
    w: state.frame.width / dPlace,
    h: state.frame.height / dPlace,
  };
  // When the marquee already spans the whole slide (a small image placed inside it), the dashed
  // marquee *is* the frame — a separate outline would just double it.
  const near = (a, b) => Math.abs(a - b) <= crop.w * 0.01 + 0.5;
  if (
    near(r.x, crop.x) &&
    near(r.y, crop.y) &&
    near(r.w, crop.w) &&
    near(r.h, crop.h)
  )
    return null;
  return r;
}

// ---- decode ---------------------------------------------------------------------------------

async function loadBlob(blob) {
  state.blob = blob;
  const prevW = state.img?.width;
  const prevH = state.img?.height;

  // 1) tear down the current image and show LOADING. 2) yield a couple of frames so that paint
  // actually lands before the (potentially blocking) decode runs — otherwise the old image wouldn't
  // clear and "LOADING" wouldn't appear until after the heavy work.
  state.img?.bitmap?.close?.();
  state.img = null;
  state.loading = true;
  render();
  await afterPaint();

  try {
    // Sniff the colour space / embedded profile from the container (cheap, header-only), then decode
    // just a downscaled preview — the full-resolution pixels are read later, at crop time.
    const cs = await detectColorSpace(await blob.arrayBuffer());
    state.colorSpace = cs.space;
    state.icc = cs.icc;
    state.iccLabel = cs.label;
    const img = await decodePreview(blob);
    state.img = img;
    state.viewZoom = 1; // fresh view for the new image
    state.viewCenter = null;
    els.viewzoom.value = 50;
    if (!state.crop || prevW !== img.width || prevH !== img.height)
      resetCropFromFit();
  } catch (err) {
    state.img = null;
    state.loading = false;
    render();
    els.hint.textContent = String(err.message || err);
    return;
  }
  state.loading = false;
  render();
}

// ---- crop -----------------------------------------------------------------------------------

async function doCrop() {
  const sol = currentSolve();
  if (!sol || !sol.place || state.busy) return;
  state.busy = true;
  render();
  els.status.textContent = "Cropping…";
  // Wait for the overlay to actually paint before the (thread-blocking) full decode + resample —
  // otherwise it wouldn't show until the work was already done.
  await afterPaint();
  try {
    // Read the full-resolution pixels now (not held during editing), crop/resample, then let them go.
    const full = await decodeFull(state.blob, state.colorSpace);
    const px = produce(full.rgba, full.width, full.height, sol, state.kernel);
    const png = await encodePNG(px.data, px.w, px.h, {
      colorSpace: state.colorSpace,
      icc: state.icc,
      iccName: state.iccLabel,
    });
    parent.postMessage(
      {
        pluginMessage: {
          type: "crop",
          png,
          place: sol.place, // frame-relative rect (frame units)
          out: sol.out,
          colorSpace: state.colorSpace,
        },
      },
      "*",
    );
  } catch (err) {
    els.status.textContent = "Error: " + (err.message || err);
  } finally {
    // Always clear busy (and the blocking overlay) — even if produce/encode threw — so the UI can
    // never get stuck behind the overlay.
    state.busy = false;
    render();
  }
}

// ---- events ---------------------------------------------------------------------------------

function wire() {
  els.fit.forEach((b) =>
    b.addEventListener("click", () => {
      state.fit = b.dataset.fit;
      resetCropFromFit();
      render();
    }),
  );
  // Each button moves the crop along its own axis only; the other axis stays wherever it was
  // (e.g. after a drag), rather than snapping back to its last alignment.
  const realign = (alignX, alignY) => {
    if (state.crop)
      state.crop = snap(
        reposition(
          state.crop,
          state.img.width,
          state.img.height,
          alignX,
          alignY,
        ),
      );
    state.viewCenter = null; // re-centre on the realigned crop
    render();
  };
  els.alignX.forEach((b) =>
    b.addEventListener("click", () => {
      state.alignX = Number(b.dataset.ax);
      realign(state.alignX, null);
    }),
  );
  els.alignY.forEach((b) =>
    b.addEventListener("click", () => {
      state.alignY = Number(b.dataset.ay);
      realign(null, state.alignY);
    }),
  );
  els.ratio.forEach((b) =>
    b.addEventListener("click", () => {
      state.ratio = b.dataset.ratio === "max" ? "max" : Number(b.dataset.ratio);
      render();
    }),
  );
  els.viewzoom.addEventListener("input", () => {
    state.viewZoom = sliderToZoom(Number(els.viewzoom.value)); // keep the current pan centre
    render();
  });
  // Clicking the loupe resets to fit (slider midpoint) and re-centres.
  els.viewicon.addEventListener("click", () => setView(1, null));
  els.crop.addEventListener("click", doCrop);
  // Enter crops from anywhere in the plugin window. preventDefault stops it from also "clicking"
  // whichever button last took focus (e.g. re-applying a fit preset).
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.repeat || e.isComposing) return;
    e.preventDefault();
    doCrop();
  });

  // drag & drop + click-to-browse
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((t) =>
    els.stage.addEventListener(t, (e) => {
      stop(e);
      els.stage.classList.toggle(
        "dragging",
        t === "dragenter" || t === "dragover",
      );
    }),
  );
  els.stage.addEventListener("drop", (e) => {
    const file = [...(e.dataTransfer?.files || [])].find(isImage);
    if (file) loadBlob(file);
  });
  els.drop.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => {
    if (els.file.files[0]) loadBlob(els.file.files[0]);
  });
  window.addEventListener("resize", () => view.render());

  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find(isImage);
    if (item) loadBlob(item.getAsFile());
  });
}

// ---- sandbox messages -----------------------------------------------------------------------

window.onmessage = (e) => {
  const msg = e.data.pluginMessage;
  if (!msg) return;
  if (msg.type === "frame") {
    const prev = state.frame;
    state.frame = msg.frame;
    if (prev?.id !== msg.frame.id) {
      applyFrame(); // restore a remembered crop for this frame, or build a fresh one
    } else if (
      prev.width !== msg.frame.width ||
      prev.height !== msg.frame.height
    ) {
      // Same frame, resized in Figma: re-fit the crop to the new aspect but keep the view zoom.
      resetCropFromFit();
    }
    render();
  } else if (msg.type === "no-frame") {
    // Keep the image on screen; just drop the crop overlay until a frame is selected again.
    state.frame = null;
    state.crop = null;
    render();
  } else if (msg.type === "done") {
    els.status.textContent = `Placed ${msg.out.w}×${msg.out.h}px ✓`;
  }
};

// Fill the alignment buttons with Figma-style SVG glyphs (their data-ax/data-ay drive both the icon
// and the click behaviour), and the view-zoom label with a magnifier.
els.alignX.forEach((b) =>
  b.replaceChildren(alignIcon("h", Number(b.dataset.ax))),
);
els.alignY.forEach((b) =>
  b.replaceChildren(alignIcon("v", Number(b.dataset.ay))),
);
$("viewicon").replaceChildren(loupeIcon());

wire();
render();
parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
