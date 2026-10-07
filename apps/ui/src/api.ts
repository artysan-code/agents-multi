// api.ts — the console's HTTP API, typed. A POST carries the anti-CSRF header the server requires.
// The types come from the server's own modules where those have no Deno imports (lib/output.ts);
// the rest is the part of a response the pages read.

import type { Check } from "../../cli/lib/output.ts";

export type { Check };

/** The part of /api/status the pages read. */
export interface StatusView {
  language: string;
  doctor: Check[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
  return r.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return call<T>(path);
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-multi": "1" },
    body: JSON.stringify(body),
  });
}

export const api = {
  status: (fresh = false) => get<StatusView>(`/api/status${fresh ? "?fresh" : ""}`),
};
