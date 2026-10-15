// usage/print.ts — a report as a table for the terminal.

import type { report, Row } from "./report.ts";

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
const usd = (n: number | null | undefined) => n == null ? "—" : `$${n.toFixed(2)}`;

export function printReport(r: ReturnType<typeof report>) {
  const B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
  console.log(
    `${B}agents usage${X} — by ${r.by}${r.since ? ` since ${r.since}` : ""}${
      r.profile ? ` · profile ${r.profile}` : ""
    }  ${D}(estimate = list price, never billed)${X}`,
  );
  const byTool = r.by === "skill" || r.by === "command";
  const label = (x: Row) => x.label ?? x.key;
  const head = ["", ...(byTool ? ["uses"] : []), "msgs", "sess", "input", "output", "cache rd", "cache wr", "estimate"];
  const w = [Math.max(10, ...r.rows.map((x) => label(x).length), 8), ...(byTool ? [5] : []), 6, 5, 8, 8, 9, 9, 9];
  const line = (cells: (string | number)[]) =>
    "  " + cells.map((c, i) => i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i])).join(" ");
  console.log(D + line(head) + X);
  for (const x of r.rows) {
    const k = label(x);
    console.log(
      line([
        k.length > 48 ? k.slice(0, 47) + "…" : k,
        ...(byTool ? [x.uses ?? 0] : []),
        x.msgs,
        x.sessions,
        fmt(Math.round(x.input)),
        fmt(Math.round(x.output)),
        fmt(Math.round(x.cache_read)),
        fmt(Math.round(x.cache_write)),
        usd(x.cost) + (x.unpriced ? "*" : ""),
      ]),
    );
  }
  console.log(
    B +
      line([
        "total",
        ...(byTool ? [""] : []),
        r.total.msgs ?? 0,
        "",
        fmt(Math.round(r.total.input)),
        fmt(Math.round(r.total.output)),
        fmt(Math.round(r.total.cache_read)),
        fmt(Math.round(r.total.cache_write)),
        usd(r.total.cost),
      ]) + X,
  );
  if (byTool) {
    console.log(
      `  ${D}estimate = the turn's share, split across the ${
        r.by === "skill" ? "skills" : "commands"
      } in that turn; "msgs" counts the messages of those turns${
        r.orphanMsgs ? `; ${r.orphanMsgs} messages outside any turn excluded` : ""
      }${X}`,
    );
  }
  if (r.rows.some((x) => x.unpriced)) console.log(`  ${D}* model with no rate in the table: partial estimate${X}`);
  if (r.spawns.length) {
    console.log(`  ${D}subagents launched (Agent tool):${X} ${r.spawns.map((s) => `${s.key} ×${s.n}`).join(" · ")}`);
  }
}
