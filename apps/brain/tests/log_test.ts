// Tests for the log (log.ts): one JSON line per event, the level filters, an error keeps its message,
// and a request's line carries the path and the id but nothing of its query, headers or body.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { logRequest, makeLog } from "../log.ts";

const capture = (min: "debug" | "info" | "warn" | "error") => {
  const lines: string[] = [];
  return { lines, log: makeLog(min, (l) => lines.push(l)) };
};

Deno.test("log: a line is JSON with time, level, msg and the fields; errors keep their message", () => {
  const { lines, log } = capture("info");
  log.info("hello", { n: 1 });
  log.error("boom", { err: new Error("bad") });
  const [a, b] = lines.map((l) => JSON.parse(l));
  assertEquals([a.level, a.msg, a.n], ["info", "hello", 1]);
  assert(!Number.isNaN(Date.parse(a.time)));
  assertEquals([b.level, b.err.message], ["error", "bad"]);
});

Deno.test("log: lines below the level are dropped", () => {
  const { lines, log } = capture("warn");
  log.debug("a");
  log.info("b");
  log.warn("c");
  log.error("d");
  assertEquals(lines.map((l) => JSON.parse(l).msg), ["c", "d"]);
});

Deno.test("log: a request's line has method, path, status, ms and id, and no secret", () => {
  const { lines, log } = capture("info");
  const req = new Request("https://b.test/api/tasks?token=SECRETQUERY&t=INVITE", {
    method: "PUT",
    headers: { authorization: "Bearer SECRETBEARER", cookie: "brain_session=SECRETCOOKIE" },
    body: "SECRETBODY",
  });
  logRequest(log, req, 200, 12.4, "ab12cd34");
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    time: JSON.parse(lines[0]).time,
    level: "info",
    msg: "request",
    method: "PUT",
    path: "/api/tasks",
    status: 200,
    ms: 12,
    id: "ab12cd34",
  });
  for (const s of ["SECRET", "INVITE", "token=", "Bearer"]) assert(!lines[0].includes(s), s);
});
