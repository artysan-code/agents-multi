// Tests for the update manifests read from `release` (manifests.ts): only the two channels, kept a
// minute, the last good copy while the source is down, and nothing (the image's copy) otherwise.
import { assertEquals } from "jsr:@std/assert@1";
import { isManifest, liveManifests } from "../manifests.ts";

const body = (v: string) => JSON.stringify({ version: v, platforms: {} });

function source(answers: (string | Error | number)[]) {
  const urls: string[] = [];
  const get = (url: string) => {
    urls.push(url);
    const a = answers.shift();
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === "number") return Promise.resolve(new Response("", { status: a }));
    return Promise.resolve(new Response(a ?? ""));
  };
  return { get, urls };
}

Deno.test("isManifest: a JSON object with a version", () => {
  assertEquals(isManifest(body("1.0.0")), true);
  assertEquals(isManifest("<html>"), false);
  assertEquals(isManifest(JSON.stringify({ version: "" })), false);
  assertEquals(isManifest("null"), false);
});

Deno.test("liveManifests: the channel from the source, kept a minute, then read again", async () => {
  let t = 0;
  const s = source([body("1.0.0-beta.11"), body("1.0.0-beta.12")]);
  const live = liveManifests("https://raw.test/updates/", s.get, () => t);
  assertEquals(await (await live("/updates/beta.json"))!.text(), body("1.0.0-beta.11"));
  t = 30_000;
  assertEquals(await (await live("/updates/beta.json"))!.text(), body("1.0.0-beta.11"));
  t = 61_000;
  assertEquals(await (await live("/updates/beta.json"))!.text(), body("1.0.0-beta.12"));
  assertEquals(s.urls, ["https://raw.test/updates/beta.json", "https://raw.test/updates/beta.json"]);
});

Deno.test("liveManifests: the last good copy while the source fails, the image's when there is none", async () => {
  let t = 0;
  const s = source([body("1.0.0"), new Error("down"), 404, "<html>"]);
  const live = liveManifests("https://raw.test/updates", s.get, () => t);
  await live("/updates/stable.json");
  t = 61_000;
  assertEquals(await (await live("/updates/stable.json"))!.text(), body("1.0.0"));
  assertEquals(await live("/updates/beta.json"), null); // 404: the image's copy
  assertEquals(await live("/updates/beta.json"), null); // not a manifest
});

Deno.test("liveManifests: nothing but the two channels, GET and HEAD", async () => {
  const s = source([body("1.0.0")]);
  const live = liveManifests("https://raw.test/updates", s.get);
  assertEquals(await live("/updates/nightly.json"), null);
  assertEquals(await live("/index.html"), null);
  assertEquals(await live("/updates/stable.json", "POST"), null);
  const head = await live("/updates/stable.json", "HEAD");
  assertEquals(head!.body, null);
  assertEquals(s.urls.length, 1);
});
