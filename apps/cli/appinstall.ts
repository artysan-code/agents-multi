// appinstall.ts — `agents install --app`: what the desktop app runs, from its package, when it starts
// with a build its installation's copy is not (apps/desktop/src-tauri/src/install.rs), and what the
// first-run wizard will run. It installs the package's code as the copy (appcopy.ts), links the
// package's Deno and app into the runtime, seeds the person's Deno cache with the modules our MCP
// servers import, and then runs `install` — or, with a Claude open, leaves it waiting, as self-update
// does, for the console's «Close Claude and update» or the update timer's next round. Its result goes
// to `app-install.json` in the state folder, which the doctor reads (the health page).
//
// A dev installation (a checkout) is refused: moving one to the app is `agents migrate app`.

import { buildId, installCopy, keepProgram, readBuild, seedCache } from "./appcopy.ts";
import { forgetBackendOnly } from "./console/server.ts";
import { install, installActions } from "./install.ts";
import { stat } from "./lib/fs.ts";
import { INSTALL_RECORD, type InstallRecord } from "./lib/appstate.ts";
import { installation } from "./lib/mode.ts";
import { CONFIG, HOME, REPO, RUNTIME, STATE } from "./lib/paths.ts";
import { blockers } from "./mcp/apply.ts";
import { log, PENDING } from "./selfupdate.ts";

/** The person's Deno cache, which our MCP servers read (their --allow-read names ~/.cache/deno). */
export function personDenoDir(env: (k: string) => string | undefined = (k) => Deno.env.get(k), home = HOME) {
  return env("DENO_DIR") || `${env("XDG_CACHE_HOME") || `${home}/.cache`}/deno`;
}

async function record(r: Omit<InstallRecord, "at">) {
  await Deno.mkdir(STATE, { recursive: true });
  const line: InstallRecord = { at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ...r };
  await Deno.writeTextFile(INSTALL_RECORD, JSON.stringify(line) + "\n");
}

/**
 * The package's programs into `<runtime>/bin`: its Deno (AGENTS_MULTI_DENO, as the app hands it to its
 * backend) and the app (AGENTS_MULTI_APP; an AppImage's own file, `APPIMAGE`). Each as a link, or a
 * copy out of an AppImage. A program not named is left as it is.
 */
export async function keepPackagePrograms(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  say: (s: string) => void = () => {},
) {
  const appimage = !!env("APPIMAGE");
  const deno = env("AGENTS_MULTI_DENO");
  if (deno && await keepProgram(deno, RUNTIME, "deno", appimage)) say(`~/.agents-multi/bin/deno → ${deno}`);
  // the AppImage file outlives its mount: a link to it is stable, and it is what runs the app again
  const app = env("APPIMAGE") || env("AGENTS_MULTI_APP");
  if (app && await keepProgram(app, RUNTIME, "agents-multi-desktop", false)) {
    say(`~/.agents-multi/bin/agents-multi-desktop → ${app}`);
  }
}

/** `agents install --app [--dry-run]`. */
export async function installApp(o: { dry: boolean }): Promise<number> {
  // the app runs this with its read-only module cache: the programs install starts get the person's
  forgetBackendOnly();
  const say = (s: string) => console.log(`  ${s}`);
  const build = await readBuild(REPO);
  if (!build) {
    console.error(`agents install --app runs from the desktop app's code (${REPO} has no build.json)`);
    return 2;
  }
  const id = buildId(build);
  const inst = await installation();
  if (inst.mode === "dev" && !inst.fresh) {
    const error = `this machine runs a checkout (${inst.code}): agents migrate app moves it to the app`;
    if (!o.dry) await record({ build: id, ok: false, error });
    console.error(error);
    return 3;
  }
  if (!(await stat(`${CONFIG}/owner.json`))) {
    const error = "no configuration yet (agents init): the first-run wizard installs";
    if (!o.dry) await record({ build: id, ok: false, error });
    console.error(error);
    return 1;
  }
  try {
    const copy = await installCopy(REPO, RUNTIME, { dry: o.dry, log: say });
    if (!o.dry) {
      await keepPackagePrograms(undefined, say);
      // the package's layout: resources/repo (REPO) beside resources/deno-dir
      const seeded = await seedCache(`${REPO}/../deno-dir`, personDenoDir());
      if (seeded) say(`${seeded} modules into the Deno cache (${personDenoDir()})`);
    }
    if (copy.changed && !o.dry) await log("installed", copy.from ?? "", copy.to, "the app's code");
    const waiting = !!(await stat(PENDING));
    if (!copy.changed && !waiting && !inst.fresh) {
      if (!o.dry) await record({ build: copy.to, ok: true });
      say("the app's code is current");
      return 0;
    }
    // a Claude open holds files of an installation (its settings, its links); a first install has none
    // of ours in use, and an install that would change none of them need not wait for it to close
    const open = inst.fresh ? [] : Object.keys(await blockers());
    const touches = open.length > 0 && !o.dry &&
      (await install(true, { as: { ...inst, fresh: false }, diagnose: false }), installActions().length > 0);
    if (touches) {
      await Deno.writeTextFile(PENDING, copy.to);
      await record({ build: copy.to, ok: true, pending: true });
      say(`install waits for Claude to be closed (${open.join(", ")})`);
      return 0;
    }
    // the doctor is the health page's, which reads this run's record: no diagnosis printed here
    const code = await install(o.dry, { as: { ...inst, fresh: false }, diagnose: false });
    if (!o.dry) {
      if (code === 0) await Deno.remove(PENDING).catch(() => {});
      await record({
        build: copy.to,
        ok: code === 0,
        ...(code ? { error: "install failed: run agents install" } : {}),
      });
    }
    return code;
  } catch (e) {
    const error = (e as Error).message;
    if (!o.dry) await record({ build: id, ok: false, error });
    console.error(`agents install --app: ${error}`);
    return 1;
  }
}
