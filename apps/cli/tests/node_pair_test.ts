// node_pair_test.ts — this machine pairing with a code (apps/cli/node/pair.ts): the service's pairing asked for, the
// code shown, the poll until the token comes, and every way it ends without one.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { pairFailure, pairView } from "../../ui/src/pages/connections/pair-lib.ts";
import { ACTIONS } from "../console/actions.ts";
import { bigCode, machinesUrl, pairMachine, spinnerFrame } from "../node/pair.ts";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

/** A service that answers the pairing, then the polls in `polls` in turn. */
function service(
  polls: (() => Response)[],
  create: () => Response | Promise<Response> = () =>
    json({ code: "ABCD-2345", pairing: "secret-1", expires: new Date(Date.now() + 600_000).toISOString() }),
) {
  const seen: { method: string; url: string; body?: unknown }[] = [];
  let i = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") return await create();
    return (polls[Math.min(i++, polls.length - 1)])();
  }) as typeof fetch;
  return { fetcher, seen };
}

const io = (fetcher: typeof fetch, shown: unknown[] = []) => ({
  fetcher,
  show: (p: unknown) => void shown.push(p),
  sleep: () => Promise.resolve(),
});

Deno.test("pair: the code is shown, then the token comes when the person has typed it", async () => {
  const shown: { code: string; url: string }[] = [];
  const { fetcher, seen } = service([
    () => json({ state: "waiting" }),
    () => json({ state: "waiting" }),
    () => json({ state: "done", token: "brain_xyz", url: "https://b.test" }),
  ]);
  const r = await pairMachine("https://b.test/", "desk", "linux", io(fetcher, shown) as never);
  assertEquals(r, { ok: true, token: "brain_xyz" });
  assertEquals(shown.map((s) => [s.code, s.url]), [["ABCD-2345", "https://b.test/app#/machines"]]);
  assertEquals(seen[0], { method: "POST", url: "https://b.test/api/pair", body: { name: "desk", platform: "linux" } });
  assertEquals(seen.slice(1).map((s) => s.url), Array(3).fill("https://b.test/api/pair/secret-1"));
});

Deno.test("pair: an expired code, a refusal, a service that is down", async () => {
  let r = await pairMachine(
    "https://b.test",
    "d",
    "linux",
    io(service([() => json({ state: "expired" })]).fetcher) as never,
  );
  assert(!r.ok && r.message.includes("expired"));
  r = await pairMachine(
    "https://b.test",
    "d",
    "linux",
    io(service([], () => json({ error: "too many pairings" }, 503)).fetcher) as never,
  );
  assert(!r.ok && r.message.includes("too many pairings"));
  r = await pairMachine(
    "https://b.test",
    "d",
    "linux",
    io((() => Promise.reject(new Error("offline"))) as typeof fetch) as never,
  );
  assert(!r.ok && r.message.includes("offline"));
  r = await pairMachine(
    "https://b.test",
    "d",
    "linux",
    io(service([() => json({ error: "no" }, 403)]).fetcher) as never,
  );
  assert(!r.ok && r.message.includes("refused"));
});

Deno.test("pair: a busy service or a dropped poll is asked again, a cancel stops it", async () => {
  const { fetcher } = service([() => json({}, 429), () => json({}, 502), () => json({ state: "done", token: "t" })]);
  assertEquals(await pairMachine("https://b.test", "d", "linux", io(fetcher) as never), { ok: true, token: "t" });
  const stop = new AbortController();
  const waiting = service([() => json({ state: "waiting" })]);
  const r = await pairMachine("https://b.test", "d", "linux", {
    ...io(waiting.fetcher),
    signal: stop.signal,
    tick: () => stop.abort(),
  } as never);
  assertEquals(r, { ok: false, message: "cancelled" });
});

Deno.test("pair: it gives up when the code's time is over", async () => {
  let now = Date.parse("2026-10-15T20:00:00Z");
  const { fetcher } = service(
    [() => json({ state: "waiting" })],
    () => json({ code: "ABCD-2345", pairing: "s", expires: new Date(now + 60_000).toISOString() }),
  );
  const r = await pairMachine("https://b.test", "d", "linux", {
    ...io(fetcher),
    now: () => now,
    sleep: () => Promise.resolve(void (now += 30_000)),
  } as never);
  assert(!r.ok && r.message.includes("expired"));
});

Deno.test("pair: the page address, the big code and the spinner", () => {
  assertEquals(machinesUrl("https://b.test///"), "https://b.test/app#/machines");
  assert(bigCode("AB-12").includes("A B - 1 2"));
  assertEquals(spinnerFrame(0), "⠋");
  assertEquals(spinnerFrame(120), "⠙");
  assertEquals(spinnerFrame(1200), "⠋");
});

Deno.test("pair: the console reads the job's lines: the code, the page, the end", () => {
  const out = "CODE ABCD-2345\nOPEN https://b.test/app#/machines\nEXPIRES 2026-10-15T20:10:00.000Z\n";
  assertEquals(pairView(""), { code: null, url: null, paired: null });
  assertEquals(pairView(out), { code: "ABCD-2345", url: "https://b.test/app#/machines", paired: null });
  assertEquals(pairView(`${out}PAIRED desk\n`).paired, "desk");
  assertEquals(pairView("CODE nonsense\n").code, null);
  assertEquals(
    pairFailure(`${out}the code expired before it was typed: run it again\n`),
    "the code expired before it was typed: run it again",
  );
  assertEquals(pairFailure(out), "");
});

Deno.test("pair: the console may run it, and it prints lines a program reads", () => {
  assertEquals(ACTIONS["node-pair"].args, ["node", "pair", "--plain"]);
  assert((ACTIONS["node-pair"].timeoutMs ?? 0) > 10 * 60_000);
});
