// brain-tasks.ts — Samuel's tasks kept in his brain (brain/main.ts, /api/tasks) instead of the files
// under ~/brains/tasks: the same TaskStore, over HTTP, with a personal token from the vault.
//
// A process switches to it when accounts.json has a `brain` account its profile sees. From then on
// the brain is the only list: when it cannot be reached, or this machine has no token for it,
// reading and writing fail and say why. They never fall back to the old files, which would split
// the list in two again. The task rules stay in tasks.ts, on this side; the brain stores the files.

import { type Account, loadAccounts, visibleAccounts } from "./accounts.ts";
import { fromFile, type Task, type TaskStore, toFile, useTaskStore } from "./tasks.ts";
import { getSecret } from "./vault.ts";

/** The TaskStore on a brain at `url`, signed in with a personal token. */
export function brainStore(url: string, token: string, fetcher: typeof fetch = fetch): TaskStore {
  const base = url.replace(/\/+$/, "");
  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown> | null> {
    let r: Response;
    try {
      r = await fetcher(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new Error(`the brain at ${base} is not answering (${(e as Error).message}): the tasks are there`);
    }
    if (r.status === 404 && !init.method) { await r.body?.cancel(); return null; }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(r.status === 401 ? "the brain refused the token in the vault: make a new one on its /account page and put it in the console, Connections" : `the brain answered ${r.status} on ${path}`);
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
    async write(t) {
      await call(`/api/tasks/${t.id}`, { method: "PUT", body: toFile(t), headers: { "content-type": "text/markdown" } });
    },
  };
}

/** A store that only says why there is no list: a brain account without its token on this machine. */
function missing(why: string): TaskStore {
  const fail = () => Promise.reject(new Error(why));
  return { list: fail, get: fail, write: fail };
}

/** The brain account a profile sees, if there is one. */
export function brainAccount(profile = Deno.env.get("CLAUDE_MULTI_PROFILE") || undefined, all: Account[] = loadAccounts()): Account | null {
  return visibleAccounts(all, "brain", profile).find((a) => !!a.url) ?? null;
}

/** Point this process's tasks at the brain when there is a brain account; say where they are. */
export async function connectTasks(): Promise<"brain" | "files"> {
  const account = brainAccount();
  if (!account) return "files";
  const token = await getSecret("brain", account.name).catch(() => null);
  useTaskStore(token ? brainStore(account.url!, token) : missing(`no token for the brain on this machine: make one on ${account.url}/account and put it in the console, Connections`));
  return "brain";
}
