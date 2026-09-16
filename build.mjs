// build.mjs — bundles the two halves of the plugin with esbuild.
//   • src/main.js          → dist/main.js   (the Figma sandbox code)
//   • src/ui/ui.js + deps  → inlined into dist/ui.html (Figma requires a single self-contained
//                            HTML file; png-tools is bundled straight in).
// Run `node build.mjs` for a one-shot production build, or `--watch` to rebuild on change.

import * as esbuild from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const root = new URL("./", import.meta.url);
const p = (rel) => new URL(rel, root).pathname;

await mkdir(p("dist"), { recursive: true });

const shared = {
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
};

// UI: build to memory, then inline the JS into the HTML template.
const inlineHTMLPlugin = {
  name: "inline-html",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.outputFiles?.length) return;
      const js = result.outputFiles[0].text;
      const html = await readFile(p("src/ui/index.html"), "utf8");
      await writeFile(
        p("dist/ui.html"),
        html.replace("<!--INLINE_SCRIPT-->", `<script>\n${js}\n</script>`),
      );
      console.log("built dist/ui.html");
    });
  },
};

const uiCtx = await esbuild.context({
  ...shared,
  entryPoints: [p("src/ui/ui.js")],
  write: false,
  plugins: [inlineHTMLPlugin],
});

const mainCtx = await esbuild.context({
  ...shared,
  entryPoints: [p("src/main.js")],
  outfile: p("dist/main.js"),
});

if (watch) {
  await Promise.all([uiCtx.watch(), mainCtx.watch()]);
  console.log("watching for changes…");
} else {
  await Promise.all([uiCtx.rebuild(), mainCtx.rebuild()]);
  await Promise.all([uiCtx.dispose(), mainCtx.dispose()]);
}
