// Bundle the TypeScript API together with the single-file wasm module into one
// ESM file at dist/voron8.js, and emit type declarations alongside it.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Shared between the ESM and UMD builds.
const common = {
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  target: "es2020",
  // The wasm core already inlines its binary as base64 (SINGLE_FILE); bundling
  // it here yields one self-contained file with no external assets to host.
  loader: { ".js": "js" },
  // Emscripten's Node code path pulls in node built-ins. Keep them external so
  // they resolve at runtime under Node and are simply never touched in browsers.
  external: ["module", "fs", "path", "url", "crypto", "worker_threads", "node:*"],
};

await build({
  ...common,
  outfile: resolve(root, "dist/voron8.js"),
  format: "esm",
});

// UMD build for `require()` and classic `<script>` tags. esbuild has no native
// UMD format, so we emit a CommonJS bundle and wrap it: the banner picks the
// AMD / CommonJS / browser-global path, then runs esbuild's `module.exports`
// code against a factory-local `module`. Under a browser global the wrapper
// assigns `window.voron8`; Emscripten's external `require()` calls live only
// inside its Node-detection branches, so they are never reached there.
//
// The same bytes are written twice: .js for browser/CDN <script> tags (CDNs
// serve .cjs with a non-JS MIME type — jsDelivr uses application/node — which
// blocks classic-script execution under X-Content-Type-Options: nosniff), and
// .cjs so Node treats it as CommonJS for the "require" export condition even
// though the package is "type": "module".
const umdBanner = `(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && typeof module.exports === "object") module.exports = factory();
  else root.voron8 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var module = { exports: {} };
  var exports = module.exports;
  // Emscripten reads import.meta.url to locate itself. There is no import.meta
  // in a CommonJS/global bundle, so supply an equivalent: this file's URL under
  // Node, the script src in a browser. (The wasm is inlined, so this only feeds
  // Emscripten's scriptDirectory bookkeeping.)
  var _umdMetaUrl =
    typeof document !== "undefined" && document.currentScript ? document.currentScript.src :
    typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href :
    typeof self !== "undefined" && self.location ? self.location.href : "/";`;

const umdFooter = `  return module.exports;
});`;

const umd = await build({
  ...common,
  outfile: resolve(root, "dist/voron8.umd.js"),
  format: "cjs",
  define: { "import.meta.url": "_umdMetaUrl" },
  banner: { js: umdBanner },
  footer: { js: umdFooter },
  write: false,
});
const umdCode = umd.outputFiles[0].text;
writeFileSync(resolve(root, "dist/voron8.umd.js"), umdCode);
writeFileSync(resolve(root, "dist/voron8.umd.cjs"), umdCode);

// esbuild does not emit declarations — let tsc produce them.
execFileSync(
  "npx",
  ["tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist",
   "--module", "esnext", "--moduleResolution", "bundler",
   "--target", "es2020", "--skipLibCheck", "src/index.ts"],
  { cwd: root, stdio: "inherit" },
);

console.log(
  "Built dist/voron8.js, dist/voron8.umd.js, dist/voron8.umd.cjs and dist/index.d.ts",
);
