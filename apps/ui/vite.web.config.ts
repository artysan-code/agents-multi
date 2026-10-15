// The web app (ADR 0014): a second entry of this package, served by the brain under /app. Built with
// `pnpm exec vite build --config vite.web.config.ts` into dist-web (the brain's image does it; apps/brain/webapp.ts
// serves it). The page is web.html here and index.html in the build, which is what the service answers /app with.
import { renameSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";

const asIndex: Plugin = {
  name: "web-as-index",
  writeBundle(options) {
    renameSync(`${options.dir}/web.html`, `${options.dir}/index.html`);
  },
};

export default defineConfig({
  base: "/app/",
  plugins: [preact(), asIndex],
  // the manifest, the icons and the service worker (sw.js: the one file that cannot carry a hash in its name)
  publicDir: "web-public",
  build: { outDir: "dist-web", emptyOutDir: true, rollupOptions: { input: "web.html" } },
});
