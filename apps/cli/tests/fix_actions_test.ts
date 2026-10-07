// Tests for the doctor's fixes on the console: a fix that is a bare `agents-multi …` command gets a
// button only when the page maps it to an allowlisted action (FIX_ACTIONS in apps/ui/src/lib/ui.tsx). The update
// check once suggested `agents-multi update --auto` as text to copy, though the action existed.
import { assertEquals } from "jsr:@std/assert@1";
import { ACTIONS } from "../console/actions.ts";

/** Commands the console does not run on purpose: they need a terminal, or do more than repair. */
const MANUAL = new Set([
  "agents-multi brain-backup",
  "agents-multi doctor --probe",
  "agents-multi sync",
  "agents-multi tasks migrate",
  "agents-multi update --cli",
  "agents-multi vault status",
]);

async function fixActions(): Promise<Record<string, string>> {
  const src = await Deno.readTextFile(new URL("../../ui/src/lib/ui.tsx", import.meta.url));
  const body = src.match(/const FIX_ACTIONS[^=]*= \{([^}]*)\}/)![1];
  return Object.fromEntries([...body.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

async function doctorCommands(): Promise<string[]> {
  const out = new Set<string>();
  const dir = new URL("../doctor/checks/", import.meta.url);
  for await (const f of Deno.readDir(dir)) {
    const src = await Deno.readTextFile(new URL(f.name, dir));
    // only a whole literal that is a command: prose around it ("…, or remove the entry") stays text
    for (const m of src.matchAll(/["`](agents-multi [a-z][\w-]*(?: [a-z][\w-]*)?(?: --[\w-]+)*)["`]/g)) out.add(m[1]);
  }
  return [...out].sort();
}

Deno.test("FIX_ACTIONS: every action it names is in the allowlist", async () => {
  const missing = Object.values(await fixActions()).filter((a) => !(a in ACTIONS));
  assertEquals(missing, []);
});

Deno.test("doctor fixes: each bare command has a button or is declared manual", async () => {
  const map = await fixActions();
  const orphan = (await doctorCommands()).filter((c) => !(c in map) && !MANUAL.has(c));
  assertEquals(orphan, []);
});
