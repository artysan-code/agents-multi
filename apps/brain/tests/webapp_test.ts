// Tests for the web app's serving (webapp.ts): a path stays inside the build, the page is the fallback for the
// app's own routes but never for a missing file, the cache headers follow the file, and the page needs the session.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { isWebPath, loadWebapp, webAnswer, webCache, webLookup, webPath } from "../webapp.ts";

Deno.test("webapp: only /app and below are the app's, and a path never leaves the build", () => {
  assert(isWebPath("/app") && isWebPath("/app/") && isWebPath("/app/assets/a.js"));
  assert(!isWebPath("/application") && !isWebPath("/apps/x") && !isWebPath("/"));
  assertEquals(webPath("/app"), "index.html");
  assertEquals(webPath("/app/"), "index.html");
  assertEquals(webPath("/app/assets/web-1.js"), "assets/web-1.js");
  assertEquals(webPath("/app/chat/abc"), "chat/abc");
  assertEquals(webPath("/app/sub/"), "index.html");
  assertEquals(webPath("/application"), null);
  for (
    const p of [
      "/app/../accounts.db",
      "/app/%2e%2e/accounts.db",
      "/app/a/../../x",
      "/app/./x",
      "/app/%2e%2e%2f",
      "/app/a%00b",
      "/app/..%5cx",
      "/app/%E0%A4%A",
    ]
  ) assertEquals(webPath(p), null, p);
});

Deno.test("webapp: hashed files are kept for a year, the page and the worker never, the rest revalidated", () => {
  assertEquals(webCache("assets/web-C6GrvuKC.js"), "public, max-age=31536000, immutable");
  assertEquals(webCache("index.html"), "no-store");
  assertEquals(webCache("sw.js"), "no-store");
  assertEquals(webCache("manifest.webmanifest"), "no-cache");
  assertEquals(webCache("icons/icon-192.png"), "no-cache");
});

async function build() {
  const root = await Deno.makeTempDir();
  const dir = `${root}/build`;
  await Deno.mkdir(`${dir}/assets`, { recursive: true });
  await Deno.mkdir(`${dir}/icons`);
  await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html><title>app</title>");
  await Deno.writeTextFile(`${dir}/sw.js`, "self.skipWaiting()");
  await Deno.writeTextFile(`${dir}/manifest.webmanifest`, "{}");
  await Deno.writeTextFile(`${dir}/assets/web-abc.js`, "export {}");
  await Deno.writeFile(`${dir}/icons/icon-192.png`, new Uint8Array([137, 80, 78, 71]));
  // a file beside the build is not part of it
  await Deno.writeTextFile(`${root}/webapp-secret.txt`, "no");
  return { dir, root, files: await loadWebapp(dir) };
}
const get = (path: string, init: RequestInit = {}) => new Request(`https://b.test${path}`, init);
const yes = () => Promise.resolve(true), no = () => Promise.resolve(false);

Deno.test("webapp: the build is read once; a file is its path, the page is the fallback, a missing file is missing", async () => {
  const { dir, root, files } = await build();
  try {
    assertEquals([...files.keys()].sort(), [
      "assets/web-abc.js",
      "icons/icon-192.png",
      "index.html",
      "manifest.webmanifest",
      "sw.js",
    ]);
    assertEquals(webLookup(files, "/app/assets/web-abc.js")?.rel, "assets/web-abc.js");
    assertEquals(webLookup(files, "/app")?.rel, "index.html");
    assertEquals(webLookup(files, "/app/chat/abc")?.rel, "index.html"); // the app routes by hash
    assertEquals(webLookup(files, "/app/assets/web-old.js"), null); // a stale hashed name is not the page
    assertEquals(webLookup(files, "/app/nothing.png"), null);
    assertEquals(webLookup(files, "/app/../webapp-secret.txt"), null);
    assertEquals(webLookup(files, "/site"), null);
    assertEquals((await loadWebapp(`${dir}/not-built`)).size, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("webapp: headers, ETags and 304 for a file; the page is never revalidated", async () => {
  const { root, files } = await build();
  try {
    const js = await webAnswer(files, get("/app/assets/web-abc.js"), yes);
    assertEquals(js.status, 200);
    assertEquals(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assertEquals(js.headers.get("x-content-type-options"), "nosniff");
    const etag = js.headers.get("etag")!;
    assert(etag.startsWith('"'));
    await js.body?.cancel();
    const again = await webAnswer(files, get("/app/assets/web-abc.js", { headers: { "if-none-match": etag } }), yes);
    assertEquals(again.status, 304);
    assertEquals(again.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const man = await webAnswer(files, get("/app/manifest.webmanifest"), no); // the browser fetches it without the cookie
    assertEquals(man.status, 200);
    assertEquals(man.headers.get("content-type"), "application/manifest+json");
    await man.body?.cancel();
    const sw = await webAnswer(files, get("/app/sw.js"), no);
    assertEquals(sw.status, 200);
    assertEquals(sw.headers.get("cache-control"), "no-store");
    await sw.body?.cancel();

    const page = await webAnswer(files, get("/app/", { headers: { "if-none-match": "*" } }), yes);
    assertEquals(page.status, 200);
    assertEquals(page.headers.get("cache-control"), "no-store");
    assertStringIncludes(page.headers.get("content-security-policy")!, "script-src 'self'");
    assertStringIncludes(page.headers.get("content-security-policy")!, "frame-ancestors 'none'");
    assertEquals(page.headers.get("x-frame-options"), "DENY");
    assertStringIncludes(await page.text(), "<title>app</title>");

    const head = await webAnswer(files, get("/app", { method: "HEAD" }), yes);
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("webapp: the page sends a signed-out visitor to the sign-in, the files and other methods do not", async () => {
  const { root, files } = await build();
  try {
    for (const p of ["/app", "/app/", "/app/chat/abc"]) {
      const r = await webAnswer(files, get(p), no);
      assertEquals(r.status, 303, p);
      assertEquals(r.headers.get("location"), "/account?next=/app");
      assertEquals(r.headers.get("cache-control"), "no-store");
    }
    assertEquals((await webAnswer(files, get("/app/assets/nothing.js"), no)).status, 404);
    const post = await webAnswer(files, get("/app", { method: "POST", body: "x" }), yes);
    assertEquals(post.status, 405);
    assertEquals(post.headers.get("allow"), "GET, HEAD");
    // an app that is not built answers 404, never a redirect to a page that does not exist
    assertEquals((await webAnswer(new Map(), get("/app"), no)).status, 404);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
