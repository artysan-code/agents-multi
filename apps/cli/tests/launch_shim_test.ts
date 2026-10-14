// Tests for shared/mcp/lib/launch.sh: the shell that reads what launch.ts prints, exports it and execs the
// server — with a stand-in for the Deno command line, so no vault is needed.
import { assert, assertEquals } from "jsr:@std/assert@1";

const SHIM = new URL("../../../shared/mcp/lib/launch.sh", import.meta.url).pathname;

/** A fake "deno command line": a script printing the given records (NUL-ended) or failing. */
async function fakeDeno(dir: string, records: string, code = 0): Promise<string> {
  const p = `${dir}/fake-deno`;
  await Deno.writeTextFile(`${p}.records`, records.replaceAll("@", "\0"));
  await Deno.writeTextFile(p, `#!/usr/bin/env bash\ncat "$0.records"\nexit ${code}\n`);
  await Deno.chmod(p, 0o755);
  return p;
}

async function shim(args: string[]) {
  const r = await new Deno.Command("bash", { args: [SHIM, ...args], stdout: "piped", stderr: "piped" }).output();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

Deno.test("launch.sh: variables exported and binding arguments appended, the server replaces the shell", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // '@' stands for NUL in the fixture; a value with spaces, quotes and a newline must arrive intact
    const deno = await fakeDeno(dir, "EKEY=s e'c\"r$(x)\nt@EURL=https://x@A--project-ref=abc@A--read-only@");
    const r = await shim([
      deno,
      "run",
      "--",
      "env",
      "svc",
      "acc",
      "--",
      "bash",
      "-c",
      // $PPID is this test's process if bash was exec'd away; a leftover shell would be the parent
      'printf "%s|%s|%s|%s|%s" "$KEY" "$URL" "$1" "$2" "$PPID"',
      "sh",
    ]);
    assertEquals(r.code, 0, r.err);
    const [key, url, a1, a2, ppid] = r.out.split("|");
    assertEquals([key, url, a1, a2], ["s e'c\"r$(x)\nt", "https://x", "--project-ref=abc", "--read-only"]);
    assertEquals(ppid, String(Deno.pid)); // no wrapper left between the test (the client) and the server
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch.sh: a launch.ts that fails starts nothing, and says why on stderr", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const deno = await fakeDeno(dir, "EKEY=partial@", 3);
    const r = await shim([deno, "--", "env", "s", "a", "--", "bash", "-c", "echo started"]);
    assertEquals(r.code, 3);
    assertEquals(r.out, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch.sh: refuses a malformed line and an unknown record", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals((await shim(["x", "env", "s", "a", "--", "true"])).code, 2); // no -- after the Deno line
    assertEquals((await shim(["x", "--", "env", "s", "a"])).code, 2); // no server command
    const deno = await fakeDeno(dir, "Zwhat@");
    const r = await shim([deno, "--", "env", "s", "a", "--", "echo", "started"]);
    assertEquals(r.code, 1);
    assert(!r.out.includes("started"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
