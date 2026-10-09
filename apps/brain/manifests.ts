// manifests.ts — the desktop app's update manifests as the `release` branch holds them now, for site.ts.
// The release workflow writes them there (scripts/app-release.ts); read from there at a request, a
// release no longer redeploys the site for them, and the site can run an image built from other code
// than `release` (the beta's, which has site.ts). The copy built into the image stays the fallback:
// when the source does not answer, or answers something that is not a manifest, the site serves its own.

const CHANNEL = /^\/updates\/(stable|beta)\.json$/;
/** How long a manifest read is kept: a release shows up within a minute, the source is asked at most
 *  once a minute per channel. */
const TTL_MS = 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Pure: whether a body is an update manifest (the version Tauri's updater reads first). */
export function isManifest(text: string): boolean {
  try {
    const o = JSON.parse(text);
    return !!o && typeof o === "object" && typeof o.version === "string" && !!o.version;
  } catch {
    return false;
  }
}

/** Answers a channel's manifest from `base` (the directory holding stable.json and beta.json), or null
 *  for any other path, and when there is nothing good to answer: then the image's own copy is served.
 *  A copy read before is served again while the source is unreachable. */
export function liveManifests(base: string, get: Fetch = fetch, now = Date.now) {
  const kept = new Map<string, { text: string; at: number }>();
  const read = async (name: string): Promise<string | null> => {
    const k = kept.get(name);
    if (k && now() - k.at < TTL_MS) return k.text;
    try {
      const r = await get(`${base.replace(/\/+$/, "")}/${name}.json`, { signal: AbortSignal.timeout(5000) });
      const text = r.ok ? await r.text() : "";
      if (isManifest(text)) {
        kept.set(name, { text, at: now() });
        return text;
      }
    } catch { /* unreachable: what was read before, or the image's copy */ }
    return k?.text ?? null;
  };
  return async (pathname: string, method = "GET"): Promise<Response | null> => {
    const m = CHANNEL.exec(pathname);
    if (!m || (method !== "GET" && method !== "HEAD")) return null;
    const text = await read(m[1]);
    if (text === null) return null;
    return new Response(method === "HEAD" ? null : text, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
