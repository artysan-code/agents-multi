// Tests for the console's interface: whether its build is current (ui.ts) and what the console serves of it.
import { assertEquals } from "@std/assert";
import { uiState } from "../ui.ts";
import { uiFile } from "../console/http.ts";

Deno.test("uiState: no build, a build of another tree, a build of this one", () => {
  assertEquals(uiState(null, "abc"), "missing");
  assertEquals(uiState("old\n", "abc"), "stale");
  assertEquals(uiState("abc\n", "abc"), "built");
});

Deno.test("uiState: a page built without the stamp is there, from unknown code", () => {
  assertEquals(uiState(null, "abc", true), "unstamped");
  assertEquals(uiState(null, "abc", false), "missing");
  assertEquals(uiState("abc\n", "abc", true), "built");
});

Deno.test("uiFile: the page, its hashed assets, nothing else; a missing build says how to build", async () => {
  const dist = await Deno.makeTempDir();
  try {
    assertEquals((await uiFile(dist, "/")).status, 503);
    await Deno.mkdir(`${dist}/assets`);
    await Deno.writeTextFile(`${dist}/index.html`, "<!doctype html>");
    await Deno.writeTextFile(`${dist}/assets/index-Ab1_.js`, "x");
    await Deno.writeTextFile(`${dist}/.source`, "tree");
    const page = await uiFile(dist, "/index.html");
    assertEquals([page.status, page.headers.get("cache-control")], [200, "no-cache"]);
    await page.body?.cancel();
    const js = await uiFile(dist, "/assets/index-Ab1_.js");
    assertEquals([js.status, js.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    await js.body?.cancel();
    for (const p of ["/.source", "/assets/../index.html", "/assets/a.exe", "/other.js"]) {
      const r = await uiFile(dist, p);
      assertEquals(r.status, 404, p);
      await r.body?.cancel();
    }
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
