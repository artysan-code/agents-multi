// Tests for the brain service: paths, titles, links, chunks, fusion, the store's history and
// search, TOTP, redirects and the backup seal. The OAuth dance and the MCP tools run end to end in
// brain/tests/e2e.ts, against a running service.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { cleanPath, linksIn, Store, titleOf } from "../store.ts";
import { chunk, fuse } from "../embed.ts";
import { base32Decode, base32Encode, redirectAllowed, redirectMatches, same, totp, totpOk } from "../auth.ts";
import { open, seal } from "../backup.ts";
import { instructions, staleProjects } from "../tools.ts";
import { brainApi } from "../api.ts";
import { check, diaryRewriteErrors, entryErrors, relink, shapeErrors, similarity, slugPath } from "../rules.ts";

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
  s.write("p/claude-multi", "# claude-multi\nVedi [[alice]].", "test");
  s.write("persone/alice.md", "Preferisce l'italiano.", "test");
  assertThrows(() => s.write("persone/alice.md", "x", "test", 0), Error, "changed meanwhile");
  s.write("persone/alice.md", "Preferisce l'italiano e risposte brevi.", "claude:app", 1);
  assertEquals(s.history("persone/alice.md").map((h) => h.rev), [2, 1]);
  assertEquals(s.links("persone/alice.md").back, ["p/claude-multi.md"]);
  assertEquals(s.links("p/claude-multi.md").out[0].path, "persone/alice.md");
  assertEquals(s.restore("persone/alice.md", 1, "test").body, "Preferisce l'italiano.");
  assertEquals(s.searchWords("italiano")[0].path, "persone/alice.md");
  s.remove("p/claude-multi.md", "test");
  assertEquals(s.get("p/claude-multi.md"), null);
  assertEquals(s.history("p/claude-multi.md")[0].op, "delete");
  assertEquals(s.graph().edges.length, 0);
  s.write("tasks/t-1.md", "una task", "test");
  assertEquals(s.list().map((d) => d.path), ["persone/alice.md"]);
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

// ---------------------------------------------------------------- the writing rules (brain/rules.ts)

const page = (title: string, rest = "Una frase che dice cos'è.\n\nContenuto.") => `# ${title}\n\n${rest}`;

Deno.test("slugPath: lower case, no accents, dashes", () => {
  assertEquals(slugPath("Note/Città Già Fatte"), "note/citta-gia-fatte.md");
  assertEquals(slugPath("/progetti/work/acme/PORTAL.md"), "progetti/work/acme/portal.md");
});

Deno.test("shapeErrors: areas, flat folders, diary days, title and sentence, length, code, secrets", () => {
  assertEquals(shapeErrors("note/arctis.md", page("Arctis")), []);
  assertEquals(shapeErrors("progetti/work/acme/portal.md", page("PORTAL")), []);
  assertEquals(shapeErrors("clienti/acme.md", page("Acme")), []);
  assert(shapeErrors("clienti/acme/portal.md", page("PORTAL")).some((e) => e.includes("flat")));
  assert(shapeErrors("concepts/x.md", page("X"))[0].includes("one of"));
  assert(shapeErrors("note/audio/arctis.md", page("A")).some((e) => e.includes("flat")));
  assert(shapeErrors("diario/oggi.md", page("Oggi")).some((e) => e.includes("YYYY-MM-DD")));
  assert(shapeErrors("note/x.md", "Senza titolo").some((e) => e.includes("title")));
  assert(shapeErrors("note/x.md", "# X\n\n- solo elenco").some((e) => e.includes("sentence")));
  assert(
    shapeErrors("note/x.md", page("X", "Frase.\n\n" + "parola ".repeat(450))).some((e) => e.includes("at most 400")),
  );
  assertEquals(shapeErrors("diario/2026-10-01.md", page("2026-10-01", "Frase.\n\n" + "parola ".repeat(3000))), []); // a busy day is still recorded
  assert(
    shapeErrors("inbox/inbox.md", page("Inbox", "Frase.\n\n" + "parola ".repeat(1100))).some((e) =>
      e.includes("at most 1000")
    ),
  );
  assert(
    shapeErrors("note/x.md", page("X", "Frase.\n\n```\n" + "riga\n".repeat(20) + "```")).some((e) =>
      e.includes("code")
    ),
  );
  assert(shapeErrors("note/x.md", page("X", "Frase.\n\nDB_PASSWORD=hunter2")).some((e) => e.includes("secret")));
});

