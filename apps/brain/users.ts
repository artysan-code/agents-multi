// users.ts — the people of the brain: their accounts, the invitations that create them, and the
// secrets each one has here. One brain service serves several people; each has a database of their
// own (tenants.ts) and signs in with an id, a passphrase and a TOTP code.
//
// Accounts are made by the administrator only, as an invitation: a one-time link where the person
// chooses their passphrase and adds the TOTP secret to their authenticator. Nobody signs up alone.
// The administrator can read every database on the server, as the owner of any server can: the
// invitation page says so.
//
// Nothing secret is kept as itself. The passphrase is a PBKDF2 hash; the TOTP secret and the backup
// key (which seals the copies a person's machines keep) are encrypted with BRAIN_MASTER_KEY, which
// lives only in the server's environment.

import type { DatabaseSync } from "node:sqlite";
import { ACCOUNTS_MIGRATIONS, base32Encode, randomToken, same, sha256, totpOk } from "./auth.ts";
import { migrate } from "./migrate.ts";
import { validZone } from "../../shared/mcp/lib/tasks.ts";

/** What an account id looks like: also the name of the person's folder under /data/users. */
export const USER_ID = /^[a-z][a-z0-9_-]{1,30}$/;
export const MIN_PASSPHRASE = 12;
const INVITE_DAYS = 7;
const PBKDF2_ITERATIONS = 310_000;

export interface User {
  id: string;
  name: string;
  language: string;
  admin: boolean;
  disabled: boolean;
  ready: boolean;
  created: string;
  /** The zone the person's days are in (an IANA name), or null for the service's own. */
  timezone: string | null;
}

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The master key, from its base64; 32 bytes or an error that says so. */
export async function masterKey(b64key: string): Promise<CryptoKey> {
  const raw = unb64(b64key);
  if (raw.length !== 32) throw new Error("BRAIN_MASTER_KEY must be 32 bytes, base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function wrap(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64(iv)}.${
    b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain))))
  }`;
}
async function unwrap(key: CryptoKey, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

/** A passphrase as its PBKDF2-SHA256 hash: `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassphrase(
  pass: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256),
  );
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}
export async function passphraseOk(pass: string, stored: string): Promise<boolean> {
  const [kind, it, salt, _] = stored.split("$");
  if (kind !== "pbkdf2") return false;
  return same(await hashPassphrase(pass, unb64(salt), Number(it)), stored);
}

/** Pure: what is wrong with a new account's id and name, or null. */
export function accountError(id: string, name: string): string | null {
  if (!USER_ID.test(id)) {
    return "l'id è fatto di lettere minuscole, cifre, - o _, comincia con una lettera, da 2 a 31 caratteri";
  }
  if (!name.trim() || name.length > 60) return "serve un nome, al massimo 60 caratteri";
  return null;
}

export class Users {
  constructor(private db: DatabaseSync, private key: CryptoKey, private dev = false) {
    migrate(db, ACCOUNTS_MIGRATIONS);
  }

  private row = (r: Record<string, unknown> | undefined): User | null =>
    r
      ? {
        id: String(r.id),
        name: String(r.name),
        language: String(r.language),
        admin: !!r.admin,
        disabled: !!r.disabled,
        ready: !!r.pass,
        created: String(r.created),
        timezone: typeof r.timezone === "string" ? r.timezone : null,
      }
      : null;

  get(id: string): User | null {
    return this.row(this.db.prepare("select * from users where id = ?").get(id) as Record<string, unknown> | undefined);
  }
  list(): User[] {
    return (this.db.prepare("select * from users order by created").all() as Record<string, unknown>[]).map((r) =>
      this.row(r)!
    );
  }
  count(): number {
    return (this.db.prepare("select count(*) n from users").get() as { n: number }).n;
  }

  /** The first account, the administrator, from the credentials the service ran with before it
   *  served several people: their passphrase, TOTP secret and backup key carry over unchanged. */
  async bootstrap(
    a: {
      id: string;
      name: string;
      language: string;
      passphrase: string;
      totpSecret: string | null;
      backupKey?: string;
    },
  ) {
    if (this.count()) return;
    const err = accountError(a.id, a.name);
    if (err) throw new Error(`BRAIN_ADMIN_ID: ${err}`);
    this.db.prepare(
      "insert into users (id, name, language, pass, totp, backup, admin, created) values (?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(
      a.id,
      a.name,
      a.language,
      await hashPassphrase(a.passphrase),
      a.totpSecret ? await wrap(this.key, a.totpSecret) : null,
      await wrap(this.key, a.backupKey ?? b64(crypto.getRandomValues(new Uint8Array(32)))),
      new Date().toISOString(),
    );
  }

