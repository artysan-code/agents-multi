// brain-tasks.ts — the owner's tasks kept in their brain (apps/brain/main.ts, /api/tasks) instead of the files
// under ~/brains/tasks: the same TaskStore, over HTTP, with a personal token from the vault.
//
// A process switches to it when accounts.json has a `brain` account its profile sees. From then on
// the brain is the only list: when it cannot be reached, or this machine has no token for it,
// reading and writing fail and say why. They never fall back to the old files, which would split
// the list in two again. The task rules stay in tasks.ts, on this side; the brain stores the files.

import { type Account, loadAccounts, visibleAccounts } from "./accounts.ts";
import { fromFile, StaleError, type Task, type TaskStore, toFile, useTaskStore } from "./tasks.ts";
import { getSecret } from "./vault.ts";
import { amEnv } from "./env.ts";

/** How long to wait before each new try while the brain restarts (a deploy takes it away for seconds). */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000];

/** Pure: whether a failed try is worth another. The proxy answers 502 or 503 while the brain is not
 *  up, so the request never reached it and a write is safe to send again. No answer at all means this
 *  machine or the server is offline, which seconds do not fix: that error comes at once. */
export const retriable = (r: Response | null) => r?.status === 502 || r?.status === 503;

/** The TaskStore on a brain at `url`, signed in with a personal token. */
export function brainStore(
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
  pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms)),
): TaskStore {
  const base = url.replace(/\/+$/, "");
  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown> | null> {
    let r: Response | null = null;
    for (let i = 0;; i++) {
      let err: Error | null = null;
      try {
        r = await fetcher(`${base}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...init.headers },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        r = null;
        err = e as Error;
      }
      if (i >= RETRY_MS.length || !retriable(r)) {
        if (err) throw new Error(`the brain at ${base} is not answering (${err.message}): the tasks are there`);
        break;
      }
      await r?.body?.cancel();
      await pause(RETRY_MS[i]);
    }
    r = r!;
    if (r.status === 404 && !init.method) {
      await r.body?.cancel();
      return null;
    }
    // the task changed on the brain since this machine read it: the brain sends it as it is now
    if (r.status === 409) {
      const cur = fromFile(String(((await r.json().catch(() => ({}))) as { task?: unknown }).task ?? ""));
      if (cur) throw new StaleError(cur);
      throw new Error(`the brain answered 409 on ${path}`);
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(
        r.status === 401
          ? "the brain refused the token in the vault: sign this machine in again (console › Connections › Sign in, or agents brain-login)"
          : `the brain answered ${r.status} on ${path}`,
      );
    }
    return await r.json();
  }
  return {
    async list() {
      const d = await call("/api/tasks");
      return ((d?.tasks ?? []) as string[]).map((b) => fromFile(b)).filter((t): t is Task => !!t);
    },
    async get(id) {
      const d = await call(`/api/tasks/${id}`);
      return d ? fromFile(String(d.task)) : null;
    },
    async write(t, base) {
      await call(`/api/tasks/${t.id}`, {
        method: "PUT",
        body: toFile(t),
        headers: { "content-type": "text/markdown", ...(base ? { "if-match": base } : {}) },
      });
    },
  };
}

/** Pure: a store that sees only the tasks of some projects (folder prefixes), for a work profile
 *  whose conversations belong to someone else's account. A task outside is invisible, and one
 *  cannot be written outside. */
export function scoped(store: TaskStore, prefixes: string[]): TaskStore {
  const inside = (t: Task | null): t is Task =>
    !!t?.project && prefixes.some((p) => t.project === p || t.project!.startsWith(`${p}/`));
  return {
    list: async () => (await store.list()).filter(inside),
    get: async (id) => {
      const t = await store.get(id);
      return inside(t) ? t : null;
    },
    write: (t, base) =>
      inside(t) ? store.write(t, base) : Promise.reject(
        new Error(
          `in this profile a task belongs to one of these projects: ${
            prefixes.join(", ")
          } — give it one (folder under ~)`,
        ),
      ),
  };
}

/** The store on a brain account whose token is read from the vault when first needed, and read again
 *  while it is missing: a process started before the vault could be read (at login, before
 *  Syncthing or the keyring) would otherwise say "no token" until restarted. */
export function lazyStore(account: Account, token: () => Promise<string | null>, make = brainStore): TaskStore {
  let store: TaskStore | null = null;
  const ready = async () => {
    if (store) return store;
    const t = await token().catch(() => null);
    if (!t) {
      throw new Error(
        `no token for the brain on this machine: make one on ${account.url}/account and put it in the console, Connections`,
      );
    }
    return store = make(account.url!, t);
  };
  return {
    list: async () => (await ready()).list(),
    get: async (id) => (await ready()).get(id),
    write: async (t) => (await ready()).write(t),
  };
}

/** The brain account a profile sees, if there is one. */
export function brainAccount(
  profile = amEnv("PROFILE") || undefined,
  all: Account[] = loadAccounts(),
): Account | null {
  return visibleAccounts(all, "brain", profile).find((a) => !!a.url) ?? null;
}

/** Point this process's tasks at the brain when there is a brain account; say where they are. */
export function connectTasks(): "brain" | "files" {
  const account = brainAccount();
  if (!account) return "files";
  const store = lazyStore(account, () => getSecret("brain", account.name));
  const scope = (amEnv("BRAIN_SCOPE") ?? "").split(",").map((s) => s.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  useTaskStore(scope.length ? scoped(store, scope) : store);
  return "brain";
}
