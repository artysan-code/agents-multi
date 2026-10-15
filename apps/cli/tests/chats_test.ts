// Tests for apps/cli/chats.ts: the console's chats, one file each, the last spoken in first.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { listChats, readChat, removeChat, saveTurn, titleOf } from "../chats.ts";

const A = "0b8f5c1e-3a4d-4c2b-9e7f-1a2b3c4d5e6f";
const B = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const turn = (q: string, at: string) => ({ q, a: "ok", acts: [], at });

Deno.test("titleOf: the first line, spaces collapsed, cut at a word", () => {
  assertEquals(titleOf("  cosa   ho domani?\ne dopo"), "cosa ho domani?");
  const long = "Riassumi le mail di oggi della banca e dimmi se devo pagare qualcosa entro la settimana prossima";
  const t = titleOf(long);
  assertEquals(t, "Riassumi le mail di oggi della banca e dimmi se devo pagare…");
  assertEquals(titleOf("x".repeat(80)), `${"x".repeat(60)}…`);
});

Deno.test("saveTurn, readChat, listChats, removeChat: a chat per file, the newest first", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await saveTurn(A, "s-1", turn("prima domanda", "2026-10-15T10:00:00Z"), dir);
    await saveTurn(B, "s-2", turn("altra chat", "2026-10-15T11:00:00Z"), dir);
    // a later turn keeps the title and the session when the stream named none
    const a = await saveTurn(A, null, turn("e poi?", "2026-10-15T12:00:00Z"), dir);
    assertEquals([a.title, a.session, a.turns.length, a.created], ["prima domanda", "s-1", 2, "2026-10-15T10:00:00Z"]);
    assertEquals((await listChats(dir)).map((c) => [c.id, c.turns]), [[A, 2], [B, 1]]);
    assertEquals((await readChat(B, dir))?.turns[0].q, "altra chat");
    assertEquals(await readChat("../etc/passwd", dir), null);
    assertEquals(await removeChat(B, dir), true);
    assertEquals(await removeChat(B, dir), false);
    assertEquals((await listChats(dir)).length, 1);
    await assertRejects(() => saveTurn("nope", null, turn("x", "2026-10-15T12:00:00Z"), dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listChats: no folder yet is no chat", async () => {
  assertEquals(await listChats("/nonexistent/chats"), []);
});
