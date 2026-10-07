// log.ts — the service's log: one JSON line per event (time, level, msg and the fields of the event),
// on stdout, for whoever collects the container's output. The level comes from BRAIN_LOG_LEVEL
// (debug, info, warn, error; default info). Callers pass only fields that are safe to keep: never a
// token, a cookie, an Authorization header, a query string or a body.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;
export type Log = ReturnType<typeof makeLog>;

/** Pure: an error as plain fields (JSON.stringify would drop its message and stack). */
const plain = (v: unknown) => v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;

/** A logger that writes lines at or above `min` to `out`. */
export function makeLog(min: Level, out: (line: string, level: Level) => void) {
  const at = (level: Level) => (msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < LEVELS[min]) return;
    const e = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, plain(v)]));
    out(JSON.stringify({ time: new Date().toISOString(), level, msg, ...e }), level);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const asked = Deno.env.get("BRAIN_LOG_LEVEL")?.toLowerCase();
const level = (asked && asked in LEVELS ? asked : "info") as Level;

export const log = makeLog(level, (line, l) => (LEVELS[l] >= LEVELS.warn ? console.error : console.log)(line));

/** One line for a request that was answered: what was asked (the path, without its query string),
 *  what came back, how long it took, and the id that an error answer also carries. */
export function logRequest(l: Log, req: Request, status: number, ms: number, id: string) {
  l.info("request", { method: req.method, path: new URL(req.url).pathname, status, ms: Math.round(ms), id });
}
