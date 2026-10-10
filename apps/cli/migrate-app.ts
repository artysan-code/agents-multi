// migrate-app.ts — `agents migrate app [--from <dir>] [--dry-run] [--rollback [--to <checkout>]] [--force]`:
// a machine installed from a checkout (dev mode) moves to the desktop app's code (app mode, lib/mode.ts).
//
// What moves is the code the runtime links into, nothing of the person's: their configuration
// (~/.agents-multi/config), the vault, the profiles, their logins and sessions stay where they are.
// The steps, each idempotent:
//   1. the package's code becomes the runtime's copy (appcopy.ts), its Deno and app linked into
//      ~/.agents-multi/bin, the person's Deno cache seeded with our servers' modules;
//   2. `install` in app mode: `shared`, the launchers and the stignore-gen template point into the
//      copy, the systemd units go (the app runs their jobs), the app's autostart entry is written;
//   3. the MCP servers are placed again, on the stable Deno (registry.ts, denoFor);
//   4. the checkout's sync state, which the status line reads, is dropped.
// The checkout it came from is recorded; --rollback points the runtime back at it and runs that
// checkout's own install and MCP sync, then removes the copy.
//
// Claude must be closed, as for `agents migrate`: install rewrites files a session holds.

import { installCopy, readBuild, seedCache } from "./appcopy.ts";
import { keepPackagePrograms, personDenoDir } from "./appinstall.ts";
import { AUTOSTART, install } from "./install.ts";
import { lstat, readJson, stat } from "./lib/fs.ts";
import { APP_DIR, installation, isCheckout } from "./lib/mode.ts";
import { ANSI } from "./lib/output.ts";
import { CACHE, CONFIG, HOME, REPO, RUNTIME, shortHome, STATE } from "./lib/paths.ts";
import { which } from "./lib/proc.ts";
import { RUNTIME_NAME } from "./lib/runtime-root.ts";
import { apply, describe, plan } from "./mcp/apply.ts";

const MIGRATION_RECORD = `${STATE}/migrate-app.json`;

interface MigrateAppOptions {
  dry: boolean;
  rollback: boolean;
  force?: boolean;
  /** the package's code (resources/repo); found from the installed app otherwise */
  from?: string;
  /** the checkout to roll back to; the recorded one otherwise */
  to?: string;
  /** the Claude instances running now, by name; refused unless `force` */
  running: string[];
}

/** Pure: where the app's code sits in a package, from the app's executable (its real path): the
 *  bundler puts the resources in <prefix>/lib/<product name>/, the executable in <prefix>/bin. */
export function packageCandidates(appExe: string, productNames: string[]): string[] {
  const prefix = appExe.slice(0, appExe.lastIndexOf("/")).replace(/\/bin$/, "");
  return productNames.map((n) => `${prefix}/lib/${n}/repo`);
}

/** The package's code: `--from`, the running code when it is the app's, or beside the installed app. */
async function findPackage(from?: string): Promise<{ code: string; app: string | null; deno: string | null } | null> {
  const app = Deno.env.get("AGENTS_MULTI_APP") ?? await which("agents-multi-desktop");
  const deno = Deno.env.get("AGENTS_MULTI_DENO") ?? await which("agents-multi-deno");
  const candidates = from
    ? [from]
    : (await readBuild(REPO))
    ? [REPO]
    : app
    ? packageCandidates(await Deno.realPath(app).catch(() => app), ["me.artysan.agents", "Agents Multi"])
    : [];
  for (const c of candidates) if (await readBuild(c)) return { code: c, app, deno };
  return null;
}

export async function migrateApp(o: MigrateAppOptions): Promise<number> {
  const pre = o.dry ? `${ANSI.d}(dry-run)${ANSI.x} ` : "";
  const say = (s: string) => console.log(`  ${pre}${s}`);
  const fail = (msg: string) => (console.log(`  ${ANSI.r}✗${ANSI.x} ${msg}`), 1);
  if (RUNTIME !== `${HOME}/${RUNTIME_NAME}` || (await lstat(RUNTIME))?.isSymlink) {
    return fail(`the runtime is not ~/${RUNTIME_NAME} yet: agents migrate first`);
  }
  if (!(await stat(`${CONFIG}/owner.json`))) return fail(`no configuration at ${shortHome(CONFIG)}`);
  if (o.running.length && !o.force) {
    if (!o.dry) return fail(`Claude is running (${o.running.join(", ")}): close it and run this from a terminal`);
    say(`${ANSI.y}!${ANSI.x} Claude is running (${o.running.join(", ")}): the real run will refuse until it is closed`);
  }
  const inst = await installation();
  return o.rollback ? await rollback(o, inst.mode, say, fail) : await forward(o, inst, say, fail);
}