Deno.test("diary lines: one sentence each, links not counted; a page tidied keeps every time in order", () => {
  assertEquals(entryErrors("[[progetti/work/acme/crm]]: " + "parola ".repeat(40)), []);
  assert(entryErrors("parola ".repeat(41))[0].includes("at most 40"));
  const day = "# 2026-10-05\n\nCosa è successo.\n\n- 09:37 Una cosa lunga " + "parola ".repeat(50) +
    "\n- 17:04 Due.\n- 17:05 Correzione.\n";
  assertEquals(
    diaryRewriteErrors(
      day,
      "# 2026-10-05\n\nCosa è successo.\n\n- 09:37 Una cosa.\n- 17:04 Due.\n- 17:05 Correzione.\n",
    ),
    [],
  );
  assert(
    diaryRewriteErrors(day, "# 2026-10-05\n\nCosa è successo.\n\n- 09:37 Una cosa.\n- 17:04 Due.\n")[0].includes(
      "keep every timed line",
    ),
  );
  assert(
    diaryRewriteErrors(
      day,
      "# 2026-10-05\n\nCosa è successo.\n\n- 17:04 Due.\n- 09:37 Una cosa.\n- 17:05 Correzione.\n",
    )[0].includes("in its order"),
  );
  assert(diaryRewriteErrors(day, day)[0].startsWith("09:37:"));
});

Deno.test("similarity: words in common, containment counts as the same", () => {
  assertEquals(similarity("Audio Arctis su Linux", "Arctis audio"), 1);
  assert(similarity("Migrazione server relay", "Ricetta della pizza") === 0);
});

Deno.test("check: a link to an existing page, near copies refused unless distinct", () => {
  const s = new Store(":memory:");
  assert(check(s, "io/lavoro.md", page("Lavoro"), { creating: true }).ok); // the first page has nothing to link to
  s.write("io/lavoro.md", page("Lavoro"), "t");
  const noLink = check(s, "note/arctis-audio.md", page("Audio Arctis"), { creating: true });
  assert(!noLink.ok && noLink.errors.some((e) => e.includes("link at least one")));
  assert(check(s, "note/arctis-audio.md", page("Audio Arctis", "Frase, vedi [[io/lavoro]]."), { creating: true }).ok);
  s.write("note/arctis-audio.md", page("Audio Arctis", "Frase, vedi [[io/lavoro]]."), "t");
  const dup = check(s, "note/arctis.md", page("Arctis audio", "Frase, vedi [[io/lavoro]]."), { creating: true });
  assert(!dup.ok && dup.similar?.[0].path === "note/arctis-audio.md");
  assert(
    check(s, "note/arctis.md", page("Arctis audio", "Frase, vedi [[io/lavoro]]."), { creating: true, distinct: true })
      .ok,
  );
  // another area may share the name: a client and the project for it
  assert(check(s, "progetti/arctis.md", page("Arctis audio", "Frase, vedi [[io/lavoro]]."), { creating: true }).ok);
  assert(check(s, "diario/2026-10-01.md", page("2026-10-01"), { creating: true }).ok); // the diary needs no link
  s.close();
});

Deno.test("relink: links that meant the old page point at the new one, label and heading kept", () => {
  const resolve = (t: string) => ["note/a", "a"].includes(t) ? "note/a.md" : null;
  assertEquals(
    relink("vedi [[a]] e [[note/a#sez|qui]] e [[b]]", "note/a.md", "note/nuova.md", resolve),
    "vedi [[note/nuova]] e [[note/nuova#sez|qui]] e [[b]]",
  );
});

