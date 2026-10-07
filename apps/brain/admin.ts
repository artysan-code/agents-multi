#!/usr/bin/env -S deno run --allow-net=127.0.0.1 --allow-read --allow-write --allow-env
// admin — the brain's administration from a shell, for whoever runs the server and has no browser
// handy (in the container: `brain-admin <command>`). It does what the administrator's page does,
// with the same functions (users.ts, auth.ts), on the same files the server has open: accounts.db
// with the server's own WAL settings, every statement short, so the two take turns.
//
//   admin.ts list                          the accounts
//   admin.ts create <id> <name…> [--language L]   a new account: its invitation link, shown once
//   admin.ts disable <id> | enable <id>
//   admin.ts reset <id>                    lockout lifted, ways in cut off, a new invitation link
//   admin.ts unlock <id>                   only the lockout lifted
//   admin.ts delete <id> --yes             the account and its brain, for good
//   admin.ts stats                         pages, tasks and database sizes
//   admin.ts backup                        a sealed copy of every database now (BRAIN_BACKUP_KEY)
//   admin.ts restore <file> [--yes]        a copy back in place: stop the server first (README)

import { DatabaseSync } from "node:sqlite";
import { Auth } from "./auth.ts";
import { backupAll, restoreCopy, restoreTarget } from "./backups.ts";
import { tenantFile } from "./tenants.ts";
import { masterKey, Users } from "./users.ts";

export interface AdminConfig {
  data: string;
  /** BRAIN_MASTER_KEY, base64 */
  masterKey: string;
  /** BRAIN_URL, to write invitation links in full */
  url: string;
  /** BRAIN_BACKUP_KEY, base64 */
  backupKey: string | undefined;
  keep: number;
  /** Whether a server answers on this machine: restore refuses while one does */
  serving: () => Promise<boolean>;
}

const USAGE = `usage: admin.ts <command>
  list | stats | backup
  create <id> <name…> [--language L]
  disable <id> | enable <id> | reset <id> | unlock <id>
  delete <id> --yes
  restore <file> [--yes]`;

const kb = (n: number) => n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A database's size on disk with its WAL, or 0 when there is none. */
function sizeOf(file: string): number {
  let n = 0;
  for (const s of ["", "-wal"]) {
    try {
      n += Deno.statSync(`${file}${s}`).size;
    } catch { /* absent */ }
  }
  return n;
}

