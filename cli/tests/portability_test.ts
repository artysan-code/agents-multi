// Tests for what keeps the repository usable by someone else: no home folder written out, and the
// ${HOME} of servers.json filled in for whoever runs it.
import { assertEquals } from "jsr:@std/assert@1";
import { writtenHomes } from "../doctor.ts";
import { expandHome } from "../mcp.ts";

Deno.test("writtenHomes: /home/<name> once each; $HOME, ~ and ${HOME} are fine", () => {
  assertEquals(writtenHomes('bash /home/ann/.claude-multi/x.sh; cat /home/ann/y "$HOME/z" ~/w ${HOME}/v /home/bob.k'), ["/home/ann", "/home/bob.k"]);
  assertEquals(writtenHomes("rm -rf /(etc|home)([[:space:]/]|$)"), []);
});

Deno.test("expandHome: every ${HOME} in the strings of an entry, nested, nothing else touched", () => {
  const cfg = { command: "deno", args: ["--allow-read=${HOME}/vault,${HOME}/.cache", "${HOME}/s.ts", 3], env: { A: "${HOME}" }, on: true };
  assertEquals(expandHome(cfg, "/home/ann"), { command: "deno", args: ["--allow-read=/home/ann/vault,/home/ann/.cache", "/home/ann/s.ts", 3], env: { A: "/home/ann" }, on: true });
});