async function forward(
  o: MigrateAppOptions,
  inst: Awaited<ReturnType<typeof installation>>,
  say: (s: string) => void,
  fail: (s: string) => number,
): Promise<number> {
  if (inst.mode === "app" && !inst.fresh) {
    console.log(`  ${ANSI.g}✓${ANSI.x} this machine already runs the app's code (${shortHome(inst.code)})`);
    return 0;
  }
  if (inst.fresh) return fail("no installation to move: agents install --app, from the app, installs one");
  const pkg = await findPackage(o.from);
  if (!pkg) {
    return fail("the desktop app's package is not installed (or say where its code is: --from <resources>/repo)");
  }
  if (!pkg.deno) return fail("the package's Deno (agents-multi-deno) is not found: set AGENTS_MULTI_DENO");
  const build = (await readBuild(pkg.code))!;
  console.log(
    `${ANSI.b}agents migrate app${ANSI.x} — checkout ${shortHome(inst.code)} → the app's code ${build.version} (${
      shortHome(pkg.code)
    })\n`,
  );
  if (!o.dry) {
    await Deno.mkdir(STATE, { recursive: true });
    await Deno.writeTextFile(
      MIGRATION_RECORD,
      JSON.stringify({ checkout: inst.code, at: new Date().toISOString(), build: build.version }) + "\n",
    );
  }
  // 1. the copy, and the package's programs beside it
  await installCopy(pkg.code, RUNTIME, { dry: o.dry, log: say });
  const env = (k: string) =>
    ({ AGENTS_MULTI_DENO: pkg.deno!, AGENTS_MULTI_APP: pkg.app ?? undefined })[k] ??
      Deno.env.get(k);
  if (o.dry) say(`~/.agents-multi/bin/deno → ${pkg.deno}${pkg.app ? `, agents-multi-desktop → ${pkg.app}` : ""}`);
  else {
    await keepPackagePrograms(env, say);
    const n = await seedCache(`${pkg.code}/../deno-dir`, personDenoDir());
    if (n) say(`${n} modules into the Deno cache`);
  }
  // 2. install, in app mode
  const app = { mode: "app" as const, code: `${RUNTIME}/${APP_DIR}/current`, fresh: false };
  if (await install(o.dry, { as: app, src: pkg.code, diagnose: false })) return fail("install failed: see above");
  // 3. the MCP servers on the stable Deno
  const mcp = await plan({ mode: "app" });
  for (const c of mcp.changes) say(`mcp ${describe(c)}`);
  if (!o.dry && mcp.changes.length) await apply({ mode: "app", force: true });
  // 4. the checkout's sync state
  if (!o.dry) await Deno.remove(`${CACHE}/sync.json`).catch(() => {});
  console.log(
    `\n  ${ANSI.g}✓${ANSI.x} ${
      o.dry ? "nothing changed (dry run)" : "this machine runs the app's code"
    }; the checkout ${shortHome(inst.code)} is left as it is. Back: agents migrate app --rollback`,
  );
  if (!o.dry) console.log(`  start Agents Multi now (it starts by itself at the next login), then: agents doctor`);
  return 0;
}

async function rollback(
  o: MigrateAppOptions,
  mode: string,
  say: (s: string) => void,
  fail: (s: string) => number,
): Promise<number> {
  if (mode === "dev") {
    console.log(`  ${ANSI.g}✓${ANSI.x} this machine already runs a checkout: nothing to roll back`);
    return 0;
  }
  const checkout = o.to ?? (await readJson<{ checkout?: string }>(MIGRATION_RECORD))?.checkout;
  if (!checkout) return fail("no checkout recorded: say which with --to <checkout>");
  if (!(await stat(`${checkout}/apps/cli/main.ts`)) || !(await isCheckout(checkout))) {
    return fail(`${checkout} is not a checkout of agents-multi`);
  }
  console.log(`${ANSI.b}agents migrate app --rollback${ANSI.x} — the app's code → checkout ${shortHome(checkout)}\n`);
  const autostart = `${HOME}/.config/autostart/${AUTOSTART}`;
  say(`~/.agents-multi/shared → ${shortHome(checkout)}/shared, and the checkout's own install and mcp sync`);
  if (await lstat(autostart)) say(`remove ${shortHome(autostart)} (the checkout's install writes its own)`);
  say(`remove ~/.agents-multi/${APP_DIR} and ~/.agents-multi/bin (the app's copy and its programs)`);
  if (o.dry) return 0;
  await Deno.remove(autostart).catch(() => {});
  const tmp = `${RUNTIME}/shared.tmp-${Deno.pid}`;
  await Deno.remove(tmp).catch(() => {});
  await Deno.symlink(`${checkout}/shared`, tmp);
  await Deno.rename(tmp, `${RUNTIME}/shared`);
  // the checkout's own code, whatever version it is: it installs what it knows
  for (const args of [["install"], ["mcp", "sync", "--force"]]) {
    const r = await new Deno.Command(`${checkout}/bin/agents`, { args, stdout: "inherit", stderr: "inherit" }).output();
    if (!r.success) {
      return fail(`${checkout}/bin/agents ${args.join(" ")} failed: the runtime points at the checkout; run it again`);
    }
  }
  for (const d of [APP_DIR, "bin"]) await Deno.remove(`${RUNTIME}/${d}`, { recursive: true }).catch(() => {});
  await Deno.remove(MIGRATION_RECORD).catch(() => {});
  console.log(`\n  ${ANSI.g}✓${ANSI.x} this machine runs the checkout ${shortHome(checkout)} again`);
  return 0;
}
