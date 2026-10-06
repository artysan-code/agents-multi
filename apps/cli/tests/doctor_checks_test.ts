// Tests for the pure decisions inside the doctor's check groups.
import { assertEquals } from "jsr:@std/assert@1";
import { keyRefused } from "../doctor/checks/vault.ts";
import { zshBlockIn } from "../doctor/checks/zshrc.ts";
import { writtenHomes } from "../doctor/checks/repo.ts";
import { ZSH_BEGIN, ZSH_END } from "../lib/shell.ts";

Deno.test("keyRefused: 401 and 403 are a refusal, anything else is silence", () => {
  assertEquals(keyRefused("HTTP 401"), true);
  assertEquals(keyRefused("HTTP 403 forbidden"), true);
  assertEquals(keyRefused("HTTP 500"), false);
  assertEquals(keyRefused("no reply"), false);
});

Deno.test("zshBlockIn: finds the block between the markers, or nothing", () => {
  const block = `${ZSH_BEGIN}\nalias x=y\n${ZSH_END}`;
  assertEquals(zshBlockIn(`export A=1\n${block}\nexport B=2\n`), block);
  assertEquals(zshBlockIn("export A=1\n"), undefined);
});

Deno.test("writtenHomes: each home folder once", () => {
  assertEquals(writtenHomes("/home/ann/x and /home/ann/y and /home/bob"), ["/home/ann", "/home/bob"]);
  assertEquals(writtenHomes("$HOME/x"), []);
});
