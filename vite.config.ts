import {defineConfig} from "vite";

export default defineConfig({
  root: "demo",
  base: "./",
  build: {outDir: "../github-pages", emptyOutDir: true},
  server: {host: true},
});
