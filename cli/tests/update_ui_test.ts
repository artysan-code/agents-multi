// Tests for how claude-update speaks (bin/lib/ui.sh): the language follows the machine as the
// console's does, and a detail lines up under the text of its row, as cli/selfupdate.ts prints it.
import { assertEquals } from "jsr:@std/assert@1";

const REPO = new URL("../..", import.meta.url).pathname;
async function sh(script: string, env: Record<string, string> = {}) {
  const r = await new Deno.Command("bash", {
    args: ["-c", `source "${REPO}/bin/lib/ui.sh"; ${script}`],
    env: { PATH: Deno.env.get("PATH")!, NO_COLOR: "1", ...env },
    clearEnv: true,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(r.stdout);
}

Deno.test("update ui: the language is the machine's — LC_ALL, LC_MESSAGES, LC_TIME, LANG — Italian or English", async () => {
  assertEquals(await sh("cm_ui_lang", { LANG: "en_US.UTF-8", LC_TIME: "it_IT.UTF-8" }), "it\n");
  assertEquals(await sh("cm_ui_lang", { LANG: "de_DE.UTF-8" }), "en\n");
  assertEquals(await sh("cm_t updated 2.1.1", { LANG: "it_IT.UTF-8" }), "aggiornata dalla 2.1.1");
  assertEquals(await sh("cm_t updated 2.1.1", { LANG: "C" }), "updated from 2.1.1");
});

Deno.test("update ui: a row and its detail line up, with no colour off a terminal", async () => {
  const out = (await sh(`cm_row ok "Claude Code" 2.1.289 "fine"; cm_note "detail"`, { LANG: "C" })).split("\n");
  assertEquals(out[0], "  ✓ Claude Code     2.1.289    fine");
  assertEquals([...out[0]].indexOf("f"), [...out[1]].indexOf("d"));
});
