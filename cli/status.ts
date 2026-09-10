// status.ts — the whole state as one JSON document: the contract for the statusline, the GUI, the
// notifier and the console. Everything that reads state reads this shape.

import { ANSI, CACHE, HOME, machine, profileInfo, profileNames, readJson, repoState, running, sharedInventory } from "./lib.ts";
import { doctor } from "./doctor.ts";
import { loadRegistry } from "./mcp.ts";

export async function status(opts: { withDoctor?: boolean } = { withDoctor: true }) {
  const [m, repo, inst, inv] = await Promise.all([machine(), repoState(), running(), sharedInventory()]);
  const profiles: Record<string, Awaited<ReturnType<typeof profileInfo>>> = {};
  for (const p of await profileNames()) profiles[p] = await profileInfo(p);
  const sync = await readJson(`${CACHE}/sync.json`);
  const update = await readJson<{ cli?: { current?: string; latest?: string; outdated?: boolean; changelog_file?: string }; desktop?: { current?: string; latest?: string; outdated?: boolean } }>(`${HOME}/.cache/claude-update/check.json`);
  let registry: Record<string, { profiles: string[]; surfaces: string[] }> = {};
  try {
    const reg = await loadRegistry();
    registry = Object.fromEntries(Object.entries(reg.servers).map(([n, c]) => [n, { profiles: c._profiles ?? reg.profiles, surfaces: c._surfaces ?? ["cli"] }]));
  } catch { /* no registry */ }
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
  console.log(`  Claude Desktop  ${m.desktopVersion ?? "not installed"}${up("desktop")}`);
  for (const [variant, vs] of Object.entries(m.embeddedCode)) console.log(`  Desktop ${variant.padEnd(8)} embedded Claude Code ${vs.join(", ")}`);
  if (r.isRepo) console.log(`  Repository      ${r.branch} @ ${r.head}  ↓${r.behind} ↑${r.ahead} ✎${r.dirty}  (${r.remote ?? "no remote"})`);
  console.log(`  Shared          ${Object.keys(s.shared.agents).length} agents · ${Object.keys(s.shared.commands).length} commands · ${Object.keys(s.shared.skills).length} skills · ${s.shared.hooks.length} hooks · ${Object.keys(s.shared.mcpRegistry).length} MCP servers`);
  for (const p of Object.keys(s.profiles)) {
    const i = s.profiles[p];
    const mine = s.running.cli.filter((c) => c.profile === p);
    const active = `${mine.filter((c) => !c.embedded).length} cli + ${mine.filter((c) => c.embedded).length} desktop`;
    console.log(`  ${p.padEnd(15)} ${i.account ?? "—"} · mcp cli [${i.mcp.join(", ")}]${m.desktopVersion ? ` desktop [${i.mcpDesktop.join(", ")}]` : ""} · ${Object.keys(i.mounted.skills).length} skills · ${i.plugins.length} plugins · ${active}`);
  }
  if (s.running.desktop.length) console.log(`  Desktop running ${s.running.desktop.map((d) => d.variant).join(", ")}`);
  console.log();
}
