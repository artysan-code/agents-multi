// token.ts — who may talk to the console. It listens on 127.0.0.1, where any process of the machine can
// reach it, so every request but a short allowlist carries a secret that only this user's files hold:
//
//   * a random token per start, written to a file only the user can read (`tokenPath`), removed when the
//     console stops cleanly. The CLI, the tray and the dev server read it and send it as `x-agents-token`.
//   * the page gets it as the HttpOnly, SameSite=Strict cookie `agents_token`, by a bootstrap: GET /?k=…
//     with the token (the desktop app reads it from the file) or with a ticket (below) sets the cookie
//     and redirects to the same page without `k`, so neither is left in the history.
//   * a ticket is a one-use key valid for a minute, for the one case where the key goes through an
//     argument list others can read (`xdg-open <url>` in `agents serve`): it opens the page once and is
//     worth nothing after.
//
// The decision is `gate`, pure over a request's parts; createHandler (server.ts) acts on it.

import { writeAtomic } from "../lib/fs.ts";

export const TOKEN_HEADER = "x-agents-token";
export const COOKIE = "agents_token";
const TICKET_MS = 60_000;

/** The paths anyone may GET: the liveness probe of the app, the doctor and the waiting page. It says
 *  which code runs, and does nothing. */
const PUBLIC = new Set(["/api/code"]);

/** 32 random bytes, base64url. */
export function newToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Constant time in the length of the longer value, so a mismatch says nothing about where it is. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Pure: a cookie's value in a `Cookie` header, or null. */
export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The `Set-Cookie` that gives the page the token. */
export function setCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

/** One-use keys for the page's first load (see the top). */
export class Tickets {
  #open = new Map<string, number>();
  issue(now = Date.now()): string {
    for (const [t, until] of this.#open) if (until <= now) this.#open.delete(t);
    const t = b64url(crypto.getRandomValues(new Uint8Array(16)));
    this.#open.set(t, now + TICKET_MS);
    return t;
  }
  /** True once per ticket, and only while it lasts. */
  redeem(t: string, now = Date.now()): boolean {
    const until = this.#open.get(t);
    this.#open.delete(t);
    return until !== undefined && until > now;
  }
}

export interface Auth {
  token: string;
  tickets: Tickets;
}

export type Verdict =
  | { kind: "pass" }
  /** a valid key on the page's root: set the cookie and go to `to`, the same page without the key */
  | { kind: "enter"; to: string }
  | { kind: "refuse"; api: boolean };

/** Pure: whether a request may proceed. HEAD counts as GET. */
export function gate(
  req: { method: string; url: URL; headers: Pick<Headers, "get"> },
  auth: Auth,
): Verdict {
  const { url, headers } = req, read = req.method === "GET" || req.method === "HEAD";
  if (read && PUBLIC.has(url.pathname)) return { kind: "pass" };
  const k = url.searchParams.get("k");
  if (read && url.pathname === "/" && k && (sameSecret(k, auth.token) || auth.tickets.redeem(k))) {
    const rest = new URLSearchParams(url.searchParams);
    rest.delete("k");
    const q = rest.toString();
    return { kind: "enter", to: `/${q ? `?${q}` : ""}` };
  }
  const given = headers.get(TOKEN_HEADER) ?? cookieValue(headers.get("cookie"), COOKIE);
  if (given && sameSecret(given, auth.token)) return { kind: "pass" };
  return { kind: "refuse", api: url.pathname.startsWith("/api/") };
}

/** What a browser without the key sees: no interface, and where to get in. */
export const NO_ACCESS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agents Multi</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px}code{font-family:ui-monospace,monospace}</style>
</head><body>
<h1>Agents Multi</h1>
<p>This console is private to the person who started it. Open it from the Agents Multi app,
or with <code>agents serve</code>.</p>
<p lang="it">Questa console è privata. Aprila dall'app Agents Multi, oppure con <code>agents serve</code>.</p>
</body></html>
`;

/** The response to a verdict that is not `pass`. */
export function answer(v: Exclude<Verdict, { kind: "pass" }>, token: string): Response {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (v.kind === "enter") {
    return new Response(null, { status: 303, headers: { ...headers, location: v.to, "set-cookie": setCookie(token) } });
  }
  if (v.api) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...headers, "content-type": "application/json" },
    });
  }
  return new Response(NO_ACCESS_PAGE, {
    status: 401,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

// --- where the token lives

/** The private folder of the console's local files: the runtime folder, else the app's state folder.
 *  The app's socket and the token share it (appSocket in app-update.ts; updater/socket.rs). */
export function privateDir(env: Record<string, string | undefined> = Deno.env.toObject()): string {
  return env.XDG_RUNTIME_DIR || `${env.XDG_STATE_HOME || `${env.HOME ?? ""}/.local/state`}/agents-multi`;
}

/** The token file of the console on `port`: one per port, so a console on another port does not
 *  overwrite this one's (apps/desktop/src-tauri/src/token.rs names it the same). */
export function tokenPath(port: number, env: Record<string, string | undefined> = Deno.env.toObject()): string {
  return `${privateDir(env)}/agents-multi-console${port === 7331 ? "" : `.${port}`}.token`;
}

/** Writes the token where only the user reads it (the folder is made private when it is ours), and
 *  returns what removes it. */
export async function publishToken(path: string, token: string): Promise<() => void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  if (dir.endsWith("/agents-multi")) await Deno.chmod(dir, 0o700); // our own folder, never the runtime one
  await writeAtomic(path, token, { mode: 0o600 });
  return () => {
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  };
}
