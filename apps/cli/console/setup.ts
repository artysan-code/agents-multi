// setup.ts — the first-run wizard's routes (/api/setup/*), thin wrappers over apps/cli/setup.ts and the
// CLI functions it names. GET /api/setup says whether the console opens on the wizard and at which
// step; each POST moves one step, behind the console's anti-CSRF header like every write, and only
// while the setup is not finished. Install is not here: the page runs it as a job (`install-app` or
// `install`, console/jobs.ts), with its output streamed.

import { listDir } from "../lib/fs.ts";
import { HOME, REPO } from "../lib/paths.ts";
import { init } from "../init.ts";
import { openTerminal } from "../ask.ts";
import { startBrainLogin } from "../brain-login.ts";
import {
  checkBrainUrl,
  loginCommand,
  nextStep,
  passStep,
  setFolder,
  setOwner,
  setProfiles,
  SETUP_PATHS,
  setupFacts,
  setupOpen,
  setupView,
  updateRecord,
  watchFor,
} from "../setup.ts";
import { initVault, pairVault, VaultError } from "../../../shared/mcp/lib/vault.ts";
import { connectTasks } from "../../../shared/mcp/lib/brain-tasks.ts";
import { json } from "./http.ts";
import { broadcast } from "./events.ts";
import { writeProfile } from "./profiles.ts";
import { accountOp, recordConnect } from "./accounts.ts";
import type { Route } from "./server.ts";
import type { StatusCache } from "./status-cache.ts";

type Body = Record<string, unknown>;
type Result = { ok: boolean; message?: string; [k: string]: unknown };

/** The names install links into ~/.local/bin besides the profiles' launchers: no profile takes one. */
async function reserved(): Promise<string[]> {
  return [...(await listDir(`${REPO}/bin`)).filter((b) => b !== "lib"), "stignore-gen"];
}

export function setupRoutes(status: Pick<StatusCache, "invalidate">): Record<string, Route> {
  const changed = () => {
    status.invalidate();
    broadcast("state");
  };
  /** A POST of the wizard: refused once the setup is over, its body handed on, the page told after. */
  const step = (fn: (b: Body) => Promise<Result>): Route => ({
    post: async ({ req }) => {
      if (!(await setupOpen())) return json({ ok: false, message: "the setup is finished" }, 409);
      const b = await req.json().catch(() => ({})) as Body;
      let r: Result;
      try {
        r = await fn(b);
      } catch (e) {
        if (!(e instanceof VaultError)) throw e;
        r = { ok: false, message: e.message };
      }
      if (r.ok) changed();
      return json(r, r.ok ? 200 : 400);
    },
  });

  return {
    "/api/setup": { get: async () => json(await setupView()) },
    "/api/setup/owner": step((b) => setOwner(b)),
    "/api/setup/folder": step((b) => setFolder(b, init)),
    "/api/setup/profiles": step(async (b) => setProfiles(b, writeProfile, SETUP_PATHS, await reserved())),
    "/api/setup/pass": step((b) => passStep(b)),
    // the recovery code leaves the server once, in the answer to the vault's creation
    "/api/setup/vault": step(async (b) => {
      if (b.mode === "init") return { ok: true, code: await initVault() };
      if (b.mode === "pair") {
        await pairVault(String(b.code ?? ""));
        await passStep({ step: "vault" });
        return { ok: true };
      }
      return { ok: false, message: "mode: init or pair" };
    }),
    // Claude Code's own sign-in, in a terminal: the page is told when the profile's credentials appear
    "/api/setup/login": step(async (b) => {
      const cmd = await loginCommand(b.profile);
      if (!cmd) return { ok: false, message: `${String(b.profile)} is not an installed profile` };
      const r = await openTerminal(HOME, [cmd, "auth", "login"]);
      if (r.ok) watchFor(`${SETUP_PATHS.runtime}/${String(b.profile)}/.credentials.json`, changed);
      return r;
    }),
    // the brain's account in accounts.json, then its sign-in page (brain-login.ts), as Connections does
    "/api/setup/brain": step(async (b) => {
      const u = checkBrainUrl(b.url);
      if (!u.ok) return u;
      if ((await setupFacts()).vault !== "ok") {
        return { ok: false, message: "the vault comes first: its token goes there" };
      }
      const a = await accountOp({ service: "brain", name: "brain", url: u.url });
      if (!a.ok) return a;
      const url = await startBrainLogin("brain", (r) => {
        recordConnect("brain", r);
        changed();
      });
      return { ok: true, url };
    }),
    "/api/setup/finish": step(async () => {
      const step = nextStep(await setupFacts());
      if (step !== "done") return { ok: false, message: `not finished: the next step is ${step}` };
      await updateRecord((r) => r.finished = new Date().toISOString());
      // a brain signed in during the setup takes the console's tasks from now, not from its next start
      connectTasks();
      return { ok: true };
    }),
  };
}
