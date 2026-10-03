// Tests for shared/mcp/lib/owner.ts: whose setup it is, from the variables, the file, the defaults.
import { assertEquals } from "jsr:@std/assert@1";
import { owner, ownerFrom } from "../../shared/mcp/lib/owner.ts";
import { promptFor } from "../ask.ts";

Deno.test("ownerFrom: what is given, trimmed, the id in lower case; the rest from the defaults", () => {
  assertEquals(ownerFrom({ id: " Ann ", name: "Ann" }), { id: "ann", name: "Ann", language: "English" });
  assertEquals(ownerFrom(null), { id: "me", name: "the user", language: "English" });
  assertEquals(ownerFrom({ language: "  " }).language, "English");
});

Deno.test("owner: the variables win over the file, the file over the defaults", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/owner.json`, JSON.stringify({ id: "ann", name: "Ann", language: "Italian" }));
  const keep = ["CLAUDE_MULTI_CONFIG", "CLAUDE_MULTI_OWNER_ID", "CLAUDE_MULTI_OWNER_NAME", "CLAUDE_MULTI_LANGUAGE"].map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k] of keep) Deno.env.delete(k);
    Deno.env.set("CLAUDE_MULTI_CONFIG", dir);
    assertEquals(owner(), { id: "ann", name: "Ann", language: "Italian" });
    Deno.env.set("CLAUDE_MULTI_OWNER_NAME", "Annie");
    assertEquals(owner().name, "Annie");
    Deno.env.set("CLAUDE_MULTI_CONFIG", `${dir}/none`);
    Deno.env.delete("CLAUDE_MULTI_OWNER_NAME");
    assertEquals(owner(), { id: "me", name: "the user", language: "English" });
  } finally {
    for (const [k, v] of keep) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});

Deno.test("promptFor: the owner's name and language, nobody else's", () => {
  const p = promptFor("ask", "now", null, false, { id: "ann", name: "Ann", language: "German" });
  assertEquals([p.includes("Ann's console"), p.includes("Answer in German"), p.includes("Samuel")], [true, true, false]);
});
