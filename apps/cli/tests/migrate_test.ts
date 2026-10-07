// Tests for the runtime's move from ~/.claude-multi to ~/.agents-multi: where the runtime is found,
// the link made before the move, the move itself, its rollback and what it refuses. Everything runs
// in a throwaway home.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ensureRuntimeLink, profileOfConfigDir, runtimeRoot } from "../lib/runtime-root.ts";
import { migrate, rewritePaths } from "../migrate.ts";
import { runtimeName } from "../doctor/checks/runtime.ts";

const quiet = () => {};

/** A home with the runtime under its old name: one profile with paths in its .claude.json and
 *  plugin records, and a transcript that names the old folder (history: never rewritten). */
async function oldHome() {
  const home = await Deno.makeTempDir();
  const p = `${home}/.claude-multi/personal`;
  await Deno.mkdir(`${p}/plugins`, { recursive: true });
  await Deno.mkdir(`${p}/projects`, { recursive: true });
  await Deno.writeTextFile(
    `${p}/.claude.json`,
    JSON.stringify({
      mcpServers: { t: { args: [`${home}/.claude-multi/shared/mcp/t.ts`] } },
      other: `${home}/.claude-multi-config/x`,
    }),
    { mode: 0o600 },
  );
  await Deno.chmod(`${p}/.claude.json`, 0o600);
  await Deno.writeTextFile(
    `${p}/plugins/installed_plugins.json`,
    `{"installPath":"${home}/.claude-multi/personal/plugins/cache/a"}`,
  );
  await Deno.writeTextFile(`${p}/projects/t.jsonl`, `{"cwd":"${home}/.claude-multi/personal"}`);
  return home;
}
const isLinkTo = async (p: string, target: string) =>
  (await Deno.lstat(p)).isSymlink && await Deno.readLink(p) === target;
const opts = (home: string, extra: Partial<Parameters<typeof migrate>[0]> = {}) => ({
  home,
  dry: false,
  rollback: false,
  backupDir: `${home}/backup`,
  running: [],
  log: quiet,
  ...extra,
});

Deno.test("runtimeRoot: the new name when it exists or nothing does, the old one while only that exists", () => {
  const has = (...ps: string[]) => (p: string) => ps.includes(p);
  assertEquals(runtimeRoot("/h", has()), "/h/.agents-multi");
  assertEquals(runtimeRoot("/h", has("/h/.claude-multi")), "/h/.claude-multi");
  assertEquals(runtimeRoot("/h", has("/h/.claude-multi", "/h/.agents-multi")), "/h/.agents-multi");
});

Deno.test("profileOfConfigDir: a config directory directly under the runtime, under either name", () => {
  assertEquals(profileOfConfigDir("/h/.agents-multi/work/", "/h/.agents-multi"), "work");
  assertEquals(profileOfConfigDir("/h/.claude-multi/work", "/h/.agents-multi"), "work");
  assertEquals(profileOfConfigDir("/h/.agents-multi/work/projects", "/h/.agents-multi"), undefined);
  assertEquals(profileOfConfigDir(undefined, "/h/.agents-multi"), undefined);
});

Deno.test("rewritePaths: the folder and what is under it, nothing that only starts like it", () => {
  const t =
    `"/h/.claude-multi/x" "/h/.claude-multi" /h/.claude-multi-config /h/.claude-multi.bak /other/.claude-multi/y`;
  assertEquals(
    rewritePaths(t, "/h", ".claude-multi", ".agents-multi"),
    `"/h/.agents-multi/x" "/h/.agents-multi" /h/.claude-multi-config /h/.claude-multi.bak /other/.claude-multi/y`,
  );
});

Deno.test("ensureRuntimeLink: a link to the old folder only where the runtime has not moved", async () => {
  const home = await oldHome();
  assert(await ensureRuntimeLink(home));
  assert(await isLinkTo(`${home}/.agents-multi`, ".claude-multi"));
  assertEquals(await ensureRuntimeLink(home), false); // already there
  const fresh = await Deno.makeTempDir();
  assertEquals(await ensureRuntimeLink(fresh), false); // nothing to point at
  assertEquals(await Deno.lstat(`${fresh}/.agents-multi`).then(() => true, () => false), false);
});

