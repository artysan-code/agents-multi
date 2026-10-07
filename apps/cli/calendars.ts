// calendars.ts — which of an account's calendars the day shows. A Google account holds several (the main
// one, a subscribed "University", birthdays, holidays…); the list comes from Google (calendarList) and the
// choice is the person's, kept in config/calendars.json as account → calendar id → shown or not. A
// calendar nobody chose about shows unless it is background noise (birthdays, holidays, week numbers),
// so one that appears later is picked up by itself.

import { loadAccounts } from "../../shared/mcp/lib/accounts.ts";
import { accessToken, loadClient } from "../../shared/mcp/lib/google.ts";
import { getSecret } from "../../shared/mcp/lib/vault.ts";
import { ACCOUNTS } from "./mcp/registry.ts";
import { readJson } from "./lib/fs.ts";
import { CONFIG } from "./lib/paths.ts";

// deno-lint-ignore no-explicit-any
type Doc = any;

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  /** owner · writer · reader · freeBusyReader */
  role: string;
  /** background noise: off unless chosen */
  noisy: boolean;
  shown: boolean;
}
export type AccountCalendars = {
  account: string;
  email?: string;
  state: "ok" | "disconnected" | "error";
  message?: string;
  calendars: CalendarInfo[];
};
export type Choice = Record<string, Record<string, boolean>>;

const FILE = `${CONFIG}/calendars.json`;

/** Pure: Google's own calendars that fill the day with noise rather than appointments. */
export const isNoisy = (id: string) => /#(holiday|contacts|weather|weeknum)@|addressbook#/.test(id);

/** Pure: is this calendar shown, given what the person chose. */
export const isShown = (choice: Choice, account: string, id: string): boolean => choice[account]?.[id] ?? !isNoisy(id);

/** Pure: Google's calendarList items as ours, with the choice applied. */
export function calendarInfos(items: Doc[], choice: Choice, account: string): CalendarInfo[] {
  return items.filter((c) => c.id && !c.deleted).map((c) => ({
    id: String(c.id),
    name: String(c.summaryOverride ?? c.summary ?? c.id),
    color: String(c.backgroundColor ?? "#888888"),
    primary: !!c.primary,
    role: String(c.accessRole ?? "reader"),
    noisy: isNoisy(String(c.id)),
    shown: isShown(choice, account, String(c.id)),
  })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** Pure: a short fingerprint of the choice: a debrief written under another one is out of date. */
export function choiceSignature(choice: Choice): string {
  return JSON.stringify(
    Object.entries(choice).sort(([a], [b]) => a.localeCompare(b)).map(([a, m]) => [
      a,
      Object.entries(m).filter(([, v]) => v === false || v === true).sort(([x], [y]) => x.localeCompare(y)),
    ]),
  );
}

export const loadChoice = async (): Promise<Choice> => (await readJson<{ shown?: Choice }>(FILE))?.shown ?? {};

export async function setShown(account: string, id: string, shown: boolean): Promise<void> {
  const choice = await loadChoice();
  (choice[account] ??= {})[id] = shown;
  await Deno.mkdir(CONFIG, { recursive: true });
  await Deno.writeTextFile(FILE, JSON.stringify({ shown: choice }, null, 2) + "\n");
  listMemo = null;
}

let listMemo: { at: number; value: Promise<AccountCalendars[]> } | null = null;

/** The calendars of every connected Google account, with the choice applied. Kept five minutes. */
export function listCalendars(fresh = false): Promise<AccountCalendars[]> {
  if (!fresh && listMemo && Date.now() - listMemo.at < 300_000) return listMemo.value;
  const value = fetchCalendars();
  listMemo = { at: Date.now(), value };
  value.then((r) => {
    if (r.some((a) => a.state === "error")) listMemo = null; // an error is not kept
  }, () => listMemo = null);
  return value;
}

async function fetchCalendars(): Promise<AccountCalendars[]> {
  const google = loadAccounts(ACCOUNTS).filter((a) => a.service === "google");
  if (!google.length) return [];
  let client;
  try {
    client = await loadClient();
  } catch {
    return google.map((a) => ({
      account: a.name,
      email: a.email,
      state: "disconnected" as const,
      calendars: [],
    }));
  }
  const choice = await loadChoice();
  return await Promise.all(google.map(async (a): Promise<AccountCalendars> => {
    const base = { account: a.name, email: a.email };
    try {
      const refresh = await getSecret("google", a.name);
      if (!refresh) return { ...base, state: "disconnected", calendars: [] };
      const token = await accessToken(client, refresh);
      const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        // 403: a token from before the calendar list was asked for; connecting again grants it
        return {
          ...base,
          state: r.status === 403 || r.status === 401 ? "disconnected" : "error",
          message: `HTTP ${r.status}`,
          calendars: [],
        };
      }
      return { ...base, state: "ok", calendars: calendarInfos((await r.json()).items ?? [], choice, a.name) };
    } catch (e) {
      return { ...base, state: "error", message: (e as Error).message, calendars: [] };
    }
  }));
}
