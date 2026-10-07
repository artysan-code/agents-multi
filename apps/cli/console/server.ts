// server.ts — the local console: `claude-multi serve` listens on http://127.0.0.1:7331 and serves
// the page in apps/cli/dashboard/ (no build step, works offline) and its API.
//
// Routes are a table: each path has a GET handler, a POST handler, or both. A POST handler runs only
// with the anti-CSRF header; a path with only a POST handler answers 405 to anything else. The
// feature modules that own a group of paths (ask, task board, memory, Claude's assets) answer
// theirs before the static files.

import { ANSI } from "../lib/output.ts";
import { PORT, REPO } from "../lib/paths.ts";
import { codeVersion } from "../codeversion.ts";
import { summarize } from "../status.ts";
import { ingest, openDb, sessions } from "../usage.ts";
import { startConnect, storeClient } from "../google.ts";
import { startBrainLogin } from "../brain-login.ts";
import { calendarAsTasks, resetAgenda } from "../agenda.ts";
import { listCalendars, setShown } from "../calendars.ts";
import { taskApi } from "../taskboard.ts";
import { askApi } from "../ask.ts";
import { assetsApi, claudeAssets } from "../claude-assets.ts";
import { brainGraph, brainPage } from "../brain.ts";
import { memoryApi } from "../memory.ts";
import { permissionsOp, permissionsView, type PermOp } from "../permissions.ts";
import { catalog, catalogPage, details, inventory, type PluginOp, pluginOp } from "../plugins.ts";
import { owner } from "../../../shared/mcp/lib/owner.ts";
import { addTask, brief, listTasks, type TaskInput, updateTask } from "../../../shared/mcp/lib/tasks.ts";
import { connectTasks } from "../../../shared/mcp/lib/brain-tasks.ts";
import { hasCsrfHeader, isLocalHost, json, jsonText, staticFile } from "./http.ts";
import { broadcast, eventStream, onTopic, watchBrain, watchTree } from "./events.ts";
import { StatusCache } from "./status-cache.ts";
import { runAction } from "./actions.ts";
import { cancelJob, jobStream, startJob } from "./jobs.ts";
import { closePlan, closeSessions, reopen } from "./close-claude.ts";
import { saveProfile } from "./profiles.ts";
import { accountOp, accountsView, recordConnect } from "./accounts.ts";

const DASH = `${REPO}/apps/cli/dashboard`;

interface Ctx {
  req: Request;
  url: URL;
}
export type Handler = (c: Ctx) => Promise<Response> | Response;
export interface Route {
  get?: Handler;
  post?: Handler;
}