Deno.test("migrate: moves the folder, leaves the old name a link, rewrites the paths and keeps a copy", async () => {
  const home = await oldHome();
  await ensureRuntimeLink(home); // as the CLI does before any command
  assertEquals(await migrate(opts(home)), 0);
  assert((await Deno.lstat(`${home}/.agents-multi`)).isDirectory);
  assert(await isLinkTo(`${home}/.claude-multi`, ".agents-multi"));
  const cj = await Deno.readTextFile(`${home}/.agents-multi/personal/.claude.json`);
  assert(cj.includes(`${home}/.agents-multi/shared/mcp/t.ts`));
  assert(cj.includes(`${home}/.claude-multi-config/x`)); // a sibling folder is not the runtime
  assertEquals((await Deno.stat(`${home}/.agents-multi/personal/.claude.json`)).mode! & 0o777, 0o600);
  assert(
    (await Deno.readTextFile(`${home}/.agents-multi/personal/plugins/installed_plugins.json`)).includes(
      `${home}/.agents-multi/personal/plugins`,
    ),
  );
  // transcripts are history: they still say the old name, which still resolves
  assert((await Deno.readTextFile(`${home}/.agents-multi/personal/projects/t.jsonl`)).includes(".claude-multi"));
  assert((await Deno.readTextFile(`${home}/backup/personal/.claude.json`)).includes(`${home}/.claude-multi/shared`));
  // a second time: already moved, nothing to do
  assertEquals(await migrate(opts(home, { backupDir: `${home}/backup2` })), 0);
  assertEquals(await Deno.lstat(`${home}/backup2`).then(() => true, () => false), false);
});

Deno.test("migrate --rollback: the folder back under its old name, the new name a link to it", async () => {
  const home = await oldHome();
  assertEquals(await migrate(opts(home)), 0); // no link made first: the move works without it
  assertEquals(await migrate(opts(home, { rollback: true, backupDir: `${home}/back` })), 0);
  assert((await Deno.lstat(`${home}/.claude-multi`)).isDirectory);
  assert(await isLinkTo(`${home}/.agents-multi`, ".claude-multi"));
  assert(
    (await Deno.readTextFile(`${home}/.claude-multi/personal/.claude.json`)).includes(`${home}/.claude-multi/shared`),
  );
  assertEquals(await migrate(opts(home, { rollback: true })), 0); // nothing left to roll back
});

Deno.test("migrate --dry-run changes nothing", async () => {
  const home = await oldHome();
  const before = await Deno.readTextFile(`${home}/.claude-multi/personal/.claude.json`);
  const lines: string[] = [];
  assertEquals(await migrate(opts(home, { dry: true, log: (l) => lines.push(l) })), 0);
  assert((await Deno.lstat(`${home}/.claude-multi`)).isDirectory);
  assertEquals(await Deno.lstat(`${home}/.agents-multi`).then(() => true, () => false), false);
  assertEquals(await Deno.readTextFile(`${home}/.claude-multi/personal/.claude.json`), before);
  assert(lines.some((l) => l.includes("personal/.claude.json")));
});

Deno.test("migrate refuses with Claude running, and with two folders", async () => {
  const home = await oldHome();
  assertEquals(await migrate(opts(home, { running: ["claude personal (pid 1)"] })), 1);
  assert((await Deno.lstat(`${home}/.claude-multi`)).isDirectory);
  assertEquals(await migrate(opts(home, { running: ["claude personal (pid 1)"], force: true })), 0);

  const two = await oldHome();
  await Deno.mkdir(`${two}/.agents-multi`);
  assertEquals(await migrate(opts(two)), 1);
});

Deno.test("runtimeName: ok once moved, a warning before, a failure for two folders or none", () => {
  assertEquals(runtimeName("dir", "link-new").status, "ok");
  assertEquals(runtimeName("dir", null).status, "ok");
  assertEquals(runtimeName("dir", "other").status, "warn");
  assertEquals(runtimeName("link-old", "dir").status, "warn");
  assertEquals(runtimeName(null, "dir").status, "warn");
  assertEquals(runtimeName("dir", "dir").status, "fail");
  assertEquals(runtimeName(null, null).status, "fail");
});
