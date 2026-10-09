// updates-lib.tsx — what the Updates tab, the update wizard and «Close Claude and update» share: the
// part of the report they read, what an update would take now, the changelog as elements, and
// reading and writing a small JSON value in a browser store.

import type { ComponentChildren } from "preact";
import { get } from "../../api.ts";
import type { StatusView } from "../../api.ts";
import { t } from "../../i18n.ts";
import { inline } from "../../lib/markdown.tsx";

export const COMPONENTS: Record<string, string> = {
  cli: "Claude Code",
  desktop: "Claude Desktop",
  "agents-multi": "Agents Multi",
  // the log of an installation from before the rename
  "claude-multi": "Agents Multi",
};

/** The fields of /api/status the update pages read beyond the typed part. */
export type Report = StatusView & { selfInstall?: boolean };
export interface MachineExtra {
  cliVersions?: string[];
  desktopSystem?: boolean;
}
export interface RepoExtra {
  upstream?: string | null;
}

export interface Release {
  version: string;
  date: string;
  body: string;
}
export interface Whatsnew {
  version?: string;
  releases?: Release[];
}

export function keep(store: Storage, key: string, value?: unknown): void {
  try {
    if (value === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch { /* private window or blocked storage: the wizard still works, it just cannot resume */ }
}

export function kept<T>(store: Storage, key: string): T | null {
  try {
    return JSON.parse(store.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

/** X.Y.Z or X.Y.Z-beta.N, a beta before its stable version: the same order as lib/changelog.ts. */
export function cmpVer(a: unknown, b: unknown): number {
  const p = (v: unknown) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(String(v ?? ""));
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : [0, 0, 0, 0];
  };
  const x = p(a), y = p(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** What an update would take now, one line per component; empty when everything is current. */
export function pendingUpdates(S: Report | null): string[] {
  if (!S) return [];
  const m = S.machine, u = S.update ?? {}, r = S.repo;
  // a Claude Desktop already staged is not among them: it takes its new version when it next opens,
  // and there is nothing to do for it (the Updates page says so)
  return [
    u.cli?.latest && u.cli.latest !== m.cliVersion ? `Claude Code ${m.cliVersion ?? "—"} → ${u.cli.latest}` : null,
    r.isRepo && r.behind ? `agents-multi: ${t("up.self.behind", { n: r.behind })}` : null,
    S.selfInstall ? `agents-multi: ${t("up.self.install")}` : null,
  ].filter((x): x is string => !!x);
}

export const fetchNews = (since: string | null): Promise<Whatsnew | null> =>
  get<Whatsnew>(`/api/whatsnew?since=${encodeURIComponent(since ?? "")}`).catch(() => null);

/** A CHANGELOG section: its `###` headings and `- **scope**: change (hash)` lines. */
export function Changelog({ body }: { body: string }) {
  const out: ComponentChildren[] = [];
  let items: ComponentChildren[] = [];
  const flush = () => {
    if (items.length) out.push(<ul>{items}</ul>);
    items = [];
  };
  for (const l of body.split("\n")) {
    if (l.startsWith("- ")) {
      items.push(<li>{inline(l.slice(2).replace(/\s*\(([0-9a-f]{7,})\)$/, ""))}</li>);
      continue;
    }
    flush();
    if (l.startsWith("### ")) out.push(<h4>{l.slice(4)}</h4>);
    else if (l.trim()) out.push(<p>{l}</p>);
  }
  flush();
  return <>{out}</>;
}

export function News({ news, since }: { news: Whatsnew | null; since: string | null }) {
  if (!news?.releases?.length) {
    return <p class="sub">{t("uw.noRelease", { v: news?.version ?? "—", f: since ?? "—" })}</p>;
  }
  return (
    <>
      {news.releases.map((r) => (
        <section class="uw-rel" key={r.version}>
          <h3>
            {r.version} <span class="sub">{r.date}</span>
          </h3>
          <Changelog body={r.body} />
        </section>
      ))}
    </>
  );
}
