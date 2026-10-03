// Tests for shared/hooks/cloudflare-guard.ts: reads pass, deletions never, the rest asks.
import { assertEquals } from "jsr:@std/assert@1";
import { classify } from "../../shared/hooks/cloudflare-guard.ts";

const call = (opts: string) => `async () => { const r = await cloudflare.request(${opts}); return r.result; }`;

Deno.test("classify: reads pass without a question — GET, HEAD, or no method at all", () => {
  assertEquals(classify(call(`{ method: "GET", path: \`/zones/\${z}/dns_records\` }`)).decision, "allow");
  assertEquals(classify(call(`{ method: 'head', path: "/zones" }`)).decision, "allow");
  assertEquals(classify(call(`{ path: "/zones?name=artysan.me" }`)).decision, "allow");
});

Deno.test("classify: any deletion is denied, whatever spelling or shape", () => {
  assertEquals(classify(call(`{ method: "DELETE", path: "/zones/z/dns_records/r" }`)).decision, "deny");
  assertEquals(classify(call(`{ method: "delete", path: "/x" }`)).decision, "deny");
  // the DNS batch endpoint deletes through a body key
  assertEquals(classify(call(`{ method: "POST", path: "/zones/z/dns_records/batch", body: { deletes: [{ id: "r" }] } }`)).decision, "deny");
});

Deno.test("classify: writes and methods it cannot read ask first", () => {
  assertEquals(classify(call(`{ method: "POST", path: "/zones/z/purge_cache", body: { files: ["https://a"] } }`)).decision, "ask");
  assertEquals(classify(call(`{ method: "PATCH", path: "/zones/z/dns_records/r", body: { proxied: true } }`)).decision, "ask");
  // a computed method could be anything
  assertEquals(classify(`const m = pick(); ${call("{ method: m, path: '/x' }")}`).decision, "ask");
  assertEquals(classify(`const method = "PUT"; ${call("{ method, path: '/x' }")}`).decision, "ask");
  // one write among reads is still a write
  assertEquals(classify(`${call(`{ method: "GET", path: "/a" }`)}; ${call(`{ method: "PUT", path: "/b" }`)}`).decision, "ask");
});
