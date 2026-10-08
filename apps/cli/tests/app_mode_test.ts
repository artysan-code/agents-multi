// Tests for app mode (docs/adr/0003, the replacement step): which mode an installation is in, the
// copy of the app's code (install, swap, rollback), the package's programs, the seeded Deno cache,
// what install points where and removes, the autostart entry, the doctor's app-mode checks, the MCP
// servers' Deno and the jobs the backend schedules. Files are made in throwaway folders.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { buildId, installCopy, keepBy, keepProgram, readBuild, seedCache } from "../appcopy.ts";
import { personDenoDir } from "../appinstall.ts";
import { appImageEntry, autostartEntry, codeFor, unitsToRetire } from "../install.ts";
import { COPY_SHARED, modeOf } from "../lib/mode.ts";
import { managerHome } from "../lib/machine.ts";
import { appCodeChecks, runningFrom } from "../doctor/checks/repo.ts";
import { denoFor, type Registry, withDeno } from "../mcp/registry.ts";
import { permissionRules, wanted } from "../mcp/placement.ts";
import { uiState } from "../ui.ts";
import { jobPath, jobsFor, nextDelay } from "../console/schedule.ts";
import { packageCandidates } from "../migrate-app.ts";

// ---------------------------------------------------------------- mode
Deno.test("modeOf: the shared link decides; with none, the running code", () => {
  const rt = "/h/.agents-multi";
  assertEquals(modeOf(COPY_SHARED, rt, "/res/repo", false), { mode: "app", code: `${rt}/app/current`, fresh: false });
  assertEquals(modeOf(`${rt}/${COPY_SHARED}`, rt, "/src/dev", true).mode, "app");
  // a checkout's link is dev whatever runs (the app's package, another checkout)
  assertEquals(modeOf("/src/am/shared", rt, "/res/repo", false), { mode: "dev", code: "/src/am", fresh: false });
  assertEquals(modeOf("/src/am/shared", rt, "/src/dev", true).code, "/src/am");
  // no link: a checkout installs dev, the app's code installs app
  assertEquals(modeOf(null, rt, "/src/dev", true), { mode: "dev", code: "/src/dev", fresh: true });
  assertEquals(modeOf(null, rt, "/res/repo", false), { mode: "app", code: `${rt}/app/current`, fresh: true });
  // something install never makes is not taken for an installation
  assertEquals(modeOf("../elsewhere/shared", rt, "/src/dev", true).fresh, true);
  assertEquals(modeOf("/shared", rt, "/src/dev", true).fresh, true);
});

Deno.test("codeFor: dev installs the running checkout, never the app's package", () => {
  const dev = { mode: "dev" as const, code: "/src/am", fresh: false };
  const app = { mode: "app" as const, code: "/h/.agents-multi/app/current", fresh: false };
  assertEquals(codeFor(dev, "/src/dev", true), "/src/dev");
  assertEquals(codeFor(dev, "/res/repo", false), "/src/am");
  assertEquals(codeFor(app, "/src/dev", true), app.code);
  assertEquals(codeFor(app, "/res/repo", false), app.code);
});