Deno.test("staleProjects: a reminder when the diary moved on after the project page", () => {
  const s = new Store(":memory:");
  s.write("io/chi-sono.md", page("Chi sono"), "t");
  s.write("progetti/x.md", page("X", "Frase, vedi [[io/chi-sono]]."), "t");
  s.db.prepare("update docs set updated = ? where path = ?").run("2026-10-01T08:00:00", "progetti/x.md");
  const now = new Date("2026-10-01T10:05:00");
  const diary = "# 2026-10-01\n\nFrase.\n\n- 10:00 fatto qualcosa [[progetti/x]]\n- 10:05 altro [[progetti/x]]\n";
  assert(staleProjects(s, diary, "altro [[progetti/x]]", now).reminder?.includes("progetti/x.md"));
  // the page updated after the earlier line: nothing to remind
  s.db.prepare("update docs set updated = ? where path = ?").run("2026-10-01T10:02:00", "progetti/x.md");
  assertEquals(staleProjects(s, diary, "altro [[progetti/x]]", now), {});
  s.close();
});

Deno.test("brainApi: pages by area, a page with links and versions, an old version, health, a version that ignores tasks", async () => {
  const s = new Store(":memory:");
  const ctx = { store: s, embed: { url: "http://127.0.0.1:9", model: "none" }, by: () => "test", changed: () => {} };
  const get = (q: string) => brainApi(ctx, new URL(`http://x/api/brain/${q}`));
  s.write("progetti/claude-multi.md", "# claude-multi\nIl setup. Vedi [[io/chi-sono]] e [[note/manca]].", "test");
  s.write("io/chi-sono.md", "# Chi sono\nAlice.", "test");
  s.write("io/chi-sono.md", "# Chi sono\nAlice, sviluppatore.", "claude:app");
  const v = (await get("state"))!.body as { version: string };
  s.write("tasks/t-1.md", "una task", "test");
  assertEquals(((await get("state"))!.body as { version: string }).version, v.version);
  const pages = (await get("pages"))!.body as {
    areas: Record<string, number>;
    pages: { path: string; area: string }[];
    edges: [string, string][];
  };
  assertEquals(pages.areas.io, 1);
  assertEquals(pages.areas.progetti, 1);
  assertEquals(pages.pages.length, 2);
  assertEquals(pages.edges, [["progetti/claude-multi.md", "io/chi-sono.md"]]);
  const page = (await get("page?path=chi-sono"))!.body as {
    path: string;
    links: { back: string[] };
    versions: { rev: number }[];
  };
  assertEquals(page.path, "io/chi-sono.md");
  assertEquals(page.links.back, ["progetti/claude-multi.md"]);
  assertEquals(page.versions.map((x) => x.rev), [2, 1]);
  assertEquals(((await get("page?path=io/chi-sono&rev=1"))!.body as { body: string }).body, "# Chi sono\nAlice.");
  assertEquals((await get("page?path=nessuna"))!.status, 404);
  const h = (await get("health"))!.body as { broken_links: { link: string }[] };
  assertEquals(h.broken_links.map((b) => b.link), ["note/manca"]);
  const found = (await get("search?q=sviluppatore"))!.body as { results: { path: string }[]; note?: string };
  assertEquals(found.results[0].path, "io/chi-sono.md");
  assert(found.note, "the model is unreachable here: words only, and it says so");
  assertEquals(await get("altro"), null);
  s.close();
});

Deno.test("instructions: whose brain it is and the language, from the owner; nobody else's name", () => {
  const s = new Store(":memory:");
  s.write("io/chi-sono.md", "# Chi sono\nAnn, sviluppatrice.", "test");
  const txt = instructions(s, { id: "ann", name: "Ann", language: "Italian" });
  assert(txt.startsWith("Ann's brain:"));
  assert(txt.includes("Write in Italian."));
  assert(txt.includes("Who Ann is (from io/"));
  assert(!txt.includes("Alice"));
  s.close();
});
