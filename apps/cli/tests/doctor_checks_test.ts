// Tests for the pure decisions inside the doctor's check groups.
import { assertEquals } from "jsr:@std/assert@1";
import { keyRefused } from "../doctor/checks/vault.ts";
import { zshBlockIn } from "../doctor/checks/zshrc.ts";
import { runningFrom, writtenHomes } from "../doctor/checks/repo.ts";
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

Deno.test("runningFrom: one note when the running code is not the installed repository", () => {
  assertEquals(runningFrom("/srv/src/a", "/srv/src/a", true), null);
  const dev = runningFrom("/srv/src/dev", "/srv/src/a", true);
  assertEquals(dev?.id, "repo.running");
  assertEquals(dev?.status, "ok");
  assertEquals(dev?.msg, "running from a development checkout: /srv/src/dev (installed: /srv/src/a)");
  assertEquals(
    runningFrom("/opt/app/repo", "/srv/src/a", false)?.msg,
    "running from the desktop app's package: /opt/app/repo (installed: /srv/src/a)",
  );
});
