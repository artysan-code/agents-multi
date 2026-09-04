// status.ts — lo stato completo in un JSON: è il contratto per statusline, GUI, notifica e dashboard.

import { ANSI, CACHE, HOME, machine, PROFILES, profileInfo, readJson, repoState, running, sharedInventory } from "./lib.ts";
import { doctor } from "./doctor.ts";
import { loadRegistry } from "./mcp.ts";

export async function status(opts: { withDoctor?: boolean } = { withDoctor: true }) {
  const [m, repo, inst, inv] = await Promise.all([machine(), repoState(), running(), sharedInventory()]);
  const profiles: Record<string, Awaited<ReturnType<typeof profileInfo>>> = {};
  for (const p of PROFILES) profiles[p] = await profileInfo(p);
  const sync = await readJson(`${CACHE}/sync.json`);
  const update = await readJson<{ cli?: { current?: string; latest?: string; outdated?: boolean; changelog_file?: string }; desktop?: { current?: string; latest?: string; outdated?: boolean } }>(`${HOME}/.cache/claude-update/check.json`);
  let registry: Record<string, { profiles: string[]; surfaces: string[] }> = {};
  try {
    const reg = await loadRegistry();
    registry = Object.fromEntries(Object.entries(reg.servers).map(([n, c]) => [n, { profiles: c._profiles ?? reg.profiles, surfaces: c._surfaces ?? ["cli"] }]));
  } catch { /* registry assente */ }
  return {
    generatedAt: new Date().toISOString(), machine: m, repo, sync, update,
    shared: { ...inv, mcpRegistry: registry },
    profiles, running: inst,
    doctor: opts.withDoctor ? await doctor() : [],
  };
}
export type StatusReport = Awaited<ReturnType<typeof status>>;

export function printStatus(s: StatusReport) {
  const m = s.machine; const r = s.repo;
  const up = (k: "cli" | "desktop") => s.update?.[k]?.outdated ? `  ${ANSI.y}⬆ ${s.update?.[k]?.latest}${ANSI.x}` : "";
  console.log(`${ANSI.b}claude-multi status${ANSI.x} — ${m.hostname}`);
  console.log(`  Claude Code     ${m.cliVersion ?? "?"}${up("cli")}`);
  console.log(`  Claude Desktop  ${m.desktopVersion ?? "non installato"}${up("desktop")}`);
  for (const [variant, vs] of Object.entries(m.embeddedCode)) console.log(`  Desktop ${variant.padEnd(8)} Claude Code embedded ${vs.join(", ")}`);
  if (r.isRepo) console.log(`  Repo            ${r.branch} @ ${r.head}  ↓${r.behind} ↑${r.ahead} ✎${r.dirty}  (${r.remote ?? "nessun remote"})`);
  console.log(`  Condiviso       ${Object.keys(s.shared.agents).length} agenti · ${Object.keys(s.shared.commands).length} comandi · ${Object.keys(s.shared.skills).length} skill · ${s.shared.hooks.length} hook · ${Object.keys(s.shared.mcpRegistry).length} MCP nel registry`);
  for (const p of PROFILES) {
    const i = s.profiles[p];
    const mine = s.running.cli.filter((c) => c.profile === p);
    const active = `${mine.filter((c) => !c.embedded).length} cli + ${mine.filter((c) => c.embedded).length} desktop`;
    console.log(`  ${p.padEnd(15)} ${i.account ?? "—"} · mcp cli [${i.mcp.join(", ")}]${m.desktopVersion ? ` desktop [${i.mcpDesktop.join(", ")}]` : ""} · skill ${Object.keys(i.mounted.skills).length} · plugin ${i.plugins.length} · sessioni ${active}`);
  }
  if (s.running.desktop.length) console.log(`  Desktop attivi  ${s.running.desktop.map((d) => d.variant).join(", ")}`);
  console.log();
}
