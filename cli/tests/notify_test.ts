// Test di notify.ts: diff dei fail e testo della notifica (pure).
import { assertEquals } from "jsr:@std/assert@1";
import { diffDoctor, notifyText } from "../notify.ts";
import type { Check } from "../lib.ts";

const c = (id: string, status: Check["status"], fix?: string): Check => ({ id, status, msg: `msg ${id}`, fix });

Deno.test("diffDoctor: new failures, cleared ones, persistent ones, recovery", () => {
  const d = diffDoctor(["a", "b"], [c("b", "fail"), c("c", "fail"), c("w", "warn"), c("o", "ok")]);
  assertEquals(d.newFails.map((x) => x.id), ["c"]);
  assertEquals(d.gone, ["a"]);
  assertEquals(d.stillFails.map((x) => x.id), ["b"]);
  assertEquals(d.recovered, false);
  assertEquals(diffDoctor(["a"], [c("o", "ok")]).recovered, true);
  assertEquals(diffDoctor([], [c("o", "ok")]).recovered, false);
});

Deno.test("notifyText: only new failures or recovery; warnings never notify", () => {
  assertEquals(notifyText(diffDoctor([], [c("w", "warn")])), null);
  assertEquals(notifyText(diffDoctor(["a"], [c("a", "fail")])), null); // already-known failure: silence
  const t = notifyText(diffDoctor([], [c("x", "fail", "do this")]))!;
  assertEquals(t.urgency, "critical");
  assertEquals(t.title.includes("1 new problem"), true);
  assertEquals(t.body.includes("→ do this"), true);
  const r = notifyText(diffDoctor(["x"], [c("o", "ok")]))!;
  assertEquals(r.title, "claude-multi: all clear");
});
