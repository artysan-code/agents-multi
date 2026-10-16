// server.ts — the local console: `agents serve` listens on http://127.0.0.1:7331 and serves
// the interface built from apps/ui, and its API.
//
// Routes are a table: each path has a GET handler, a POST handler, or both. A POST handler runs only
// with the anti-CSRF header; a path with only a POST handler answers 405 to anything else. The
// feature modules that own a group of paths (ask, Claude's assets) answer theirs before the static files.

import { openUrl, tryOpenUrl } from "../../../shared/mcp/lib/platform.ts";
import { ANSI } from "../lib/output.ts";
import { DEFAULT_PORT, machineConsole, PORT, REPO, SYNCTHING_CONFIG } from "../lib/paths.ts";
import { codeVersion } from "../codeversion.ts";
import { whatsNew } from "../lib/changelog.ts";
import { summarize } from "../status.ts";
import { ingest, openDb, sessions } from "../usage.ts";
import { startConnect, storeClient } from "../google.ts";
import { startBrainLogin } from "../brain-login.ts";
import { calendarAsTasks, resetAgenda } from "../agenda.ts";
import { listCalendars, setShown } from "../calendars.ts";
import { askApi } from "../ask.ts";
import { assetsApi, claudeAssets } from "../claude-assets.ts";
import { permissionsOp, permissionsView, type PermOp } from "../permissions.ts";
import { claudeSessionVars } from "../../../shared/mcp/lib/agents.ts";
import { owner } from "../../../shared/mcp/lib/owner.ts";
import { brief, listTasks, updateTask } from "../../../shared/mcp/lib/tasks.ts";
import { brainAccount, connectTasks } from "../../../shared/mcp/lib/brain-tasks.ts";
import { hasCsrfHeader, isLocalHost, json, jsonText, uiFile } from "./http.ts";
import {
  broadcast,
  eventStream,
  onTopic,
  takeChangedTranscripts,
  type Topic,
  TOPICS,
  watchBrain,
  watchTree,
} from "./events.ts";
import { StatusCache } from "./status-cache.ts";
import { runAction } from "./actions.ts";
import { cancelJob, jobStream, startJob } from "./jobs.ts";
import { closePlan, closeSessions, parsePurpose, reopen } from "./close-claude.ts";
import { launchList, launchOne } from "./picker.ts";
import { saveProfile } from "./profiles.ts";
import { accountOp, accountsView, recordConnect } from "./accounts.ts";
import { endorseOp, passkeysView, revokeOp } from "../passkeys.ts";
import { UI_DIST } from "../ui.ts";
import { AppLink, appSocket, appUpdateRoute, unixDial } from "./app-update.ts";
import { answer, type Auth, gate, newToken, publishToken, Tickets, tokenPath } from "./token.ts";
import { jobsFor, startLimitsScan, startRoutineSchedule, startSchedule } from "./schedule.ts";
import { superviseGateway } from "./gateway.ts";
import { installation } from "../lib/mode.ts";
import { lstat } from "../lib/fs.ts";
import { setupRoutes } from "./setup.ts";
import { serverRoutes } from "./servers.ts";
import type { Route } from "./http.ts";
import { live, refresh as refreshLimits } from "../live.ts";
import { limitsNow } from "../limits.ts";
import { CHAT_ID, listChats, readChat, removeChat } from "../chats.ts";
import { serviceChats } from "../svc-chat.ts";
import { runsView } from "./runs.ts";
import { memoryApi } from "../memory.ts";
import { tasksView } from "./tasks-view.ts";
import { startAgentd } from "../node/agentd.ts";
import { startTurns } from "../node/turns.ts";
import { loadNodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { desktopNotify } from "../notify.ts";

/** The routes of the console, given the state they share. */
/** The usage database, kept open. The transcripts are read into it at most every few seconds, and only
 *  the ones the watcher saw change (events.ts), from where each was read to; every ten minutes, and
 *  when nothing watches, all of them are looked at again, in case an event was missed. */
const usage = (() => {
  let db: ReturnType<typeof openDb> | null = null, at = 0, scanned = 0, running: Promise<unknown> | null = null;
  return {
    async fresh() {
      db ??= openDb();
      if (Date.now() - at > 3000) {
        if (!running) {
          const now = Date.now(), changed = takeChangedTranscripts();
          const all = !scanned || !changed || now - scanned > 10 * 60_000;
          if (all) scanned = now;
          running = ingest(db, { quiet: true, ...(all ? {} : { only: changed! }) }).finally(() => {
            at = Date.now();
            running = null;
          });
        }
        await running;
      }
      return db;
    },
  };
})();

export function routes(code: string, status: StatusCache, app?: AppLink): Record<string, Route> {
  const body = (req: Request) => req.json().catch(() => ({}));

  return {
    "/api/events": {
      get: ({ url }) => {
        const only = url.searchParams.get("only")?.split(",").filter((t): t is Topic => TOPICS.includes(t as Topic));
        return eventStream(code, only?.length ? only : undefined);
      },
    },
    "/api/code": { get: () => json({ code }) },
    // the CHANGELOG sections after ?since= up to the version on disk: the update wizard's last step
    "/api/whatsnew": { get: async ({ url }) => json(await whatsNew(url.searchParams.get("since"))) },
    "/api/status": { get: async ({ url }) => jsonText((await status.get(url.searchParams.has("fresh"))).body) },
    // the tray's view of the same report: one level and the lines behind it
    "/api/summary": {
      get: async ({ url }) => json(summarize((await status.get(url.searchParams.has("fresh"))).report)),
    },
    // Claude at work: each profile's limits and today's tokens, each session's context (live.ts)
    "/api/live": { get: async () => json(await live()) },
    // the limits asked of Anthropic now, with each profile's login: only when the person asks
    "/api/live/refresh": { post: async () => json({ errors: await refreshLimits(), ...(await live()) }) },
    // every account's usage windows, Claude's and Codex's, each with its age (limits.ts, as `agents limits`)
    "/api/limits": { get: async () => json(await limitsNow()) },
    "/api/sessions": {
      get: async ({ url }) => {
        const db = await usage.fresh();
        return json(sessions(db, {
          since: url.searchParams.get("since") ?? "7d",
          profile: url.searchParams.get("profile") || undefined,
          limit: Number(url.searchParams.get("limit") ?? 60),
        }));
      },
    },
    "/api/brain/login": {
      post: async ({ req }) => {
        try {
          const { account } = await req.json() as { account: string };
          const url = await startBrainLogin(String(account), (r) => {
            recordConnect(account, r);
            status.invalidate();
            broadcast("state");
          });
          // opened here, in the system browser: the page shows the link only when this could not (#14)
          return json({ ok: true, url, opened: tryOpenUrl(url) });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      },
    },
    "/api/google/client": {
      post: async ({ req }) => {
        try {
          const prefix = await storeClient(await req.text());
          broadcast("state");
          return json({ ok: true, message: `OAuth client ${prefix}… stored` });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      },
    },
    "/api/google/connect": {
      post: async ({ req }) => {
        try {
          const { account } = await req.json() as { account: string };
          const url = await startConnect(String(account), (r) => {
            recordConnect(account, r);
            broadcast("state");
          });
          return json({ ok: true, url, opened: tryOpenUrl(url) });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      },
    },
    "/api/accounts": {
      get: async () => json(await accountsView()),
      post: async ({ req }) => {
        const r = await accountOp(await body(req));
        status.invalidate();
        broadcast("state");
        return json(r);
      },
    },
    // the phone's passkeys, and the owner's endorsement of one (ADR 0014); the page confirms before it posts
    "/api/passkeys": {
      get: async () => json(await passkeysView()),
      post: async ({ req }) => {
        const b = await body(req) as { id?: string; fingerprint?: string };
        const r = await endorseOp(String(b.id ?? ""), String(b.fingerprint ?? ""));
        if (r.ok) broadcast("state");
        return json(r);
      },
    },
    "/api/passkeys/revoke": {
      post: async ({ req }) => {
        const b = await body(req) as { id?: string };
        const r = await revokeOp(String(b.id ?? ""));
        if (r.ok) broadcast("state");
        return json(r);
      },
    },
    "/api/permissions": {
      get: async () => json(await permissionsView()),
      post: async ({ req }) => {
        const r = await permissionsOp(await body(req) as PermOp);
        broadcast("state");
        return json(r);
      },
    },
    // which calendars the day shows: detected per connected Google account, chosen here
    "/api/calendars": {
      get: async ({ url }) => json(await listCalendars(url.searchParams.has("fresh"))),
      post: async ({ req }) => {
        const b = await body(req) as { account?: string; id?: string; shown?: boolean };
        const known = (await listCalendars()).find((a) => a.account === b.account)?.calendars.some((c) =>
          c.id === b.id
        );
        if (!known || typeof b.shown !== "boolean") return json({ ok: false, message: "unknown calendar" });
        await setShown(String(b.account), String(b.id), b.shown);
        resetAgenda();
        return json({ ok: true });
      },
    },
    // the day's tasks and events: «Which Claude?» shows the next appointment
    "/api/tasks": {
      get: async () => {
        const cal = await calendarAsTasks(), now = new Date();
        const b = brief([...await listTasks(), ...cal.tasks], now);
        // today's appointments already past: kept above the line for now
        const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const earlier = cal.tasks.filter((t) => t.due === b.day && t.time && t.time < clock);
        return json({ ...b, earlier, calendarErrors: cal.errors });
      },
    },
    // the Tasks view: the day with its times, what is late, the rest by project (tasks-view.ts)
    "/api/tasks/view": {
      get: async () => {
        try {
          const cal = await calendarAsTasks();
          return json({ ...tasksView([...await listTasks(), ...cal.tasks], new Date()), calendarErrors: cal.errors });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      },
    },
    // the one write the view makes: a task is done (a repeating one makes its next)
    "/api/tasks/done": {
      post: async ({ req }) => {
        try {
          const id = String(((await body(req)) as { id?: unknown }).id ?? "");
          if (!id) return json({ ok: false, message: "no task" });
          await updateTask(id, { status: "done" });
          broadcast("brain");
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      },
    },
    // whose console this is: the chat greets them
    "/api/owner": { get: () => json(owner()) },
    // the chats with Claude (chats.ts): the list, one in full, forgetting one; a turn is kept by /api/ask
    "/api/chats": {
      // the local chats and, when this machine is a node of the service, its chats (svc-chat.ts)
      get: async () => {
        const [local, remote] = await Promise.all([listChats(), serviceChats.list()]);
        return json([...local, ...remote ?? []].sort((a, b) => b.updated.localeCompare(a.updated)));
      },
      post: async ({ req }) => {
        const b = await body(req) as { op?: string; id?: string };
        if (b.op !== "delete") return json({ ok: false, message: "unknown op" }, 400);
        const id = String(b.id ?? "");
        return json({ ok: CHAT_ID.test(id) ? await removeChat(id) : await serviceChats.remove(id) });
      },
    },
    "/api/chat": {
      get: async ({ url }) => {
        const id = url.searchParams.get("id") ?? "";
        const c = CHAT_ID.test(id) ? await readChat(id) : /^[\w-]{1,64}$/.test(id) ? await serviceChats.get(id) : null;
        return c ? json(c) : json({ error: "no such chat" }, 404);
      },
    },
    // the agents hub: the workflow runs and the agents started lately, read only (runs.ts)
    "/api/runs": { get: async () => json(await runsView()) },
    "/api/profile": {
      post: async ({ req }) => {
        const r = await saveProfile(await body(req));
        status.invalidate();
        broadcast("state");
        return json(r, r.error ? 400 : 200);
      },
    },
    // «Close Claude and update»: who holds the waiting install (or a Desktop to replace), then
    // SIGTERM, SIGKILL, reopen. The PIDs are always the server's own; the page only names a step, what
    // it is for, and the profiles to reopen
    "/api/close-claude": {
      get: async ({ url }) => {
        const why = parsePurpose(url.searchParams.get("for"));
        return why ? json(await closePlan(why)) : json({ ok: false, message: "unknown purpose" }, 400);
      },
      post: async ({ req }) => {
        const b = await body(req) as { step?: string; for?: string; profiles?: string[] };
        if (b.step === "term" || b.step === "kill") {
          const why = parsePurpose(b.for);
          if (!why) return json({ ok: false, message: "unknown purpose" }, 400);
          const r = await closeSessions(b.step === "term" ? "SIGTERM" : "SIGKILL", why);
          status.invalidate();
          broadcast("state");
          return json(r);
        }
        if (b.step === "reopen") return json({ ok: true, started: await reopen(b.profiles ?? []) });
        return json({ ok: false, message: "unknown step" }, 400);
      },
    },
    // «Which Claude?»: the profiles, and opening one's Claude Desktop (the picker at /#pick)
    "/api/launch": {
      get: async () => json(await launchList()),
      post: async ({ req }) => {
        const r = await launchOne(await body(req));
        return json(r, r.ok ? 200 : 400);
      },
    },
    "/api/action": {
      post: async ({ req }) => {
        const b = await body(req) as { action?: string; opts?: string[]; params?: Record<string, string> };
        const r = await runAction(String(b.action ?? ""), b.opts ?? [], b.params ?? {});
        status.invalidate();
        broadcast("state");
        return json(r);
      },
    },
    // a long action with its output streamed: start, follow (one JSON per line), cancel
    "/api/job": {
      get: ({ url }) => jobStream(url.searchParams.get("id") ?? "") ?? json({ error: "no such job" }, 404),
      post: async ({ req }) => {
        const b = await body(req) as { action?: string; opts?: string[]; params?: Record<string, string> };
        const r = await startJob(String(b.action ?? ""), b.opts ?? [], b.params ?? {}, () => {
          status.invalidate();
          broadcast("state");
        });
        return json(r, r.ok ? 200 : 400);
      },
    },
    "/api/job/cancel": {
      post: async ({ req }) => json({ ok: cancelJob(String((await body(req) as { id?: string }).id ?? "")) }),
    },
    // the first-run wizard: where a new person's setup is, and its steps (setup.ts)
    ...setupRoutes(status),
    // Connections › Add a server: a server node paired from its code (servers.ts, ADR 0013 F2)
    ...serverRoutes(),
    // the desktop app's own updates, relayed to and from the app (app-update.ts)
    ...(app ? { "/api/app/update": appUpdateRoute(app) } : {}),
  };
}

/**
 * The request handler over a route table: the local-host guard, the token (token.ts), then the table (POST handlers
 * behind the anti-CSRF header, 405 for a POST-only path), then the feature modules, then the
 * page's files (from `uiDist`, the interface's build). An exception becomes a 500 with its message
 * (the console is local).
 */
export function createHandler(
  table: Record<string, Route>,
  auth: Auth,
  uiDist: string = UI_DIST,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (!isLocalHost(req)) return new Response("forbidden host", { status: 403 });
    const u = new URL(req.url);
    const verdict = gate({ method: req.method, url: u, headers: req.headers }, auth);
    if (verdict.kind !== "pass") return answer(verdict, auth.token);
    try {
      const route = table[u.pathname];
      if (route) {
        if (req.method === "POST" && route.post) {
          return hasCsrfHeader(req) ? await route.post({ req, url: u }) : json({ error: "missing header" }, 403);
        }
        if (route.get) return await route.get({ req, url: u });
        return json({ error: "POST required" }, 405);
      }
      const delegated = await assetsApi(u) ?? await askApi(req, u, json, () => broadcast("chats")) ??
        (req.method === "GET" ? await memoryApi(u) : null);
      if (delegated) return delegated;
      return await uiFile(uiDist, u.pathname);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };
}

/** The variables the desktop app set for its backend alone (AGENTS_MULTI_BACKEND_ONLY, a comma list, e.g.
 *  DENO_DIR: the app's read-only cache) leave this process's environment, so the programs the console
 *  starts (Claude and its MCP servers, the CLI) get the person's own. Deno has read them by now. */
export function forgetBackendOnly(env: Pick<typeof Deno.env, "get" | "delete"> = Deno.env) {
  const names = env.get("AGENTS_MULTI_BACKEND_ONLY")?.split(",").map((n) => n.trim()).filter(Boolean) ?? [];
  for (const n of [...names, "AGENTS_MULTI_BACKEND_ONLY"]) env.delete(n);
}

/** A Claude session's variables (shared/mcp/lib/agents.ts): an app started from inside one (a terminal
 *  in Claude, a tool call) inherits them, and the Claudes the console starts then took that session's
 *  profile, permissions and sandbox for theirs: no keyring, no brain. */
export { claudeSessionVars };

/** Starts the console and resolves when it stops. `open` opens it in the default browser; `headless`: a server's
 *  agentd (ADR 0012), which never opens a page and runs routines and jobs only inside the Bash sandbox. */
export async function serve(opts: { open?: boolean; headless?: boolean } = { open: true }) {
  if (opts.headless && !(await loadNodeConfig()).headless) {
    // the children's sandbox comes from node.json: a headless backend without it would run them unsandboxed
    throw new Error("serve --headless needs a headless node: agents node enable --headless");
  }
  forgetBackendOnly();
  for (const n of claudeSessionVars(Object.keys(Deno.env.toObject()))) Deno.env.delete(n);
  const url = `http://127.0.0.1:${PORT}`;
  const code = await codeVersion();
  const status = new StatusCache();
  const app = new AppLink(unixDial(appSocket()), () => broadcast("app-update"));
  const table = routes(code, status, app);
  const ac = new AbortController();

  // a state change outdates the kept report, lazily: state events are frequent while sessions run,
  // and only a page asking needs the report
  onTopic((topic) => {
    if (topic === "state") status.invalidate();
  });
  void status.refresh().catch(() => {}); // warm: the first page after a start is not the one to wait
  void claudeAssets(); // the scan of Desktop's bundle, done before the first page asks for it

  // the token of this start, in a file only this user reads; gone when the console stops cleanly
  const auth: Auth = { token: newToken(), tickets: new Tickets() };
  const file = tokenPath(PORT);
  const unpublish = await publishToken(file, auth.token);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        unpublish();
        Deno.exit(0);
      });
    } catch { /* a signal this platform does not have */ }
  }
  const handler = createHandler(table, auth);

  // the key to the page: on a terminal the person may copy it; elsewhere (the app's log) it stays out
  const entry = Deno.stdout.isTerminal() ? `${url}/?k=${auth.token}` : url;
  console.log(`${ANSI.b}agents serve${ANSI.x} — ${entry}  ${ANSI.d}(Ctrl-C to stop; localhost only)${ANSI.x}`);
  if (entry === url) console.log(`${ANSI.d}access key: ${file}${ANSI.x}`);
  void watchTree(ac.signal);
  void watchBrain(ac.signal, connectTasks() === "brain");
  void app.follow(ac.signal);
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {}, signal: ac.signal }, handler);
  // only the machine's console runs its jobs and keeps the gateway: a second one (another port) would run
  // every schedule twice and restart the shared gateway with its own code
  const own = machineConsole(PORT);
  if (!own) console.log(`${ANSI.d}not on port ${DEFAULT_PORT}: no schedules, routines or gateway here${ANSI.x}`);
  // app mode: the timers' jobs are the backend's (schedule.ts); dev mode keeps its systemd timers
  if (own && (await installation()).mode === "app") {
    const stop = startSchedule(jobsFor({
      repo: REPO,
      graphical: !!(Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY")),
      brain: !!brainAccount(),
      syncthing: !!(await lstat(SYNCTHING_CONFIG)),
    }));
    ac.signal.addEventListener("abort", stop);
  }
  if (own) {
    // the routines (ADR 0010), in both modes, through agentd (ADR 0012): on a headless node only while the Bash
    // sandbox works; and when the node is on, its announcements, jobs and checkpoints
    ac.signal.addEventListener("abort", startLimitsScan());
    ac.signal.addEventListener(
      "abort",
      startAgentd({
        headless: !!opts.headless,
        log: console.log,
        notify: (title, body) => void desktopNotify(title, body).catch(() => {}),
        startRoutines: () => startRoutineSchedule(),
        startTurns: () => startTurns(console.log),
      }),
    );
    // the lazy MCP gateway (ADR 0008), when it is on: a process of its own that this one keeps up
    superviseGateway(ac.signal);
  }
  if (opts.open && !opts.headless) {
    // a one-use ticket, not the token: the command line of the opener is readable by other users
    const entryUrl = `${url}/?k=${auth.tickets.issue()}`;
    try {
      openUrl(entryUrl);
    } catch { /* no browser */ }
  }
  try {
    await srv.finished;
  } finally {
    unpublish();
  }
}
