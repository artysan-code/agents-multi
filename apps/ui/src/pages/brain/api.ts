// api.ts — what Brain reads from the console (apps/cli/memory.ts keeps the token; these only read).

import { get } from "../../api.ts";

export interface SearchHit {
  path: string;
  title: string;
  excerpt: string;
}

export interface PageReply {
  path: string;
  title: string;
  body: string;
  updated: string;
  by: string;
  area: string;
  links: { out: { target: string; path?: string | null }[]; back: string[] };
}

export const searchBrain = (q: string) =>
  get<{ results: SearchHit[]; note?: string }>(`/api/brain/search?q=${encodeURIComponent(q)}&limit=20`);
export const readPage = (path: string) => get<PageReply>(`/api/brain/page?path=${encodeURIComponent(path)}`);
export const loadBrainInfo = () => get<{ url: string | null; board: string | null }>("/api/brain/info");

/** The brain answers `{"error": …}` with the status: the message, not the raw body. */
export function messageOf(e: Error): string {
  const body = e.message.replace(/^\d+\s*/, "");
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body;
  }
}