// ---------------------------------------------------------------- the copy
async function pkg(dir: string, version: string, digest: string, extra: Record<string, string> = {}) {
  await Deno.mkdir(`${dir}/shared/skills/ours`, { recursive: true });
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/shared/skills/ours/SKILL.md`, version);
  await Deno.writeTextFile(`${dir}/bin/agents`, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  await Deno.writeTextFile(`${dir}/build.json`, JSON.stringify({ version, commit: "c", digest }));
  for (const [f, t] of Object.entries(extra)) await Deno.writeTextFile(`${dir}/${f}`, t);
  return dir;
}

Deno.test("installCopy: a package writable by all becomes the user's alone", async () => {
  const tmp = await Deno.makeTempDir();
  const a = await pkg(`${tmp}/a`, "1.0.0", "a".repeat(64));
  await Deno.chmod(`${a}/shared`, 0o777);
  await Deno.chmod(`${a}/bin/agents`, 0o777);
  const { to } = await installCopy(a, `${tmp}/rt`);
  for (const p of ["shared", "bin/agents"]) {
    const mode = (await Deno.stat(`${tmp}/rt/app/${to}/${p}`)).mode!;
    assertEquals(mode & 0o022, 0, `${p} is not writable by others`);
    assert((mode & 0o100) !== 0, `${p} keeps its execute bit`);
  }
});

Deno.test("installCopy: a build beside the others, swapped in; previous kept; older pruned; rollback", async () => {
  const tmp = await Deno.makeTempDir();
  const rt = `${tmp}/rt`;
  const a = await pkg(`${tmp}/a`, "1.0.0", "a".repeat(64));
  const b = await pkg(`${tmp}/b`, "1.1.0", "b".repeat(64));
  const c = await pkg(`${tmp}/c`, "1.2.0", "c".repeat(64));
  const idA = buildId((await readBuild(a))!),
    idB = buildId((await readBuild(b))!),
    idC = buildId((await readBuild(c))!);
  assertEquals(idA, "1.0.0-aaaaaaaaaaaa");

  // a dry run changes nothing
  assertEquals((await installCopy(a, rt, { dry: true })).changed, true);
  assertEquals(await Deno.lstat(`${rt}/app`).catch(() => null), null);

  assertEquals(await installCopy(a, rt), { changed: true, from: null, to: idA });
  assertEquals(await Deno.readLink(`${rt}/app/current`), idA);
  assertEquals(await Deno.readTextFile(`${rt}/app/current/shared/skills/ours/SKILL.md`), "1.0.0");
  assert(((await Deno.stat(`${rt}/app/current/bin/agents`)).mode! & 0o111) !== 0, "modes are kept");
  // idempotent
  assertEquals((await installCopy(a, rt)).changed, false);

  // a skill another tool installed (install links it into the copy) survives the swap
  await Deno.symlink(`${tmp}/elsewhere/skill`, `${rt}/app/current/shared/skills/theirs`);
  assertEquals(await installCopy(b, rt), { changed: true, from: idA, to: idB });
  assertEquals(await Deno.readLink(`${rt}/app/current`), idB);
  assertEquals(await Deno.readLink(`${rt}/app/previous`), idA);
  assertEquals(await Deno.readLink(`${rt}/app/current/shared/skills/theirs`), `${tmp}/elsewhere/skill`);

  await installCopy(c, rt);
  const kept = [];
  for await (const e of Deno.readDir(`${rt}/app`)) kept.push(e.name);
  assertEquals(kept.sort(), ["current", idB, idC, "previous"].sort(), "the build before previous goes");

  await assertRejects(() => installCopy(`${tmp}/rt`, `${tmp}/rt2`), Error, "build.json");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("keepProgram: a link to a package's program, a copy out of an AppImage", async () => {
  assertEquals(keepBy(false), "link");
  assertEquals(keepBy(true), "copy");
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmp}/deno`, "binary", { mode: 0o755 });
  assertEquals(await keepProgram(`${tmp}/deno`, `${tmp}/rt`, "deno", false), true);
  assertEquals(await Deno.readLink(`${tmp}/rt/bin/deno`), `${tmp}/deno`);
  assertEquals(await keepProgram(`${tmp}/deno`, `${tmp}/rt`, "deno", false), false);
  assertEquals(await keepProgram(`${tmp}/deno`, `${tmp}/rt`, "deno", true), true);
  const st = await Deno.lstat(`${tmp}/rt/bin/deno`);
  assert(st.isFile && (st.mode! & 0o111) !== 0, "an executable copy");
  assertEquals(await keepProgram(`${tmp}/deno`, `${tmp}/rt`, "deno", true), false, "the same copy is left");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("seedCache: copies what the person's cache lacks, leaves what it has", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.mkdir(`${tmp}/pkg/npm/x`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/pkg/npm/x/a.js`, "package");
  await Deno.writeTextFile(`${tmp}/pkg/npm/x/b.js`, "package");
  await Deno.mkdir(`${tmp}/mine/npm/x`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/mine/npm/x/a.js`, "mine");
  assertEquals(await seedCache(`${tmp}/pkg`, `${tmp}/mine`), 1);
  assertEquals(await Deno.readTextFile(`${tmp}/mine/npm/x/a.js`), "mine");
  assertEquals(await Deno.readTextFile(`${tmp}/mine/npm/x/b.js`), "package");
  assertEquals(await seedCache(`${tmp}/none`, `${tmp}/mine`), 0);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("personDenoDir: DENO_DIR, else the XDG cache's deno, else ~/.cache/deno", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(personDenoDir(env({ DENO_DIR: "/d" }), "/h"), "/d");
  assertEquals(personDenoDir(env({ XDG_CACHE_HOME: "/c" }), "/h"), "/c/deno");
  assertEquals(personDenoDir(env({}), "/h"), "/h/.cache/deno");
});

