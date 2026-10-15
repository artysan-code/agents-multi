// webapp.ts — the phone's face: the built web app (apps/ui, its second entry, built into dist-web) served
// under /app (ADR 0014). The files are read once and kept in memory, as the site's are (public.ts).
//
//   /app, /app/, any other path without a file extension   index.html (the app routes by hash)
//   /app/assets/…                                          hashed by the build: cached for a year
//   /app/sw.js, index.html                                 never cached: a new build reaches the phone at once
//   anything else the build made (manifest, icons)        revalidated with its ETag
//
// Only the page itself (index.html) needs the session: a signed-out visitor goes to the sign-in with
// next=/app. The rest is the same built code for everyone and holds nothing of an account, and the
// browser fetches the manifest and the service worker without the cookie, so gating them would break
// the install. Every call for data goes to /api, which answers only to a session or a token.

import { etagMatches } from "./public.ts";

interface WebEntry {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
  headers: Record<string, string>;
}

/** The built web app held in memory, path relative to its folder (`index.html`, `assets/…`) to file. */
export type WebFiles = Map<string, WebEntry>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

// the app's own code, its API and its fonts: nothing from elsewhere, and no framing
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'self'; form-action 'self'";

/** Pure: whether a request path belongs to the web app. */
export const isWebPath = (pathname: string) => pathname === "/app" || pathname.startsWith("/app/");

/** Pure: the file a path under /app asks for, relative to the build folder (`index.html` for the app's own
 *  address), or null when it is not under /app or tries to leave it. Whether the file exists is for the lookup. */
export function webPath(pathname: string): string | null {
  if (!isWebPath(pathname)) return null;
  let p: string;
  try {
    p = decodeURIComponent(pathname.slice("/app".length));
  } catch {
    return null;
  }
  if (p.includes("\0") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === ".")) return null;
  const rel = p.replace(/^\/+/, "");
  return rel === "" || rel.endsWith("/") ? "index.html" : rel;
}

/** Pure: how long a file may be kept. The names in assets/ are hashes of their content. */
export function webCache(rel: string): string {
  if (rel.startsWith("assets/")) return "public, max-age=31536000, immutable";
  if (rel === "index.html" || rel === "sw.js") return "no-store";
  return "no-cache";
}

async function* walk(dir: string, prefix = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(`${dir}/${prefix}`)) {
    if (e.isDirectory) yield* walk(dir, `${prefix}${e.name}/`);
    else if (e.isFile) yield `${prefix}${e.name}`;
  }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The built web app in `dir`, read once, with its headers and a strong ETag for each file. A folder that
 *  is not there (not built) is an empty app: /app then answers 404. */
export async function loadWebapp(dir: string): Promise<WebFiles> {
  const files: WebFiles = new Map();
  const rels: string[] = [];
  try {
    for await (const rel of walk(dir)) rels.push(rel);
  } catch { /* not built: nothing to serve */ }
  for (const rel of rels) {
    const bytes = await Deno.readFile(`${dir}/${rel}`);
    const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": webCache(rel),
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    };
    if (ext === "html") {
      headers["content-security-policy"] = CSP;
      headers["x-frame-options"] = "DENY";
    }
    files.set(rel, { bytes, headers, etag: `"${hex(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 32)}"` });
  }
  return files;
}

/** Bytes held by a loaded web app. */
export const webSize = (files: WebFiles) => [...files.values()].reduce((n, f) => n + f.bytes.byteLength, 0);

/** Pure: the file a request is answered with. A path with a file extension that is not in the build is
 *  missing (a stale hashed name must not be answered with the page, cached for a year as a script); any
 *  other path is the app's page. */
export function webLookup(files: WebFiles, pathname: string): { rel: string; file: WebEntry } | null {
  const want = webPath(pathname);
  if (want === null) return null;
  const direct = files.get(want);
  if (direct) return { rel: want, file: direct };
  if (/\.[a-z0-9]+$/i.test(want)) return null;
  const page = files.get("index.html");
  return page ? { rel: "index.html", file: page } : null;
}

/** The answer to a request under /app: the file, a 304 for one the browser already holds, the sign-in for the
 *  page when nobody is signed in, 404 for what is not in the build. `signedIn` is asked only for the page. */
export async function webAnswer(
  files: WebFiles,
  req: Request,
  signedIn: () => Promise<boolean>,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const hit = webLookup(files, new URL(req.url).pathname);
  if (!hit) return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
  if (hit.rel === "index.html" && !await signedIn()) {
    return new Response(null, {
      status: 303,
      headers: { location: "/account?next=/app", "cache-control": "no-store" },
    });
  }
  const headers = { ...hit.file.headers, etag: hit.file.etag };
  if (hit.rel !== "index.html" && etagMatches(req.headers.get("if-none-match"), hit.file.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(req.method === "HEAD" ? null : hit.file.bytes, { status: 200, headers });
}
