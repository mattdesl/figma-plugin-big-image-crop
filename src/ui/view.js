// view.js — the crop preview and its direct manipulation.
//
// The image is drawn fixed; a dashed, aspect-locked rectangle sits on top as the crop selection.
// Drag inside it to pan, drag an edge/corner to resize (with matching N-S / E-W / diagonal cursors).
// Hold Alt/Option while resizing to grow from the centre. The View-zoom slider shrinks the whole
// preview so the marquee can be dragged out past the image and stay visible. The view transform is
// frozen for the duration of a gesture so the picture never shifts under the cursor mid-drag.

import { resizeCrop, clampCropPos } from "./crop.js";

const HANDLE = 9; // px hit radius for edges/corners
const HANDLE_DRAW = 7; // px visible handle square
const OVERPAN = 60; // px the view may pan past the content, so a marquee edge can clear the viewport

const CURSOR = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export const ZOOM_MIN = 0.125;
export const ZOOM_MAX = 8;
const ZOOM_WHEEL = 0.005; // ctrl-wheel / pinch sensitivity
const clampZoom = (z) => Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX);

export class CropView {
  constructor(canvas, { onCrop, onView } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onCrop = onCrop; // (newCrop) => void
    this.onView = onView; // ({zoom, center}) => void — from scroll/pinch
    this.scene = null;
    this.t = { vs: 1, ox: 0, oy: 0 };
    this._fit = 1;
    this._zoom = 1;
    this._gesture = null;
    this._last = null; // last pointer {clientX,clientY} during a gesture
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    const end = (e) => this._onUp(e);
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    // Alt (resize) / Shift (move) toggled mid-gesture should update immediately, even with no
    // pointer movement.
    const onKey = (e) => {
      const g = this._gesture;
      if (!g || !this._last) return;
      if (g.mode === "resize" && e.altKey !== g.alt) {
        e.preventDefault();
        this._applyResize(this._last.clientX, this._last.clientY, e.altKey);
      } else if (g.mode === "move" && e.shiftKey !== g.shift) {
        e.preventDefault();
        this._applyMove(this._last.clientX, this._last.clientY, e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  }

  setScene(scene) {
    this.scene = scene;
    this.render();
  }

  _toSrc(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - this.t.ox) / this.t.vs,
      y: (e.clientY - r.top - this.t.oy) / this.t.vs,
    };
  }

  _hit(e) {
    const s = this.scene;
    if (!s || !s.crop) return null;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const { vs, ox, oy } = this.t;
    const x0 = ox + s.crop.x * vs;
    const y0 = oy + s.crop.y * vs;
    const x1 = x0 + s.crop.w * vs;
    const y1 = y0 + s.crop.h * vs;
    const inX = mx >= x0 - HANDLE && mx <= x1 + HANDLE;
    const inY = my >= y0 - HANDLE && my <= y1 + HANDLE;
    let handle = "";
    if (Math.abs(my - y0) <= HANDLE && inX) handle += "n";
    else if (Math.abs(my - y1) <= HANDLE && inX) handle += "s";
    if (Math.abs(mx - x0) <= HANDLE && inY) handle += "w";
    else if (Math.abs(mx - x1) <= HANDLE && inY) handle += "e";
    if (handle) return { mode: "resize", handle };
    if (mx > x0 && mx < x1 && my > y0 && my < y1) return { mode: "move" };
    return null;
  }

  _onDown(e) {
    if (!this.scene) return;
    const hit = this._hit(e);
    if (!hit) return;
    this.canvas.setPointerCapture(e.pointerId);
    this._last = { clientX: e.clientX, clientY: e.clientY };
    const start = this._toSrc(e);
    this._gesture =
      hit.mode === "move"
        ? {
            mode: "move",
            startCrop: { ...this.scene.crop },
            startSrc: start,
            shift: e.shiftKey,
          }
        : {
            mode: "resize",
            handle: hit.handle,
            baseCrop: { ...this.scene.crop },
            basePointer: start,
            alt: e.altKey,
          };
    this.canvas.style.cursor =
      hit.mode === "move" ? "grabbing" : CURSOR[hit.handle];
  }

  _onMove(e) {
    const s = this.scene;
    if (!s) return;
    const g = this._gesture;
    if (!g) {
      const hit = this._hit(e);
      this.canvas.style.cursor = !hit
        ? "default"
        : hit.mode === "move"
          ? "grab"
          : CURSOR[hit.handle];
      return;
    }
    this._last = { clientX: e.clientX, clientY: e.clientY };
    if (g.mode === "move") this._applyMove(e.clientX, e.clientY, e.shiftKey);
    else this._applyResize(e.clientX, e.clientY, e.altKey);
  }

  // Move from a pointer position, measured from the gesture's *original* start. Holding Shift locks
  // the move to the dominant cardinal axis (the one the drag has travelled further along) — relative
  // to where the drag began, so pressing Shift partway snaps onto that axis.
  _applyMove(clientX, clientY, shiftKey) {
    const g = this._gesture;
    const s = this.scene;
    if (!g || g.mode !== "move" || !s) return;
    g.shift = shiftKey; // tracked only so the key handler can detect a change
    const cur = this._toSrc({ clientX, clientY });
    let dx = cur.x - g.startSrc.x;
    let dy = cur.y - g.startSrc.y;
    if (shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    this.onCrop?.(
      clampCropPos(
        {
          x: g.startCrop.x + dx,
          y: g.startCrop.y + dy,
          w: g.startCrop.w,
          h: g.startCrop.h,
        },
        s.srcW,
        s.srcH,
      ),
    );
  }

  // Resize from a pointer position. Always computed from the gesture's *original* base, so Alt
  // centres on where the crop was when the drag began — pressing or releasing Alt partway through
  // snaps to exactly what you'd have gotten holding it (or not) the whole time. (The snap on toggle
  // is intentional.)
  _applyResize(clientX, clientY, altKey) {
    const g = this._gesture;
    const s = this.scene;
    if (!g || g.mode !== "resize" || !s) return;
    g.alt = altKey; // tracked only so the key handler can detect a change
    const cur = this._toSrc({ clientX, clientY });
    const next = resizeCrop(
      g.baseCrop,
      g.handle,
      cur.x - g.basePointer.x,
      cur.y - g.basePointer.y,
      s.aspect,
      altKey,
    );
    this.onCrop?.(next);
  }

  _onUp(e) {
    if (!this._gesture) return;
    this._gesture = null;
    this._last = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.canvas.style.cursor = this._hit(e) ? "grab" : "default";
  }

  // Two-finger scroll pans; ctrl-wheel / trackpad pinch zooms toward the cursor and updates the
  // slider (via onView → the controller). Centre is derived from the current (clamped) transform so
  // panning continues smoothly from wherever the view actually sits.
  _onWheel(e) {
    if (!this.scene || this._gesture) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const { vs, ox, oy } = this.t;
    const halfW = this.canvas.clientWidth / 2;
    const halfH = this.canvas.clientHeight / 2;
    if (e.ctrlKey) {
      const zoom = clampZoom(this._zoom * Math.exp(-e.deltaY * ZOOM_WHEEL));
      const srcX = (cx - ox) / vs;
      const srcY = (cy - oy) / vs;
      const nvs = this._fit * zoom; // keep the point under the cursor fixed
      this.onView?.({
        zoom,
        center: { x: srcX + (halfW - cx) / nvs, y: srcY + (halfH - cy) / nvs },
      });
    } else {
      this.onView?.({
        zoom: this._zoom,
        center: {
          x: (halfW - ox) / vs + e.deltaX / vs,
          y: (halfH - oy) / vs + e.deltaY / vs,
        },
      });
    }
  }

  render() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 1;
    const cssH = canvas.clientHeight || 1;
    if (
      canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr)
    ) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#1b1b1f";
    ctx.fillRect(0, 0, cssW, cssH);

    const s = this.scene;
    if (!s) return;

    // Freeze the transform during a gesture; otherwise fit the union of the image and the crop into
    // the canvas, then apply the user's view-zoom (≤1 shrinks everything, opening up margin to drag
    // the marquee past the image edges). With no crop yet (no frame selected), just fit the image.
    const hasCrop = !!s.crop;
    if (!this._gesture) {
      const margin = 18;
      let minX = 0,
        minY = 0,
        maxX = s.srcW,
        maxY = s.srcH;
      const grow = (r) => {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
      };
      if (hasCrop) grow(s.crop);
      if (s.frameRect) grow(s.frameRect); // so the whole slide is visible when the result is smaller
      const boxW = maxX - minX;
      const boxH = maxY - minY;
      const fit = Math.min(
        (cssW - margin * 2) / boxW,
        (cssH - margin * 2) / boxH,
      );
      this._fit = fit;
      this._zoom = s.viewZoom || 1;
      const vs = fit * this._zoom;
      // Keep a focus point in view: an explicit pan centre if the user has scrolled/pinched, else
      // the crop (or, with no crop yet, the box centre). When zoomed in past the viewport, centre on
      // it and clamp so the box never pulls away from the edges; when it still fits, centre the box.
      const focusX = s.viewCenter
        ? s.viewCenter.x
        : hasCrop
          ? s.crop.x + s.crop.w / 2
          : (minX + maxX) / 2;
      const focusY = s.viewCenter
        ? s.viewCenter.y
        : hasCrop
          ? s.crop.y + s.crop.h / 2
          : (minY + maxY) / 2;
      const place = (canvas, lo, len, focus) => {
        const content = len * vs;
        if (content <= canvas) return (canvas - content) / 2 - lo * vs;
        // Centre on the focus, clamped so the content can pull up to OVERPAN px past each edge —
        // enough to bring a marquee handle sitting at the image edge clear of the viewport border.
        const o = canvas / 2 - focus * vs;
        return Math.min(
          Math.max(o, canvas - (lo + len) * vs - OVERPAN),
          -lo * vs + OVERPAN,
        );
      };
      this.t = {
        vs,
        ox: place(cssW, minX, boxW, focusX),
        oy: place(cssH, minY, boxH, focusY),
      };
    }
    const { vs, ox, oy } = this.t;

    // image (fixed)
    const iw = s.srcW * vs;
    const ih = s.srcH * vs;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(s.bitmap, ox, oy, iw, ih);

    // No frame selected yet → show the image alone, no crop overlay.
    if (!hasCrop) return;

    // dim everything, then reveal the crop region at full strength
    ctx.fillStyle = "rgba(20,20,24,0.62)";
    ctx.fillRect(0, 0, cssW, cssH);

    const rx = ox + s.crop.x * vs;
    const ry = oy + s.crop.y * vs;
    const rw = s.crop.w * vs;
    const rh = s.crop.h * vs;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    ctx.drawImage(s.bitmap, ox, oy, iw, ih);
    ctx.restore();

    // dashed crop border (dark base + white dashes for contrast on any image)
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    ctx.setLineDash([]);

    // slide outline — only present when the result won't fill the frame, so the (smaller) cropped
    // result is shown sitting inside the larger slide.
    if (s.frameRect) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(120,170,255,0.95)";
      ctx.strokeRect(
        ox + s.frameRect.x * vs + 0.5,
        oy + s.frameRect.y * vs + 0.5,
        s.frameRect.w * vs - 1,
        s.frameRect.h * vs - 1,
      );
    }

    // handles at corners + edge midpoints
    const hs = HANDLE_DRAW;
    const pts = [
      [rx, ry],
      [rx + rw / 2, ry],
      [rx + rw, ry],
      [rx, ry + rh / 2],
      [rx + rw, ry + rh / 2],
      [rx, ry + rh],
      [rx + rw / 2, ry + rh],
      [rx + rw, ry + rh],
    ];
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    for (const [px, py] of pts) {
      ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
      ctx.strokeRect(px - hs / 2 + 0.5, py - hs / 2 + 0.5, hs - 1, hs - 1);
    }
  }
}