/** Runs one command; what it prints goes to `out`, a refusal is thrown. Returns the exit code. */
export async function admin(argv: string[], cfg: AdminConfig, out: (line: string) => void): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && a !== "--language"));
  const li = argv.indexOf("--language");
  const language = li >= 0 ? argv[li + 1] ?? "" : "";
  const args = argv.filter((a, i) => !a.startsWith("--") && !(li >= 0 && i === li + 1));
  const [cmd, id = "", ...rest] = args;
  const need = (what: boolean, msg: string) => {
    if (!what) throw new Error(msg);
  };

  if (cmd === "backup" || cmd === "restore") {
    need(!!cfg.backupKey, "BRAIN_BACKUP_KEY is not set");
    if (cmd === "backup") {
      const r = await backupAll(cfg.data, cfg.backupKey!, cfg.keep);
      out(`${r.dir}: ${r.files.join(", ")} (keeping ${cfg.keep})`);
      return 0;
    }
    need(!!id, USAGE);
    const target = restoreTarget(cfg.data, id);
    if (!flags.has("--yes")) {
      need(!(await cfg.serving()), "the server is running: stop it first (or pass --yes if you know it is not)");
      need(
        !(await Deno.stat(`${target}-shm`).catch(() => null)),
        `${target}-shm exists: something holds the database (stop the server; --yes if it is stale)`,
      );
    }
    out(`restored ${await restoreCopy(cfg.data, id, cfg.backupKey!)} (the old one is kept as .pre-restore)`);
    return 0;
  }

  await Deno.mkdir(cfg.data, { recursive: true });
  const db = new DatabaseSync(`${cfg.data}/accounts.db`);
  try {
    db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    const users = new Users(db, await masterKey(cfg.masterKey));
    const auth = new Auth(db, users, { url: cfg.url });
    const account = (a: string) => {
      const u = users.get(a.trim().toLowerCase());
      if (!u) throw new Error(`no account ${a}`);
      return u;
    };
    const link = (t: string) => cfg.url ? `${cfg.url}/invite?t=${t}` : `/invite?t=${t} (BRAIN_URL is not set)`;

    switch (cmd) {
      case "list":
        for (const u of users.list()) {
          out([
            u.id.padEnd(16),
            u.name.padEnd(24),
            u.admin ? "admin" : "     ",
            u.disabled ? "disabled" : u.ready ? "active  " : "invited ",
            u.created.slice(0, 10),
          ].join(" "));
        }
        return 0;
      case "create": {
        need(!!id && !!rest.length, USAGE);
        const t = await users.invite(id.toLowerCase(), rest.join(" "), language || "Italian");
        out(`account ${id.toLowerCase()} created. Invitation, shown once (7 days, one use):`);
        out(link(t));
        return 0;
      }
      case "disable":
      case "enable": {
        const u = account(id);
        users.setDisabled(u.id, cmd === "disable");
        if (cmd === "disable") auth.revokeAll(u.id);
        out(`${u.id} ${cmd}d`);
        return 0;
      }
      case "reset": {
        // the shell is how an administrator who lost their way in gets back, so it may reset them too
        const u = account(id);
        const t = await users.reinvite(u.id);
        auth.revokeAll(u.id);
        auth.unlock(u.id);
        out(`${u.id}: passphrase, TOTP and every token cleared. New invitation, shown once (7 days, one use):`);
        out(link(t));
        return 0;
      }
      case "unlock":
        auth.unlock(account(id).id);
        out(`${id}: failed sign-ins forgotten`);
        return 0;
      case "delete": {
        const u = account(id);
        need(flags.has("--yes"), `this deletes ${u.id} and their whole brain for good: take a backup, then pass --yes`);
        users.remove(u.id); // refuses the administrator
        auth.forget(u.id);
        await Deno.remove(tenantFile(cfg.data, u.id).replace(/\/brain\.db$/, ""), { recursive: true }).catch(() => {});
        out(`${u.id} deleted (restart the server if it is running, so it lets go of their database)`);
        return 0;
      }
      case "stats": {
        out(`accounts.db ${kb(sizeOf(`${cfg.data}/accounts.db`))}`);
        for (const u of users.list()) {
          const file = tenantFile(cfg.data, u.id);
          if (!sizeOf(file)) {
            out(`${u.id.padEnd(16)} no brain yet`);
            continue;
          }
          const b = new DatabaseSync(file, { readOnly: true });
          try {
            b.exec("pragma busy_timeout = 5000");
            const n = (q: string) => (b.prepare(q).get() as { n: number }).n;
            out(
              `${u.id.padEnd(16)} ${
                String(n("select count(*) n from docs where deleted = 0 and path not like 'tasks/%'")).padStart(6)
              } pages ${
                String(n("select count(*) n from docs where deleted = 0 and path like 'tasks/t-%'")).padStart(6)
              } tasks ${kb(sizeOf(file)).padStart(9)}`,
            );
          } finally {
            b.close();
          }
        }
        return 0;
      }
      default:
        out(USAGE);
        return cmd ? 2 : 0;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const port = env("PORT") ?? "8080";
  const masterKey = env("BRAIN_MASTER_KEY");
  if (!masterKey) {
    console.error("brain-admin: BRAIN_MASTER_KEY is required (it is in the container's environment)");
    Deno.exit(2);
  }
  const keep = Number(env("BRAIN_BACKUP_KEEP") ?? 7);
  try {
    Deno.exit(
      await admin(Deno.args, {
        data: env("BRAIN_DATA") ?? "/data",
        masterKey,
        url: (env("BRAIN_URL") ?? "").replace(/\/+$/, ""),
        backupKey: env("BRAIN_BACKUP_KEY"),
        keep: Number.isInteger(keep) && keep > 0 ? keep : 7,
        serving: () =>
          fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(
            (r) => r.ok,
            () => false,
          ),
      }, console.log),
    );
  } catch (e) {
    console.error(`brain-admin: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
