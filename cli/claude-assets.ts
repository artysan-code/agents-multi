// claude-assets.ts — Claude's own faces, icons and spark, read from the Claude Desktop installed on
// this machine, never copied into the repository: they are Anthropic's, licensed with the app.
// The console uses them when they are there and falls back to its own (fonts/, inline icons, a
// still spark) when they are not, or when an update moves them where this cannot find them.
//
// Desktop ships the claude.ai front end under resources/ion-dist with hashed names, so nothing is
// looked up by name: index.html lists the stylesheets, the stylesheets declare the faces, the
// favicon is the spark, the animations are the module that starts `var e={thinking:{svg:`, and the
// icon font's code points are the `{icons:{Activity:` map in the shared frame bundle.

import { LIB } from "./lib.ts";

export interface Strip { svg: string; frameCount: number; speed: number }
export interface ClaudeAssets {
  dist: string;
  faces: { family: string; style: string; file: string }[];
  spark: string | null;
  strips: Record<string, Strip>;
  icons: Record<string, number>;
}

const FAMILIES = /^(anthropic-(sans|serif|mono)|Anthropicons-Variable)$/;

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

/** Pure: the spark animations out of their module's source. */
export function stripsIn(js: string): Record<string, Strip> {
  const out: Record<string, Strip> = {};
  for (const m of js.matchAll(/(\w+):\{svg:'([^']*)',width:\d+,height:\d+,frameCount:(\d+),speed:(\d+)\}/g)) {
    out[m[1]] = { svg: m[2], frameCount: Number(m[3]), speed: Number(m[4]) };
  }
  return out;
}

/** Pure: the icon font's name → code point map out of the bundle that declares it. */
export function iconsIn(js: string): Record<string, number> {
  const i = js.indexOf("{icons:{Activity:");
  if (i < 0) return {};
  const end = js.indexOf("}", i + 8);
  return Object.fromEntries([...js.slice(i + 8, end).matchAll(/(\w+):(\d+)/g)].map((m) => [m[1], Number(m[2])]));
}

async function head(path: string, n: number): Promise<string> {
  const f = await Deno.open(path);
  try {
    const buf = new Uint8Array(n);
    const r = await f.read(buf);
    return new TextDecoder().decode(buf.subarray(0, r ?? 0));
  } finally { f.close(); }
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
      if (!faces.some((x) => x.family === f.family && x.style === f.style)) faces.push({ family: f.family, style: f.style, file: `${dist}/${rel}` });
    }
  }
  const icon = /<link[^>]*rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
  const spark = icon ? await Deno.readTextFile(`${dist}/${icon.replace(/^\//, "")}`).catch(() => null) : null;

  let strips: Record<string, Strip> = {}, icons: Record<string, number> = {};
  const v1 = `${dist}/assets/v1`;
  for await (const e of Deno.readDir(v1)) {
    if (!e.isFile || !e.name.endsWith(".js")) continue;
    if (!Object.keys(strips).length && (await head(`${v1}/${e.name}`, 24)).startsWith("var e={thinking:{svg:")) {
      strips = stripsIn(await Deno.readTextFile(`${v1}/${e.name}`));
    }
    if (!Object.keys(icons).length && e.name.startsWith("shared-frame-")) icons = iconsIn(await Deno.readTextFile(`${v1}/${e.name}`));
  }
  return { dist, faces, spark: spark && /^<svg[\s>]/.test(spark.trim()) ? spark.trim() : null, strips, icons };
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

/** The page's view of them: a stylesheet of faces, and the spark, its animations and the icons. */
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
  if (p === "/claude/assets.json") {
    return new Response(JSON.stringify({
      found: !!a,
      spark: a?.spark ?? null,
      strips: a?.strips ?? {},
      icons: a?.icons ?? {},
      iconFont: !!a?.faces.some((f) => f.family === "Anthropicons-Variable"),
    }), { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
  }
  return new Response("not found", { status: 404 });
}
