// tenants.ts — each person's brain: their own SQLite file under /data/users/<id>/brain.db, with its
// indexer and its task list. This is the only place that turns an account into a file: every
// request reaches a database through `open(user)`, with the account the token or the session gave,
// never with a path built anywhere else. A person's data and another's never share a file.

import { type EmbedConfig, indexer } from "./embed.ts";
import { Store } from "./store.ts";
import { areasFor } from "./rules.ts";
import { USER_ID } from "./users.ts";
import { fromFile, StaleError, type Task, type TaskStore, toFile } from "../../shared/mcp/lib/tasks.ts";

export interface Tenant {
  user: string;
  file: string;
  store: Store;
  index: ReturnType<typeof indexer>;
  tasks: TaskStore;
}

/** Pure: the database file of an account, or an error for an id that is not one. */
export function tenantFile(dataDir: string, user: string): string {
  if (!USER_ID.test(user)) throw new Error(`not an account id: ${JSON.stringify(user)}`);
  return `${dataDir.replace(/\/+$/, "")}/users/${user}/brain.db`;
}

export class Tenants {
  private open_ = new Map<string, Tenant>();
  constructor(
    private dataDir: string,
    private embed: EmbedConfig,
    private by: () => string,
    /** The account's language, which names its areas. */
    private languageOf: (user: string) => string = () => "Italian",
  ) {}

  open(user: string): Tenant {
    const hit = this.open_.get(user);
    if (hit) return hit;
    const file = tenantFile(this.dataDir, user);
    Deno.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    const store = new Store(file);
    store.areas = areasFor(this.languageOf(user));
    const index = indexer(store, this.embed);
    // tasks live here as documents under tasks/, with the rules of shared/mcp/lib/tasks.ts on top
    const tasks: TaskStore = {
      list: () => Promise.resolve(store.taskBodies().map((b) => fromFile(b)).filter((t): t is Task => !!t)),
      get: (id) => Promise.resolve(fromFile(store.get(`tasks/${id}.md`)?.body ?? "")),
      // read, compared and written with no await in between: two requests cannot interleave here
      write: (t, base) => {
        if (base) {
          const cur = fromFile(store.get(`tasks/${t.id}.md`)?.body ?? "");
          if (cur && cur.updated !== base) return Promise.reject(new StaleError(cur));
        }
        store.write(`tasks/${t.id}.md`, toFile(t), this.by());
        index.kick();
        return Promise.resolve();
      },
    };
    const t: Tenant = { user, file, store, index, tasks };
    this.open_.set(user, t);
    return t;
  }

  /** Every open brain closed: its indexer stopped, its file released. */
  close() {
    for (const t of this.open_.values()) {
      t.index.stop();
      t.store.db.close();
    }
    this.open_.clear();
  }
}
