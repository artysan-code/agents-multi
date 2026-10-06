// status.ts — the whole state as one JSON document: the contract for the statusline, the GUI, the
// notifier and the console. Everything that reads state reads this shape.

import {
  ANSI,
  CACHE,
  HOME,
  machine,
  profileInfo,
  profileNames,
  readJson,
  repoState,
  running,
  sharedInventory,
  uiLanguage,
  updateLog,
} from "./lib.ts";
import { installWaiting } from "./selfupdate.ts";
import { doctor } from "./doctor.ts";
import { ACCOUNTS, loadRegistry, reachOf } from "./mcp.ts";
import { loadAccounts } from "../../shared/mcp/lib/accounts.ts";
import { brainAccount } from "../../shared/mcp/lib/brain-tasks.ts";
import { lastBackup } from "./brain-backup.ts";

export async function status(opts: { withDoctor?: boolean } = { withDoctor: true }) {
  const [m, repo, inst, inv] = await Promise.all([machine(), repoState(), running(), sharedInventory()]);
  const profiles: Record<string, Awaited<ReturnType<typeof profileInfo>>> = {};
  for (const p of await profileNames()) profiles[p] = await profileInfo(p);
  const sync = await readJson(`${CACHE}/sync.json`);
  const update = await readJson<
    {
      cli?: { current?: string; latest?: string; outdated?: boolean };
      desktop?: { current?: string; latest?: string; outdated?: boolean };
      checked_at?: number;
    }
  >(`${HOME}/.cache/claude-update/check.json`);
  let registry: Record<string, { profiles: string[]; surfaces: string[] }> = {};
  try {
    const reg = await loadRegistry();
    registry = Object.fromEntries(
      Object.entries(reg.servers).map(([n, c]) => [n, { profiles: reachOf(reg, c), surfaces: c._surfaces ?? ["cli"] }]),
    );
  } catch { /* no registry */ }
  return {
    generatedAt: new Date().toISOString(),
    machine: m,
    repo,
    sync,
    update,
    updateLog: await updateLog(),
    // an install that a claude-multi update left for when every Claude is closed: the commit it came with
    selfInstall: await installWaiting(),
    // what the console shows when the viewer has not picked a language: the machine's, not the browser's
    language: uiLanguage(Deno.env.toObject()),
    shared: { ...inv, mcpRegistry: registry },
    profiles,
    running: inst,
    // the brain this machine uses and its last copy here (the doctor says whether the token still works)
    brain: await brainState(),
    doctor: opts.withDoctor ? await doctor() : [],
  };
}
async function brainState() {
  const a = brainAccount(undefined, loadAccounts(ACCOUNTS));
  if (!a) return null;
  const b = await lastBackup().catch(() => null);
  return { url: a.url ?? null, lastCopy: b ? { file: b.file, checked: b.checked, verified: b.verified } : null };
}

export type StatusReport = Awaited<ReturnType<typeof status>>;

/** What the tray icon says: one level, and the lines behind it. */
export interface Summary {
  level: "ok" | "fail";
  fails: string[];
  warns: string[];
  /** a Claude Desktop version waiting for every instance to close */
  staged: string | null;
  running: { cli: number; desktop: number };
  generatedAt: string;
}

/** Pure: the report to the tray's summary. Updates install themselves, so a newer version is not
 *  something to act on and does not colour the icon; only a failure does. A warn is listed, not
 *  coloured either: some warns are standing conditions of a machine (a laptop without a desktop
 *  timer, say), and an icon that is always yellow says nothing. */
export function summarize(
  s: Pick<StatusReport, "doctor" | "running" | "generatedAt"> & { machine: { desktopStaged: string | null } },
): Summary {
  const fails = s.doctor.filter((c) => c.status === "fail").map((c) => c.msg);
  const warns = s.doctor.filter((c) => c.status === "warn").map((c) => c.msg);
  return {
    level: fails.length ? "fail" : "ok",
    fails,
    warns,
    staged: s.machine.desktopStaged,
    running: { cli: s.running.cli.filter((c) => !c.embedded).length, desktop: s.running.desktop.length },
    generatedAt: s.generatedAt,
  };
}

export function printStatus(s: StatusReport) {
  const m = s.machine;
  const r = s.repo;
  const up = (k: "cli" | "desktop") => s.update?.[k]?.outdated ? `  ${ANSI.y}⬆ ${s.update?.[k]?.latest}${ANSI.x}` : "";
  console.log(`${ANSI.b}claude-multi status${ANSI.x} — ${m.hostname}`);
  console.log(`  Claude Code     ${m.cliVersion ?? "?"}${up("cli")}`);
  console.log(`  Claude Desktop  ${m.desktopVersion ?? "not installed"}${up("desktop")}`);
  for (const [variant, vs] of Object.entries(m.embeddedCode)) {
    console.log(`  Desktop ${variant.padEnd(8)} embedded Claude Code ${vs.join(", ")}`);
  }
  if (r.isRepo) {
    console.log(
      `  Repository      ${r.branch} @ ${r.head}  ↓${r.behind} ↑${r.ahead} ✎${r.dirty}  (${r.remote ?? "no remote"})`,
    );
  }
  console.log(
    `  Shared          ${Object.keys(s.shared.agents).length} agents · ${
      Object.keys(s.shared.commands).length
    } commands · ${Object.keys(s.shared.skills).length} skills · ${s.shared.hooks.length} hooks · ${
      Object.keys(s.shared.mcpRegistry).length
    } MCP servers`,
  );
  for (const p of Object.keys(s.profiles)) {
    const i = s.profiles[p];
    const mine = s.running.cli.filter((c) => c.profile === p);
    const active = `${mine.filter((c) => !c.embedded).length} cli + ${mine.filter((c) => c.embedded).length} desktop`;
    console.log(
      `  ${p.padEnd(15)} ${i.account ?? "—"} · mcp cli [${i.mcp.join(", ")}]${
        m.desktopVersion ? ` desktop [${i.mcpDesktop.join(", ")}]` : ""
      } · ${Object.keys(i.mounted.skills).length} skills · ${i.plugins.length} plugins · ${active}`,
    );
  }
  if (s.running.desktop.length) console.log(`  Desktop running ${s.running.desktop.map((d) => d.variant).join(", ")}`);
  console.log();
}
