// main.js — Figma sandbox side. Reports the selected frame's size to the UI (live, on every
// selection change or resize) and, when the UI sends back cropped PNG bytes, materialises them as
// an image rectangle placed exactly where the crop sat over the frame.

figma.showUI(__html__, { width: 480, height: 540, themeColors: true });

// Frame-like containers that can define the crop's bounds & aspect.
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "SECTION"]);

// Walk up from the selection to the nearest frame-like ancestor (the selected node itself counts).
// So selecting any object inside a frame still targets that frame; selecting nothing frame-like
// anywhere up the chain yields null.
function findFrame() {
  let n = figma.currentPage.selection[0] || null;
  while (n && n.type !== "PAGE") {
    if (FRAME_TYPES.has(n.type)) return n;
    n = n.parent;
  }
  return null;
}

function sendFrame() {
  const f = findFrame();
  figma.ui.postMessage(
    f
      ? {
          type: "frame",
          frame: { id: f.id, width: f.width, height: f.height, name: f.name },
        }
      : { type: "no-frame" },
  );
}

figma.on("selectionchange", sendFrame);

// Resizing the selected frame doesn't change the selection, so also watch the page for width/height
// edits to the target frame and re-report it. Page listeners are per page, so follow page switches.
function onNodeChange(e) {
  const f = findFrame();
  if (
    f &&
    e.nodeChanges.some(
      (c) =>
        c.id === f.id &&
        c.type === "PROPERTY_CHANGE" &&
        (c.properties.includes("width") || c.properties.includes("height")),
    )
  )
    sendFrame();
}
let watchedPage = figma.currentPage;
watchedPage.on("nodechange", onNodeChange);
figma.on("currentpagechange", () => {
  watchedPage.off("nodechange", onNodeChange);
  watchedPage = figma.currentPage;
  watchedPage.on("nodechange", onNodeChange);
});

figma.ui.onmessage = (msg) => {
  // The UI tells us when its message listener is live, so the first frame report can't be lost to a
  // load race.
  if (msg.type === "ui-ready") {
    sendFrame();
    return;
  }
  if (msg.type !== "crop") return;

  const frame = findFrame();
  if (!frame) {
    figma.notify("Select a frame first.");
    return;
  }

  let image;
  try {
    image = figma.createImage(msg.png);
  } catch (err) {
    figma.notify("Couldn't create image: " + (err.message || err));
    return;
  }

  const rect = figma.createRectangle();
  rect.resize(Math.max(0.01, msg.place.w), Math.max(0.01, msg.place.h));
  rect.name = `${frame.name} crop ${msg.out.w}×${msg.out.h}`;
  rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];

  // Drop it into the frame: append as the top child (rendered on top), positioned by the crop's
  // frame-relative offset. FRAME/COMPONENT use child-relative coordinates, so msg.place maps
  // directly. Containers we can't append into (INSTANCE, SECTION, …) get the result as a sibling
  // sitting on top instead.
  const canAppend = frame.type === "FRAME" || frame.type === "COMPONENT";
  if (canAppend) {
    frame.appendChild(rect);
    // Ignore any auto-layout flow so x/y are honoured.
    if (frame.layoutMode && frame.layoutMode !== "NONE")
      rect.layoutPositioning = "ABSOLUTE";
    rect.x = msg.place.x;
    rect.y = msg.place.y;
  } else {
    const parent = frame.parent || figma.currentPage;
    rect.x = frame.x + msg.place.x;
    rect.y = frame.y + msg.place.y;
    const idx = parent.children.indexOf(frame);
    if (idx >= 0) parent.insertChild(idx + 1, rect);
    else parent.appendChild(rect);
  }

  // Leave the frame selected (not the new layer) so the plugin can stay open for another crop
  // without our own selection change hijacking the target frame.
  figma.notify(`Cropped ${msg.out.w}×${msg.out.h}px`);
  figma.ui.postMessage({ type: "done", out: msg.out });
};