/** The routes of the console, given the state they share. */
export function routes(code: string, status: StatusCache): Record<string, Route> {
  let plugins: { at: number; body: string } | null = null;
  const body = (req: Request) => req.json().catch(() => ({}));

  return {
    "/api/events": { get: () => eventStream(code) },
    "/api/code": { get: () => json({ code }) },
    "/api/status": { get: async ({ url }) => jsonText((await status.get(url.searchParams.has("fresh"))).body) },
    // the tray's view of the same report: one level and the lines behind it
    "/api/summary": {
      get: async ({ url }) => json(summarize((await status.get(url.searchParams.has("fresh"))).report)),
    },
    "/api/sessions": {
      get: async ({ url }) => {
        const db = openDb();
        await ingest(db, { quiet: true });
        const r = sessions(db, {
          since: url.searchParams.get("since") ?? "7d",
          profile: url.searchParams.get("profile") || undefined,
          limit: Number(url.searchParams.get("limit") ?? 60),
        });
        db.close();
        return json(r);
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
          return json({ ok: true, url });
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
          return json({ ok: true, url });
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
        broadcast("tasks");
        return json({ ok: true });
      },
    },
    "/api/tasks": {
      get: async () => {
        const cal = await calendarAsTasks(), now = new Date();
        const b = brief([...await listTasks(), ...cal.tasks], now);
        // today's appointments already past: the day on the page keeps them above the line for now
        const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const earlier = cal.tasks.filter((t) => t.due === b.day && t.time && t.time < clock);
        return json({ ...b, earlier, calendarErrors: cal.errors });
      },
      post: async ({ req }) => {
        const b = await body(req) as TaskInput & { op?: string; id?: string };
        try {
          const { op, id, ...input } = b;
          const r = op === "add" ? { task: await addTask(input) } : await updateTask(String(id ?? ""), input);
          broadcast("tasks");
          return json({ ok: true, task: r.task });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      },
    },
    // whose console this is: the tasks page needs the id
    "/api/owner": { get: () => json(owner()) },
    // the old wiki, read-only: the Brain page's Archive
    "/api/archive": { get: async () => json(await brainGraph()) },
    "/api/archive/page": { get: async ({ url }) => json(await brainPage(url.searchParams.get("path") ?? "")) },
    "/api/profile": {
      post: async ({ req }) => {
        const r = await saveProfile(await body(req));
        status.invalidate();
        broadcast("state");
        return json(r, r.error ? 400 : 200);
      },
    },
    "/api/plugins": {
      get: async ({ url }) => {
        if (!plugins || url.searchParams.has("fresh") || Date.now() - plugins.at > 15000) {
          plugins = { at: Date.now(), body: JSON.stringify(await inventory()) };
        }
        return jsonText(plugins.body);
      },
      post: async ({ req }) => {
        const r = await pluginOp(await body(req) as PluginOp);
        plugins = null;
        status.invalidate();
        broadcast("state");
        return json(r); // a refused operation is a result (ok: false, message), not an HTTP error
      },
    },
    "/api/plugins/catalog": {
      // one page at a time, filtered here: the whole catalog is thousands of entries and never leaves the server
      get: async ({ url }) => {
        const all = await catalog(url.searchParams.has("fresh")), g = (k: string) => url.searchParams.get(k);
        return json({
          ...catalogPage(all, {
            q: g("q") ?? "",
            mk: g("mk") ?? "",
            offset: Number(g("offset")),
            limit: Number(g("limit")),
          }),
          marketplaces: [...new Set(all.map((c) => c.marketplace))].sort(),
        });
      },
    },
    "/api/plugins/details": {
      get: async ({ url }) => json({ text: await details(url.searchParams.get("id") ?? "") }),
    },
    // «Close Claude and update»: who holds the waiting install, then SIGTERM, SIGKILL, reopen. The PIDs
    // are always the server's own; the page only names a step (and the profiles to reopen)
    "/api/close-claude": {
      get: async () => json(await closePlan()),
      post: async ({ req }) => {
        const b = await body(req) as { step?: string; profiles?: string[] };
        if (b.step === "term" || b.step === "kill") {
          const r = await closeSessions(b.step === "term" ? "SIGTERM" : "SIGKILL");
          status.invalidate();
          broadcast("state");
          return json(r);
        }
        if (b.step === "reopen") return json({ ok: true, started: await reopen(b.profiles ?? []) });
        return json({ ok: false, message: "unknown step" }, 400);
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
  };
}

/**
 * The request handler over a route table: the local-host guard, then the table (POST handlers
 * behind the anti-CSRF header, 405 for a POST-only path), then the feature modules, then the
 * page's files. An exception becomes a 500 with its message (the console is local).
 */
export function createHandler(table: Record<string, Route>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (!isLocalHost(req)) return new Response("forbidden host", { status: 403 });
    const u = new URL(req.url);
    try {
      const route = table[u.pathname];
      if (route) {
        if (req.method === "POST" && route.post) {
          return hasCsrfHeader(req) ? await route.post({ req, url: u }) : json({ error: "missing header" }, 403);
        }
        if (route.get) return await route.get({ req, url: u });
        return json({ error: "POST required" }, 405);
      }
      const delegated = await assetsApi(u) ??
        await askApi(req, u, json) ??
        await taskApi(req, u, json, () => broadcast("tasks")) ??
        (req.method === "GET" ? await memoryApi(u) : null);
      if (delegated) return delegated;
      return await staticFile(DASH, u.pathname);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };
}

/** Starts the console and resolves when it stops. `open` opens it in the default browser. */
export async function serve(opts: { open?: boolean } = { open: true }) {
  const url = `http://127.0.0.1:${PORT}`;
  const code = await codeVersion();
  const status = new StatusCache();
  const table = routes(code, status);
  const ac = new AbortController();

  // a state change outdates the kept report, lazily: state events are frequent while sessions run,
  // and only a page asking needs the report
  onTopic((topic) => {
    if (topic === "state") status.invalidate();
  });
  void status.refresh().catch(() => {}); // warm: the first page after a start is not the one to wait
  void claudeAssets(); // the scan of Desktop's bundle, done before the first page asks for it

  const handler = createHandler(table);

  console.log(`${ANSI.b}claude-multi serve${ANSI.x} — ${url}  ${ANSI.d}(Ctrl-C to stop; localhost only)${ANSI.x}`);
  void watchTree(ac.signal);
  void watchBrain(ac.signal, connectTasks() === "brain");
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {}, signal: ac.signal }, handler);
  if (opts.open) {
    try {
      new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn().unref();
    } catch { /* no browser */ }
  }
  await srv.finished;
}
