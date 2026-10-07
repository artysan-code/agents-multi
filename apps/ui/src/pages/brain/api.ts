// api.ts — what the Brain page reads from the console (apps/cli/memory.ts keeps the token; these
// routes only read). The writes are Claude's, asked in the field below.

import { get } from "../../api.ts";

export interface PageInfo {
  path: string;
  title: string;
  rev: number;
  created: string;
  updated: string;
  by: string;
  area: string;
}

export interface PagesReply {
  version: string;
  /** the areas as this brain names them, in order, with their page counts */
  areas?: Record<string, number>;
  pages: PageInfo[];
  edges: [string, string][];
}

export interface HealthReply {
  pages: number;
  orphans: string[];
  broken_links: { page: string; link: string }[];
  too_long: { page: string; words: number }[];
  inbox_older_than_a_week: string[];
  outside_the_areas: string[];
}

export interface Version {
  path: string;
  rev: number;
  at: string;
  by: string;
  op: "write" | "restore" | "delete";
}

export interface PageReply extends PageInfo {
  body: string;
  links: { out: { target: string; path?: string }[]; back: string[] };
  versions: Version[];
}

export interface VersionReply {
  body: string;
  at: string;
  by: string;
}

export interface SearchReply {
  results?: { path: string; title: string; excerpt?: string }[];
  note?: string;
}

export interface ArchivePage {
  path: string;
  title: string;
  group: string;
  summary?: string;
  updated?: string;
}

export interface ArchiveReply {
  root: string;
  pages: ArchivePage[];
}

const q = encodeURIComponent;

export const brainApi = {
  pages: () => get<PagesReply>("/api/brain/pages"),
  health: () => get<HealthReply>("/api/brain/health"),
  page: (path: string) => get<PageReply>(`/api/brain/page?path=${q(path)}`),
  version: (path: string, rev: number) => get<VersionReply>(`/api/brain/page?path=${q(path)}&rev=${rev}`),
  search: (text: string) => get<SearchReply>(`/api/brain/search?q=${q(text)}&limit=30`),
  archive: () => get<ArchiveReply>("/api/archive"),
  archivePage: (path: string) => get<{ path: string; body: string }>(`/api/archive/page?path=${q(path)}`),
};

/** The service's answer inside an error, without the status line. */
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/\{.*\}/s);
  try {
    return m ? (JSON.parse(m[0]) as { error?: string }).error ?? msg : msg;
  } catch {
    return msg;
  }
}
