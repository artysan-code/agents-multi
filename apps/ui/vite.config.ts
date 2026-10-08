// The console's interface, served by `agents serve` at its root. `pnpm dev` serves it with hot
// reload and sends /api to the running console.
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "/",
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://127.0.0.1:7331", "/claude": "http://127.0.0.1:7331" },
  },
});
