// Tests for the brain service: paths, titles, links, chunks, fusion, the store's history and
// search, TOTP, redirects and the backup seal. The OAuth dance and the MCP tools run end to end in
// brain/tests/e2e.ts, against a running service.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { cleanPath, linksIn, Store, titleOf } from "../store.ts";
import { chunk, fuse } from "../embed.ts";
import { base32Decode, base32Encode, redirectAllowed, redirectMatches, same, totp, totpOk } from "../auth.ts";
import { open, seal } from "../backup.ts";

Deno.test("cleanPath: a folder/name.md inside the tree, nothing else", () => {
  assertEquals(cleanPath("progetti/claude-multi"), "progetti/claude-multi.md");
  assertEquals(cleanPath("/a//b.md"), "a/b.md");
  assertThrows(() => cleanPath("../etc/passwd"));
  assertThrows(() => cleanPath("a/./b"));
  assertThrows(() => cleanPath("a/b\u0000.md"));
  assertThrows(() => cleanPath(""));
});

Deno.test("titleOf: frontmatter, then the first heading, then the name", () => {
  assertEquals(titleOf("x/a.md", "---\ntitle: 'Uno'\n---\n# Due"), "Uno");
  assertEquals(titleOf("x/a.md", "testo\n# Due\n"), "Due");
  assertEquals(titleOf("x/nome-file.md", "solo testo"), "nome-file");
});

Deno.test("linksIn: targets as written, without headings and labels, once each", () => {
  assertEquals(linksIn("[[a/b|B]] e [[c#sez]] e [[a/b]] e [[d.md]]"), ["a/b", "c", "d"]);
});

Deno.test("chunk: by headings and paragraphs, each piece knows its heading", () => {
  const body = "---\ntitle: x\n---\n# Uno\n\n" + "a".repeat(900) + "\n\n" + "b".repeat(900) + "\n\n## Due\n\ncorto";
  const c = chunk(body, 1200);
  assertEquals(c.length, 3);
  assert(c[1].startsWith("# Uno\n"));
  assert(c[2].startsWith("## Due"));
  assertEquals(chunk("---\ntitle: x\n---\n"), []);
});

Deno.test("fuse: reciprocal rank, what both lists rank high comes first", () => {
  assertEquals(fuse([["a", "b", "c"], ["b", "d"]])[0], "b");
});

Deno.test("Store: history, restore, deletion as a revision, links both ways, words", () => {
  const s = new Store(":memory:");
  s.write("p/claude-multi", "# claude-multi\nVedi [[samuel]].", "test");
  s.write("persone/samuel.md", "Preferisce l'italiano.", "test");
  assertThrows(() => s.write("persone/samuel.md", "x", "test", 0), Error, "changed meanwhile");
  s.write("persone/samuel.md", "Preferisce l'italiano e risposte brevi.", "claude:app", 1);
  assertEquals(s.history("persone/samuel.md").map((h) => h.rev), [2, 1]);
  assertEquals(s.links("persone/samuel.md").back, ["p/claude-multi.md"]);
  assertEquals(s.links("p/claude-multi.md").out[0].path, "persone/samuel.md");
  assertEquals(s.restore("persone/samuel.md", 1, "test").body, "Preferisce l'italiano.");
  assertEquals(s.searchWords("italiano")[0].path, "persone/samuel.md");
  s.remove("p/claude-multi.md", "test");
  assertEquals(s.get("p/claude-multi.md"), null);
  assertEquals(s.history("p/claude-multi.md")[0].op, "delete");
  assertEquals(s.graph().edges.length, 0);
  s.write("tasks/t-1.md", "una task", "test");
  assertEquals(s.list().map((d) => d.path), ["persone/samuel.md"]);
  assertEquals(s.list("", { tasks: true }).length, 2);
  s.close();
});

Deno.test("TOTP: the RFC 6238 vector, base32 both ways, a window either side", async () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  assertEquals(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assertEquals(new TextDecoder().decode(base32Decode(secret)), "12345678901234567890");
  assertEquals(await totp(secret, 59_000), "287082");
  assert(await totpOk(secret, "287082", 59_000 + 30_000));
  assert(!(await totpOk(secret, "287082", 59_000 + 90_000)));
  assert(!(await totpOk(secret, "abc", 59_000)));
});

Deno.test("redirects: Claude's callback or loopback, the loopback port free", () => {
  assert(redirectAllowed("https://claude.ai/api/mcp/auth_callback"));
  assert(redirectAllowed("http://localhost:5555/callback"));
  assert(!redirectAllowed("https://claude.ai.evil.com/api/mcp/auth_callback"));
  assert(!redirectAllowed("http://example.com/callback"));
  assert(redirectMatches(["http://127.0.0.1/callback"], "http://127.0.0.1:41234/callback"));
  assert(!redirectMatches(["http://127.0.0.1/callback"], "http://127.0.0.1:41234/other"));
  assert(!redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback?x=1"));
});

Deno.test("same: equal strings only", () => {
  assert(same("abc", "abc"));
  assert(!same("abc", "abd"));
  assert(!same("abc", "abcd"));
});

Deno.test("backup: sealed and opened with the key, refused with another", async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const plain = new TextEncoder().encode("il cervello");
  const s = await seal(plain, key);
  assertEquals(new TextDecoder().decode(await open(s, key)), "il cervello");
  await assertRejects(() => open(s, other));
});
