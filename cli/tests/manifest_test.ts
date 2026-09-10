// Test dei manifest dei profili nel repo: forma, default e coerenza con shared/ (ogni voce selezionata deve esistere).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { KINDS, loadManifest, ownItems, profileNames, REPO } from "../lib.ts";

Deno.test("manifest: ogni profilo ha un profile.json valido e le voci selezionate esistono in shared/", async () => {
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    for (const k of KINDS) {
      const spec = m[k];
      assert(spec === "all" || Array.isArray(spec), `${p}.${k}: "all" o lista`);
      if (Array.isArray(spec)) {
        for (const n of spec) {
          const name = k === "skills" || n.endsWith(".md") ? n : `${n}.md`;
          let ok = true; try { await Deno.lstat(`${REPO}/shared/${k}/${name}`); } catch { ok = false; }
          assert(ok, `${p}.${k}: "${n}" non esiste in shared/${k}`);
        }
      }
    }
  }
});

Deno.test("manifest: work non monta tutte le skill condivise e ha le sue (clientapp) come voci proprie", async () => {
  const work = await loadManifest("work");
  assert(Array.isArray(work.skills), "work.skills deve essere selettivo");
  const own = await ownItems("work", "skills");
  assert(own.some((s) => s.startsWith("clientapp")), `voci proprie work: ${own.join(", ")}`);
  const personal = await loadManifest("personal");
  assertEquals(personal.skills, "all");
});

Deno.test("manifest: profilo senza file → default tutto \"all\"", async () => {
  // loadManifest legge profiles/<p>/profile.json; un profilo inesistente cade sui default
  const m = await loadManifest("inesistente" as unknown as "personal");
  assertEquals(m, { skills: "all", agents: "all", commands: "all" });
});
