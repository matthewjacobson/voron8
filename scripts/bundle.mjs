// Bundle the TypeScript API together with the single-file wasm module into one
// ESM file at dist/voron8.js, and emit type declarations alongside it.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(root, "dist/voron8.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2020",
  // The wasm core already inlines its binary as base64 (SINGLE_FILE); bundling
  // it here yields one self-contained file with no external assets to host.
  loader: { ".js": "js" },
  // Emscripten's Node code path pulls in node built-ins. Keep them external so
  // they resolve at runtime under Node and are simply never touched in browsers.
  external: ["module", "fs", "path", "url", "crypto", "worker_threads", "node:*"],
});

// esbuild does not emit declarations — let tsc produce them.
execFileSync(
  "npx",
  ["tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist",
   "--module", "esnext", "--moduleResolution", "bundler",
   "--target", "es2020", "--skipLibCheck", "src/index.ts"],
  { cwd: root, stdio: "inherit" },
);

console.log("Built dist/voron8.js and dist/voron8.d.ts");