// ---------------------------------------------------------------- install
Deno.test("unitsToRetire: app mode removes every unit of ours, dev only the ones the app replaced", () => {
  const units = [
    { name: "claude-tasks.timer", target: "/src/am/systemd/user/claude-tasks.timer" },
    { name: "claude-multi-console.service", target: "/src/am/systemd/user/claude-multi-console.service" },
    { name: "claude-multi-app.service", target: null },
    { name: "someone-else.service", target: "/opt/x/someone-else.service" },
    { name: "default.target.wants", target: null },
  ];
  assertEquals(unitsToRetire("dev", units), ["claude-multi-console.service", "claude-multi-app.service"]);
  assertEquals(unitsToRetire("app", units), [
    "claude-tasks.timer",
    "claude-multi-console.service",
    "claude-multi-app.service",
  ]);
});

Deno.test("autostartEntry: the app in the tray, through the launcher in ~/.local/bin", async () => {
  const tpl = await Deno.readTextFile(new URL("../../../desktop/autostart.desktop.in", import.meta.url));
  const text = autostartEntry(tpl, "/h/.local/bin");
  assert(text.startsWith("[Desktop Entry]\n"), "the template's comment is not copied");
  assert(text.includes("\nExec=/h/.local/bin/claude-multi-app --tray\n"));
  assert(!text.includes("@"), "every placeholder filled");
});

Deno.test("appImageEntry: the AppImage in the menu, grouped with the app's window", () => {
  const text = appImageEntry("/h/.agents-multi/bin/agents-multi-desktop");
  assert(text.startsWith("[Desktop Entry]\n"));
  assert(text.includes("\nExec=/h/.agents-multi/bin/agents-multi-desktop\n"));
  assert(text.includes("\nStartupWMClass=me.artysan.agents\n"), "the window's app_id");
  assert(!text.includes("NoDisplay"), "shown in the menu");
});

Deno.test("managerHome: the user manager's HOME from show-environment", () => {
  assertEquals(managerHome("LANG=C\nHOME=/home/a\nPATH=/bin\n"), "/home/a");
  assertEquals(managerHome(""), null);
});

// ---------------------------------------------------------------- doctor
Deno.test("appCodeChecks: the app, its copy and its install agree, or say what to do", () => {
  const copy = { version: "1.1.0", commit: "c", digest: "b".repeat(64) };
  const id = buildId(copy);
  const ok = appCodeChecks({ app: { version: "1.1.0", build: id }, copy, record: null, waiting: false });
  assertEquals(ok.map((c) => [c.id, c.status]), [["app.version", "ok"]]);
  const old = appCodeChecks({ app: { version: "1.2.0", build: "1.2.0-x" }, copy, record: null, waiting: false });
  assertEquals(old.map((c) => [c.id, c.status]), [["app.version", "warn"]]);
  assert(old[0].fix?.includes("restart"));
  assertEquals(appCodeChecks({ app: null, copy, record: null, waiting: false })[0].status, "warn");
  const none = appCodeChecks({ app: null, copy: null, record: null, waiting: false });
  assertEquals(none.map((c) => [c.id, c.status]), [["app.copy", "fail"]]);
  const failed = appCodeChecks({
    app: { version: "1.1.0", build: id },
    copy,
    record: { at: "t", build: id, ok: false, error: "boom" },
    waiting: false,
  });
  assertEquals(failed[0].id, "app.install");
  assertEquals(failed[0].status, "fail");
  assert(failed[0].msg.includes("boom"));
  const waiting = appCodeChecks({ app: { version: "1.1.0", build: id }, copy, record: null, waiting: true });
  assertEquals(waiting.map((c) => [c.id, c.status]), [["app.install", "warn"], ["app.version", "ok"]]);
});

