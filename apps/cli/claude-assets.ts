// claude-assets.ts — Claude's own faces, read from the Claude Desktop installed on this machine, never
// copied into the repository: they are Anthropic's, licensed with the app. The console uses them when
// they are there and falls back to its own (fonts/) when they are not, or when an update moves them
// where this cannot find them. (Its spark and icon font are Anthropic's marks: the console shows its own.)
//
// Desktop ships the claude.ai front end under resources/ion-dist with hashed names, so nothing is
// looked up by name: index.html lists the stylesheets, and the stylesheets declare the faces.

import { LIB } from "./lib/paths.ts";

interface ClaudeAssets {
  dist: string;
  faces: { family: string; style: string; file: string }[];
}

const FAMILIES = /^anthropic-(sans|serif|mono)$/;

async function ionDist(): Promise<string | null> {
  const root = `${LIB}/claude-desktop`;
  const cands = [`${root}/current/resources/ion-dist`];
  try {
    const vs: string[] = [];
    for await (const e of Deno.readDir(`${root}/versions`)) vs.push(e.name);
    vs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    cands.push(...vs.map((v) => `${root}/versions/${v}/resources/ion-dist`));
  } catch { /* no versions directory */ }
  for (const c of cands) {
    try {
      await Deno.stat(`${c}/index.html`);
      return await Deno.realPath(c);
    } catch { /* next */ }
  }
  return null;
}

/** Pure: the faces a stylesheet declares for the families above. */
export function facesIn(css: string): { family: string; style: string; url: string }[] {
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*([^;]+)/.exec(m[1])?.[1].replace(/['"]/g, "").trim();
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(m[1])?.[1];
    const style = /font-style:\s*(\w+)/.exec(m[1])?.[1] ?? "normal";
    if (family && url && FAMILIES.test(family)) out.push({ family, style, url });
  }
  return out;
}

async function resolve(): Promise<ClaudeAssets | null> {
  const dist = await ionDist();
  if (!dist) return null;
  const html = await Deno.readTextFile(`${dist}/index.html`);
  const faces: ClaudeAssets["faces"] = [];
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) {
    const href = m[1].replace(/^\//, "");
    const css = await Deno.readTextFile(`${dist}/${href}`).catch(() => "");
    const base = href.slice(0, href.lastIndexOf("/") + 1);
    for (const f of facesIn(css)) {
      const rel = f.url.startsWith("/") ? f.url.slice(1) : `${base}${f.url}`;
      if (!faces.some((x) => x.family === f.family && x.style === f.style)) {
        faces.push({ family: f.family, style: f.style, file: `${dist}/${rel}` });
      }
    }
  }
  return { dist, faces };
}

let cached: Promise<ClaudeAssets | null> | null = null;
/** Resolved once per server start: a Desktop update restarts nothing, so it is checked again
 *  when a face it found has gone. */
export async function claudeAssets(): Promise<ClaudeAssets | null> {
  cached ??= resolve().catch(() => null);
  const a = await cached;
  if (a && a.faces[0] && !(await Deno.stat(a.faces[0].file).then(() => true, () => false))) {
    cached = resolve().catch(() => null);
    return await cached;
  }
  return a;
}

/** The page's view of them: a stylesheet of faces, and each face's file. */
export async function assetsApi(u: URL): Promise<Response | null> {
  const p = u.pathname;
  if (!p.startsWith("/claude/")) return null;
  const a = await claudeAssets();
  if (p === "/claude/faces.css") {
    const css = (a?.faces ?? []).map((f, i) =>
      `@font-face{font-family:"${f.family}";src:url(/claude/face/${i}) format("woff2");font-style:${f.style};font-weight:300 800;font-display:swap}`
    ).join("\n");
    return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
  }
  const face = p.match(/^\/claude\/face\/(\d+)$/);
  if (face) {
    const f = a?.faces[Number(face[1])];
    const bytes = f ? await Deno.readFile(f.file).catch(() => null) : null;
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes, { headers: { "content-type": "font/woff2", "cache-control": "max-age=86400" } });
  }
  return new Response("not found", { status: 404 });
}
