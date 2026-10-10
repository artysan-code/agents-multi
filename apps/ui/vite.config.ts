// The console's interface, served by `agents serve` at its root. `pnpm dev` serves it with hot
// reload and sends /api to the running console.
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";

const port = Number(process.env.AGENTS_MULTI_PORT) || 7331;
const target = `http://127.0.0.1:${port}`;

/** The console's token (apps/cli/console/token.ts): its file is in the folder of the app's socket. Read
 *  at each request, because a console that restarts has a new one. */
function consoleToken(): string | undefined {
  const dir = process.env.XDG_RUNTIME_DIR ||
    `${process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`}/agents-multi`;
  try {
    return readFileSync(`${dir}/agents-multi-console${port === 7331 ? "" : `.${port}`}.token`, "utf8").trim();
  } catch {
    return undefined; // no console running, or one from before the token
  }
}

/** Gives the requests the dev server proxies to the console its token: the dev page, on another
 *  origin, cannot hold the console's cookie. Runs before the proxy, which forwards the headers. */
const consoleAccess: Plugin = {
  name: "console-access",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const token = consoleToken();
      // (vite types its requests with Node's, which are not a dependency here)
      if (token) (req as unknown as { headers: Record<string, string> }).headers["x-agents-token"] = token;
      next();
    });
  },
};

export default defineConfig({
  base: "/",
  plugins: [preact(), consoleAccess],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": target, "/claude": target },
  },
});
