// `agents migrate app` on a fixture: a throwaway home with a runtime installed from a checkout (dev
// mode), moved to a package's code and back. The CLI runs as a separate process with HOME set to it,
// so every path it derives is the fixture's; the systemd user manager's HOME is not, so install
// leaves the manager alone (machine.ts) while it still removes the unit files of this home.
import { assert, assertEquals } from "jsr:@std/assert@1";

const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const FILES = [
  "apps/cli",
  "apps/brain",
  "shared",
  "bin",
  "desktop",
  "config.example",
  "pkg",
  "deno.json",
  "deno.lock",
  "CHANGELOG.md",
];

async function sh(cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string) {
  // the fixture's: nothing of this machine's runtime, configuration or git hooks
  const base = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([k]) =>
      !/^(AGENTS_MULTI_|CLAUDE_MULTI_|GIT_|XDG_(CONFIG|CACHE|STATE|DATA)_HOME$|DENO_DIR$)/.test(k)
    ),
  );
  const r = await new Deno.Command(cmd, {
    args,
    cwd,
    clearEnv: true,
    env: { ...base, ...env },
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const d = new TextDecoder();
  return { code: r.code, out: d.decode(r.stdout), err: d.decode(r.stderr) };
}

/** The repository's tracked files of `FILES` copied into `dir`. */
async function copyCode(dir: string) {
  const files = (await sh("git", ["-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard", ...FILES])).out
    .split("\n").filter(Boolean);
  for (const f of files) {
    const st = await Deno.lstat(`${REPO}/${f}`).catch(() => null);
    if (!st) continue;
    await Deno.mkdir(`${dir}/${f.slice(0, f.lastIndexOf("/"))}`, { recursive: true });
    if (st.isSymlink) await Deno.symlink(await Deno.readLink(`${REPO}/${f}`), `${dir}/${f}`);
    else await Deno.copyFile(`${REPO}/${f}`, `${dir}/${f}`);
  }
}

async function fixture() {
  const tmp = await Deno.makeTempDir({ prefix: "agents-migrate-app-" });
  const home = `${tmp}/home`, checkout = `${tmp}/src/agents-multi`, code = `${tmp}/pkg/repo`;
  const rt = `${home}/.agents-multi`;
  // the checkout the machine runs today, and the package's code (the same, with its stamp)
  await copyCode(checkout);
  const git = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  await sh("sh", ["-c", "git init -q -b release . && git add -A && git commit -qm fixture"], git, checkout);
  await copyCode(code);
  await Deno.writeTextFile(
    `${code}/build.json`,
    JSON.stringify({ version: "9.9.9", commit: "f", digest: "f".repeat(64) }),
  );
  await Deno.mkdir(`${tmp}/pkg/deno-dir/remote`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/pkg/deno-dir/remote/module.js`, "export {}");
  await Deno.writeTextFile(`${tmp}/pkg/agents-multi-desktop`, "#!/bin/sh\n", { mode: 0o755 });
  // the person's configuration, with one of our Deno servers turned on
  await Deno.mkdir(`${rt}/config`, { recursive: true });
  await sh("cp", ["-a", `${REPO}/apps/cli/tests/fixtures/config/.`, `${rt}/config`]);
  await Deno.writeTextFile(
    `${rt}/config/servers.json`,
    JSON.stringify({ servers: { "syncthing-status": { _profiles: null } } }),
  );
  // a dev installation: shared, a launcher and units into the checkout, a profile with its .claude.json
  await Deno.symlink(`${checkout}/shared`, `${rt}/shared`);
  await Deno.mkdir(`${rt}/main`, { recursive: true });
  await Deno.writeTextFile(`${rt}/main/.claude.json`, JSON.stringify({ mcpServers: {} }));
  await Deno.mkdir(`${home}/.local/bin`, { recursive: true });
  await Deno.symlink(`${checkout}/bin/agents`, `${home}/.local/bin/agents`);
  const ud = `${home}/.config/systemd/user`;
  await Deno.mkdir(ud, { recursive: true });
  await Deno.symlink(`${checkout}/systemd/user/claude-tasks.timer`, `${ud}/claude-tasks.timer`);
  await Deno.symlink(`${checkout}/systemd/user/claude-multi-console.service`, `${ud}/claude-multi-console.service`);
  const env = {
    HOME: home,
    AGENTS_MULTI_DENO: Deno.execPath(),
    AGENTS_MULTI_APP: `${tmp}/pkg/agents-multi-desktop`,
    WAYLAND_DISPLAY: "wayland-test",
    // the doctor the checkout's install prints asks the console's port: not this machine's console
    AGENTS_MULTI_PORT: "7391",
  };
  const agents = (code: string, ...args: string[]) =>
    sh(Deno.execPath(), ["run", "--quiet", "-A", `${code}/apps/cli/main.ts`, ...args], env);
  return { tmp, home, rt, checkout, code, ud, agents };
}

const link = (p: string) => Deno.readLink(p).catch(() => null);
const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

Deno.test({
  name: "migrate app: dry run, apply, idempotent, rollback — on a fixture runtime",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await fixture();
    const { rt, home, checkout, ud } = f;
    try {
      // --- dry run: says what it would do, changes nothing
      let r = await f.agents(checkout, "migrate", "app", "--from", f.code, "--dry-run", "--force");
      assertEquals(r.code, 0, r.out + r.err);
      assert(r.out.includes("9.9.9"), r.out);
      assertEquals(await link(`${rt}/shared`), `${checkout}/shared`);
      assertEquals(await exists(`${rt}/app`), false);
      assertEquals(await link(`${home}/.local/bin/agents`), `${checkout}/bin/agents`);

      // --- apply
      r = await f.agents(checkout, "migrate", "app", "--from", f.code, "--force");
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(await link(`${rt}/shared`), "app/current/shared");
      assertEquals(await link(`${rt}/app/current`), "9.9.9-ffffffffffff");
      assertEquals(await exists(`${rt}/app/current/apps/cli/main.ts`), true);
      assertEquals(await link(`${rt}/bin/deno`), Deno.execPath());
      assertEquals(await link(`${rt}/bin/agents-multi-desktop`), `${f.tmp}/pkg/agents-multi-desktop`);
      // launchers into the copy, through the stable link
      assertEquals(await link(`${home}/.local/bin/agents`), `${rt}/app/current/bin/agents`);
      assertEquals(await link(`${home}/.local/bin/claude`), `${rt}/app/current/bin/claude`);
      assertEquals(await link(`${home}/.local/bin/claude-work`), `${rt}/app/current/bin/claude`);
      // no unit left: the app runs their jobs
      assertEquals(await exists(`${ud}/claude-tasks.timer`), false);
      assertEquals(await exists(`${ud}/claude-multi-console.service`), false);
      // the app at login
      const auto = await Deno.readTextFile(`${home}/.config/autostart/agents-multi.desktop`);
      assert(auto.includes(`Exec=${home}/.local/bin/claude-multi-app --tray`), auto);
      // our server on the stable Deno, and the person's cache seeded
      const conf = JSON.parse(await Deno.readTextFile(`${rt}/main/.claude.json`));
      assertEquals(conf.mcpServers["syncthing-status"].command, `${rt}/bin/deno`);
      assertEquals(await exists(`${home}/.cache/deno/remote/module.js`), true);
      // the person's things are where they were
      assertEquals(await exists(`${rt}/config/owner.json`), true);
      // and the CLI, from the copy, knows it is in app mode
      r = await f.agents(`${rt}/app/current`, "sync");
      assert(r.out.includes("desktop app's copy"), r.out);

      // --- again: nothing to do
      r = await f.agents(checkout, "migrate", "app", "--from", f.code, "--force");
      assertEquals(r.code, 0, r.out + r.err);
      assert(r.out.includes("already runs the app's code"), r.out);

      // --- rollback: the checkout again, by its own install
      r = await f.agents(`${rt}/app/current`, "migrate", "app", "--rollback", "--dry-run", "--force");
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(await link(`${rt}/shared`), "app/current/shared");
      r = await f.agents(`${rt}/app/current`, "migrate", "app", "--rollback", "--force");
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(await link(`${rt}/shared`), `${checkout}/shared`);
      assertEquals(await link(`${home}/.local/bin/agents`), `${checkout}/bin/agents`);
      assertEquals(await exists(`${rt}/app`), false);
      assertEquals(await exists(`${rt}/bin`), false);
      const back = JSON.parse(await Deno.readTextFile(`${rt}/main/.claude.json`));
      assertEquals(back.mcpServers["syncthing-status"].command, "deno");
      assertEquals(await exists(`${rt}/config/owner.json`), true);
      r = await f.agents(checkout, "migrate", "app", "--rollback", "--force");
      assert(r.out.includes("nothing to roll back"), r.out);
    } finally {
      await Deno.remove(f.tmp, { recursive: true });
    }
  },
});
