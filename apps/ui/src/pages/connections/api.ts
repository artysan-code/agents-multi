// api.ts — the part of /api/accounts and /api/calendars the Connections page reads, and the calls
// it makes. The server never sends a secret: an account only says whether this machine has one.

import { get, post, type Result } from "../../api.ts";

export interface Reach {
  profiles: string[];
  pending: string[];
  noDesktop: string[];
}

export interface Account {
  service: string;
  name: string;
  url?: string;
  /** absent = every profile */
  profiles?: string[];
  email?: string;
  auth?: "oauth";
  note?: string;
  hasSecret: boolean;
  missing: { server: string; problem: string; install?: string }[];
  reach: Reach;
}

/** A server that needs no account: on for some profiles, nothing to sign in to. */
export interface Server extends Reach {
  name: string;
}

export interface Vault {
  dir: string;
  state: "ok" | "wrong-key" | "no-key";
  detail: string;
  initialised: boolean;
  conflicts: number;
  unreadable: number;
}

export interface AccountsView {
  google: { client: boolean; last: { account: string; ok: boolean; message: string; at: string } | null };
  vault: Vault;
  services: string[];
  profiles: string[];
  accounts: Account[];
  servers: Server[];
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  role: string;
  noisy: boolean;
  shown: boolean;
}

export interface AccountCalendars {
  account: string;
  email?: string;
  state: "ok" | "disconnected" | "error";
  message?: string;
  calendars: CalendarInfo[];
}

interface AccountBody {
  op: "save" | "delete";
  service: string;
  name: string;
  url: string;
  profiles: string[];
  secret: string;
}

type Saved = Result & { missing?: unknown[] };
const failed = (e: Error): Result => ({ ok: false, message: e.message });
interface Login {
  ok: boolean;
  message?: string;
  url?: string;
}

export const loadAccounts = () => get<AccountsView>("/api/accounts");
export const loadCalendars = (fresh = false) => get<AccountCalendars[]>(`/api/calendars${fresh ? "?fresh" : ""}`);

/** Writes the account (or removes it). A failed request is a result with a message, as the form shows it. */
export const saveAccount = (b: AccountBody) => post<Saved>("/api/accounts", b).catch(failed as (e: Error) => Saved);

export const setShown = (account: string, id: string, shown: boolean) =>
  post("/api/calendars", { account, id, shown }).catch(failed);

/** Starts a consent page: Google's for an account, the brain's sign-in for the brain account. */
export const startLogin = (kind: "google" | "brain", account: string) =>
  post<Login>(kind === "google" ? "/api/google/connect" : "/api/brain/login", { account })
    .catch((e: Error): Login => ({ ok: false, message: e.message }));

/** Sends the Google OAuth client file as it is (the server reads the JSON itself). */
export async function importGoogleClient(text: string): Promise<Result> {
  try {
    const r = await fetch("/api/google/client", { method: "POST", headers: { "x-claude-multi": "1" }, body: text });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
    return await r.json() as Result;
  } catch (e) {
    return failed(e as Error);
  }
}
