// Test della semantica .stignore usata da syncthing_git_guard (shared/mcp/syncthing-status/ignore.ts).
import { assertEquals } from "jsr:@std/assert@1";
import { compilePattern, isIgnored } from "../../shared/mcp/syncthing-status/ignore.ts";

const compile = (lines: string[]) => lines.map(compilePattern).filter((c) => c !== null);

Deno.test("stignore: the raw '#include' line carries no rule, the expanded patterns do", () => {
  // Il bug del 2026-09-24: git_guard leggeva le righe grezze e segnava ogni .git come sincronizzato.
  assertEquals(isIgnored("artysan/artysan-me/.git", compile(["#include .stignore-common"])), false);
  assertEquals(isIgnored("artysan/artysan-me/.git", compile(["(?d).stversions", "**/.git"])), true);
});

Deno.test("stignore: '**/' also matches zero directories", () => {
  const c = compile(["**/.git", "**/*.sync-conflict-*"]);
  assertEquals(isIgnored(".git", c), true);
  assertEquals(isIgnored("a/b/.git/HEAD", c), true);
  assertEquals(isIgnored("notes.sync-conflict-20260924-PE4D426.md", c), true);
  assertEquals(isIgnored("dnd/x.sync-conflict-1.md", c), true);
  assertEquals(isIgnored("dnd/x.md", c), false);
});

Deno.test("stignore: first match wins, so re-includes go before the exclusion of the children", () => {
  const c = compile(["!/dnd/dragons-lair/.env", "!/dnd/dragons-lair/HANDOFF.md", "/dnd/dragons-lair/*"]);
  assertEquals(isIgnored("dnd/dragons-lair/.env", c), false);
  assertEquals(isIgnored("dnd/dragons-lair/HANDOFF.md", c), false);
  assertEquals(isIgnored("dnd/dragons-lair/api/main.ts", c), true);
  assertEquals(isIgnored("dnd/other/.env", c), false);
  // ordine invertito: l'esclusione vince e le re-inclusioni non servono a niente
  const wrong = compile(["/dnd/dragons-lair/*", "!/dnd/dragons-lair/.env"]);
  assertEquals(isIgnored("dnd/dragons-lair/.env", wrong), true);
});

Deno.test("stignore: unanchored patterns match the basename at any depth, flags are stripped", () => {
  const c = compile(["(?d)node_modules", "(?i)(?d).DS_Store", "bithub25a"]);
  assertEquals(isIgnored("a/b/node_modules/x/index.js", c), true);
  assertEquals(isIgnored(".DS_Store", c), true);
  assertEquals(isIgnored("bithub25a/Corsi/CLAUDE.md", c), true);
  assertEquals(isIgnored("nodemodules/x", c), false);
});
