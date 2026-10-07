// Tests for the console's new interface: whether its build is current (ui.ts) and what /next serves.
import { assertEquals } from "@std/assert";
import { uiState } from "../ui.ts";
import { nextFile } from "../console/http.ts";

Deno.test("uiState: no build, a build of another tree, a build of this one", () => {
  assertEquals(uiState(null, "abc"), "missing");
  assertEquals(uiState("old\n", "abc"), "stale");
  assertEquals(uiState("abc\n", "abc"), "built");
});

Deno.test("nextFile: the page, its hashed assets, nothing else; a missing build says how to build", async () => {
  const dist = await Deno.makeTempDir();
  try {
    assertEquals((await nextFile(dist, "/next/")).status, 503);
    await Deno.mkdir(`${dist}/assets`);
    await Deno.writeTextFile(`${dist}/index.html`, "<!doctype html>");
    await Deno.writeTextFile(`${dist}/assets/index-Ab1_.js`, "x");
    await Deno.writeTextFile(`${dist}/.source`, "tree");
    const page = await nextFile(dist, "/next");
    assertEquals([page.status, page.headers.get("cache-control")], [200, "no-cache"]);
    await page.body?.cancel();
    const js = await nextFile(dist, "/next/assets/index-Ab1_.js");
    assertEquals([js.status, js.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    await js.body?.cancel();
    for (const p of ["/next/.source", "/next/assets/../index.html", "/next/assets/a.exe", "/next/other.js"]) {
      const r = await nextFile(dist, p);
      assertEquals(r.status, 404, p);
      await r.body?.cancel();
    }
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