  /** A new account, waiting for its person: the link to send them. The first account of a new
   *  service is the administrator's, invited the same way (its link goes to the service's log). */
  async invite(id: string, name: string, language: string, admin = false): Promise<string> {
    const err = accountError(id, name);
    if (err) throw new Error(err);
    if (this.get(id)) throw new Error(`l'account ${id} esiste già`);
    this.db.prepare("insert into users (id, name, language, backup, admin, created) values (?, ?, ?, ?, ?, ?)").run(
      id,
      name.trim(),
      language.trim() || "Italian",
      await wrap(this.key, b64(crypto.getRandomValues(new Uint8Array(32)))),
      admin ? 1 : 0,
      new Date().toISOString(),
    );
    return await this.reinvite(id);
  }

  /** A new link for an account: its passphrase and TOTP are cleared until the person chooses new
   *  ones (a lost phone, a forgotten passphrase). Their data and backup key stay. */
  async reinvite(id: string): Promise<string> {
    if (!this.get(id)) throw new Error(`nessun account ${id}`);
    const t = randomToken();
    this.db.prepare("update users set pass = null, totp = ? where id = ?").run(
      await wrap(this.key, base32Encode(crypto.getRandomValues(new Uint8Array(20)))),
      id,
    );
    this.db.prepare("delete from invites where user = ? or expires < ?").run(id, Date.now());
    this.db.prepare("insert into invites (hash, user, expires) values (?, ?, ?)").run(
      await sha256(t),
      id,
      Date.now() + INVITE_DAYS * 86400_000,
    );
    return t;
  }

  /** Invitations past their week: they open nothing any more. Returns how many went. */
  purge(now = Date.now()): number {
    return Number(this.db.prepare("delete from invites where expires < ?").run(now).changes);
  }

  /** The account an invitation opens and the TOTP secret to show, or null when it is not valid. */
  async invitation(token: string): Promise<{ user: User; totpSecret: string } | null> {
    const r = this.db.prepare("select user, expires from invites where hash = ?").get(await sha256(token)) as {
      user: string;
      expires: number;
    } | undefined;
    if (!r || r.expires < Date.now()) return null;
    const user = this.get(r.user);
    const t = this.db.prepare("select totp from users where id = ?").get(r.user) as { totp: string | null } | undefined;
    return user && t?.totp ? { user, totpSecret: await unwrap(this.key, t.totp) } : null;
  }

  /** The person's passphrase, once their TOTP code proves the secret is in their authenticator. */
  async accept(token: string, passphrase: string, code: string): Promise<User | string> {
    const inv = await this.invitation(token);
    if (!inv) return "invito scaduto o già usato: chiedine uno nuovo";
    if (passphrase.length < MIN_PASSPHRASE) return `la passphrase ha almeno ${MIN_PASSPHRASE} caratteri`;
    if (!(await totpOk(inv.totpSecret, code))) return "il codice non torna: controlla l'ora del telefono e riprova";
    this.db.prepare("update users set pass = ? where id = ?").run(await hashPassphrase(passphrase), inv.user.id);
    this.db.prepare("delete from invites where user = ?").run(inv.user.id);
    return this.get(inv.user.id)!;
  }

  /** Whether these are the person's passphrase and current TOTP code (an active, ready account). */
  async verify(id: string, passphrase: string, code: string): Promise<boolean> {
    const r = this.db.prepare("select pass, totp, disabled from users where id = ?").get(id) as {
      pass: string | null;
      totp: string | null;
      disabled: number;
    } | undefined;
    if (!r?.pass || r.disabled) {
      await hashPassphrase(passphrase); // the same time as a real check: no telling which ids exist
      return false;
    }
    if (!(await passphraseOk(passphrase, r.pass))) return false;
    if (!r.totp) return this.dev;
    return await totpOk(await unwrap(this.key, r.totp), code);
  }

  async backupKey(id: string): Promise<string> {
    const r = this.db.prepare("select backup from users where id = ?").get(id) as { backup: string } | undefined;
    if (!r) throw new Error(`nessun account ${id}`);
    return await unwrap(this.key, r.backup);
  }

  /** The zone of a person's days: an IANA name (Europe/Rome), or null for the service's own. */
  setTimezone(id: string, tz: string | null) {
    if (tz !== null && !validZone(tz)) throw new Error(`fuso orario sconosciuto: ${tz}`);
    this.db.prepare("update users set timezone = ? where id = ?").run(tz, id);
  }

  setDisabled(id: string, disabled: boolean) {
    const u = this.get(id);
    if (!u) throw new Error(`nessun account ${id}`);
    if (u.admin && disabled) throw new Error("l'amministratore non si disattiva");
    this.db.prepare("update users set disabled = ? where id = ?").run(disabled ? 1 : 0, id);
  }

  /** An account deleted (its row and invitations; the caller removes what it owns elsewhere). */
  remove(id: string) {
    const u = this.get(id);
    if (!u) throw new Error(`nessun account ${id}`);
    if (u.admin) throw new Error("l'amministratore non si elimina");
    this.db.prepare("delete from invites where user = ?").run(id);
    this.db.prepare("delete from users where id = ?").run(id);
  }
}
