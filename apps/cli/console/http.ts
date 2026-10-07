// http.ts — what every console route shares: JSON responses, the local-host guard, the anti-CSRF
// header on writes, and the page's static files.

import { readText } from "../lib/fs.ts";

/** A JSON response that is never cached. */
export function json(v: unknown, code = 200): Response {
  return new Response(JSON.stringify(v), {
    status: code,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** A JSON body already serialised, never cached. */
export function jsonText(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * Whether the request names a local host. A web page whose name resolves to 127.0.0.1 would be
 * same-origin with the console (DNS rebinding) and the anti-CSRF header would not stop it, so only
 * local names are served — on any port, so an ssh tunnel on another local port still works.
 */
export function isLocalHost(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  return ["127.0.0.1", "localhost", "[::1]"].includes(host);
}

/** Whether a write carries the console's anti-CSRF header, which a cross-site form cannot set. */
export function hasCsrfHeader(req: Request): boolean {
  return req.headers.get("x-claude-multi") === "1";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A file of the page under `dir`: the fonts as immutable bytes, the rest as text revalidated on
 * each load. Only flat names (and vendor/) are served; anything else is a 404.
 */
export async function staticFile(dir: string, pathname: string): Promise<Response> {
  const font = pathname.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
  if (font) {
    const bytes = await Deno.readFile(`${dir}/fonts/${font[1]}`).catch(() => null);
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes, {
      headers: { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" },
    });
  }
  const path = pathname === "/" ? "/index.html" : pathname;
  // the page's files, and the libraries it carries in vendor/ (no CDN: the console works offline)
  if (!/^\/(vendor\/)?[a-z0-9_.-]+$/i.test(path)) return new Response("not found", { status: 404 });
  const ext = path.slice(path.lastIndexOf("."));
  const body = await readText(`${dir}${path}`);
  if (body === null || !MIME[ext]) return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "content-type": MIME[ext], "cache-control": "no-cache" } });
}

/**
 * A file of the console's interface, from its build in `dist`: the page itself revalidated on each
 * load, its hashed assets immutable. A console whose interface is not built says how to build it, and
 * where the old one still is.
 */
export async function uiFile(dist: string, pathname: string): Promise<Response> {
  const rest = pathname.replace(/^\//, "");
  if (rest === "" || rest === "index.html") {
    const page = await readText(`${dist}/index.html`);
    if (page === null) {
      return new Response(
        "The console's interface is not built: run `agents ui build`. The old one is at /old/.",
        {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    return new Response(page, { headers: { "content-type": MIME[".html"], "cache-control": "no-cache" } });
  }
  const m = rest.match(/^assets\/[a-zA-Z0-9_-]+(\.[a-z0-9]+)$/);
  const type = m && (MIME[m[1]] ?? (m[1] === ".woff2" ? "font/woff2" : undefined));
  if (!type) return new Response("not found", { status: 404 });
  const bytes = await Deno.readFile(`${dist}/${rest}`).catch(() => null);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "max-age=31536000, immutable" } });
}
