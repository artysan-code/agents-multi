// log.ts — the gateway's own log: a file in its folder with one rotation (`gateway.log` → `gateway.log.1`),
// so it does not depend on the pipes of whoever started it (a console that exits or updates closes them)
// and cannot grow without bound. A failing write never takes the gateway down.

import { rotateNeeded } from "./core.ts";

export const LOG_MAX_BYTES = 1_000_000;

export function openLog(path: string, max = LOG_MAX_BYTES): (line: string) => void {
  let size = 0;
  try {
    size = Deno.statSync(path).size;
  } catch { /* no log yet */ }
  const enc = new TextEncoder();
  return (line) => {
    try {
      const bytes = enc.encode(`${new Date().toISOString()} ${line}\n`);
      if (rotateNeeded(size, bytes.length, max)) {
        Deno.renameSync(path, `${path}.1`);
        size = 0;
      }
      Deno.writeFileSync(path, bytes, { append: true, create: true, mode: 0o600 });
      size += bytes.length;
    } catch { /* the log is a convenience */ }
  };
}