Deno.test("runningFrom: the app's package, when it is the running code", () => {
  assertEquals(
    runningFrom("/res/repo", "/h/.agents-multi/app/current", false)?.msg,
    "running from the desktop app's package: /res/repo (installed: /h/.agents-multi/app/current)",
  );
});

Deno.test("uiState: outside a checkout the page is the package's build", () => {
  assertEquals(uiState(null, "", true), "built");
  assertEquals(uiState("old", "", true), "built");
  assertEquals(uiState(null, "", false), "missing");
});

// ---------------------------------------------------------------- MCP servers
Deno.test("denoFor and withDeno: app mode runs our servers on the runtime's Deno", () => {
  assertEquals(denoFor("app", "/h/.agents-multi"), "/h/.agents-multi/bin/deno");
  assertEquals(denoFor("dev", "/h/.agents-multi"), "deno");
  const out = withDeno({ a: { command: "deno", args: ["run"] }, b: { command: "npx" } }, "/rt/bin/deno");
  assertEquals(out.a.command, "/rt/bin/deno");
  assertEquals(out.b.command, "npx");
});

Deno.test("placement: launch.ts and the guard hooks run on the registry's Deno", () => {
  const reg: Registry = {
    profiles: ["p"],
    launch: { script: "/rt/shared/mcp/lib/launch.ts", read: ["/v"], hooks: "/rt/shared/hooks", deno: "/rt/bin/deno" },
    accounts: [{ service: "flows", name: "acme", url: "https://acme.example" }],
    servers: {
      flows: {
        _service: "flows",
        command: "npx",
        args: ["flows-mcp"],
        _perAccount: { env: { KEY: "{secret}" } },
        _guard: { tool: "run", hook: "guard.ts" },
      },
    },
  };
  const s = wanted(reg, { profile: "p", surface: "cli" })["flows-acme"];
  assertEquals(s.command, "/rt/bin/deno");
  assertEquals(
    permissionRules(reg, "p").hooks[0].hooks[0].command,
    "/rt/bin/deno run --quiet --no-lock /rt/shared/hooks/guard.ts",
  );
});

// ---------------------------------------------------------------- the backend's schedule
Deno.test("jobsFor: the timers' jobs, under the same conditions as their units", () => {
  const names = (f: Parameters<typeof jobsFor>[0]) => jobsFor(f).map((j) => j.name);
  assertEquals(names({ repo: "/r", graphical: true, brain: true, syncthing: true }), [
    "tasks",
    "brain-backup",
    "update-check",
    "stignore-gen",
  ]);
  assertEquals(names({ repo: "/r", graphical: false, brain: true, syncthing: false }), ["brain-backup"]);
  const tasks = jobsFor({ repo: "/r", graphical: true, brain: false, syncthing: false })[0];
  assertEquals(tasks.cmd, ["/r/bin/agents", "tasks", "remind"]);
});

Deno.test("nextDelay: on the clock, or after the start and then every interval", () => {
  const clock = { name: "t", cmd: [], first: "clock" as const, every: 300_000, timeout: 1 };
  assertEquals(nextDelay(clock, 1_000_000_000, false), 300_000 - (1_000_000_000 % 300_000));
  assertEquals(nextDelay(clock, 600_000, true), 300_000, "exactly on the mark: the next one");
  const every = { name: "b", cmd: [], first: 600_000, every: 1_800_000, timeout: 1 };
  assertEquals(nextDelay(every, 0, false), 600_000);
  assertEquals(nextDelay(every, 0, true), 1_800_000);
});

Deno.test("jobPath: the runtime's bin last, once", () => {
  assertEquals(jobPath("/usr/bin:/bin", "/rt"), "/usr/bin:/bin:/rt/bin");
  assertEquals(jobPath("/rt/bin:/usr/bin", "/rt"), "/rt/bin:/usr/bin");
  assertEquals(jobPath(undefined, "/rt"), "/rt/bin");
});

// ---------------------------------------------------------------- migration
Deno.test("packageCandidates: the resources beside the app's executable", () => {
  assertEquals(packageCandidates("/usr/bin/agents-multi-desktop", ["me.artysan.agents", "Agents Multi"]), [
    "/usr/lib/me.artysan.agents/repo",
    "/usr/lib/Agents Multi/repo",
  ]);
});
