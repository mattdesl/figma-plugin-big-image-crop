// icons.js — programmatic SVG glyphs for the alignment buttons, in Figma's "rail + two bars" style:
// a thin guide bar marking the alignment edge, plus two object bars of different lengths aligned to
// it. Built as DOM nodes with fill="currentColor" so they inherit each button's text colour (light
// when idle, white when the button is selected).

const NS = "http://www.w3.org/2000/svg";

function svg(rects) {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "16");
  el.setAttribute("height", "16");
  el.setAttribute("fill", "currentColor");
  for (const r of rects) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", r.x);
    rect.setAttribute("y", r.y);
    rect.setAttribute("width", r.w);
    rect.setAttribute("height", r.h);
    rect.setAttribute("rx", Math.min(r.w, r.h) / 2); // rounded (pill) ends, like Figma
    el.appendChild(rect);
  }
  return el;
}

/**
 * Alignment glyph.
 * @param {"h"|"v"} orientation  "h" = horizontal align (vertical rail), "v" = vertical align
 * @param {number} align         0 = start (left/top), 0.5 = centre, 1 = end (right/bottom)
 */
export function alignIcon(orientation, align) {
  const RAIL = 1.5; // guide-bar thickness
  const T = 2; // object-bar thickness
  const M = 2; // margin from the edge
  const railLen = 11;
  const L1 = 8; // longer bar
  const L2 = 5; // shorter bar

  // Built in the horizontal-align frame: a vertical rail at left/centre/right + two horizontal bars
  // aligned to it. The vertical-align icons are just this transposed.
  const railPos =
    align === 0 ? M : align === 1 ? 16 - M - RAIL : (16 - RAIL) / 2;
  const railCross = (16 - railLen) / 2;
  let x1, x2;
  if (align === 0) {
    x1 = x2 = railPos + RAIL + 1; // 1px right of the rail, left-aligned
  } else if (align === 1) {
    x1 = railPos - 1 - L1; // 1px left of the rail, right-aligned
    x2 = railPos - 1 - L2;
  } else {
    x1 = 8 - L1 / 2; // centred on the rail
    x2 = 8 - L2 / 2;
  }

  let rects = [
    { x: railPos, y: railCross, w: RAIL, h: railLen },
    { x: x1, y: 5, w: L1, h: T },
    { x: x2, y: 9, w: L2, h: T },
  ];
  if (orientation === "v")
    rects = rects.map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }));
  return svg(rects);
}

// Magnifying-glass glyph: a stroked circle (upper-right) with a handle running down-and-left.
export function loupeIcon() {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.6");
  el.setAttribute("stroke-linecap", "round");
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", "9.5");
  circle.setAttribute("cy", "6.5");
  circle.setAttribute("r", "3.6");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", "6.95"); // ≈ the circle's lower-left edge
  line.setAttribute("y1", "9.05");
  line.setAttribute("x2", "3");
  line.setAttribute("y2", "13");
  el.appendChild(circle);
  el.appendChild(line);
  return el;
}
