import {build} from "esbuild";
import {execFileSync} from "node:child_process";
import {rmSync} from "node:fs";

rmSync("dist", {recursive: true, force: true});
await build({
  entryPoints: ["src/index.ts", "src/geometry.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  minify: true,
  splitting: true,
});
execFileSync("./node_modules/.bin/tsc", ["-p", "tsconfig.build.json"], {stdio: "inherit"});
