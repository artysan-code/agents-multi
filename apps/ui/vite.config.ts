// The console's new interface, served by `agents-multi serve` under /next while the pages move over
// from apps/cli/dashboard. `pnpm dev` serves it with hot reload and sends /api to the running console.
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "/next/",
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // the shared style sheet and its fonts live in apps/cli/dashboard
    fs: { allow: [".."] },
    proxy: { "/api": "http://127.0.0.1:7331", "/claude": "http://127.0.0.1:7331" },
  },
});
