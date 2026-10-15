// agentd_test.ts — agentd's tick (apps/cli/node/agentd.ts) against the service's own code (apps/brain/fleet.ts on a
// database in memory): a job signed with the owner's key is taken as a one-shot routine, one signed by anyone
// else is refused, a node at its cap waits, and a run fired here is recorded, checkpointed and reported. Hermetic:
// the hub's state and git in a temp directory.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { decide, jobRoutine, nodeTick, readNodeState, specOfRun } from "../node/agentd.ts";
import { nodeConfigWith } from "../node/command.ts";
import { exposedListeners, probeVerdict } from "../node/probe.ts";
import type { Service } from "../node/service.ts";
import { Fleet, fleetRoute } from "../../brain/fleet.ts";
import { Waiting, waitingRoute } from "../../brain/waiting.ts";
import { Authenticator, SITE } from "./fixtures/authenticator.ts";
import { jobChallenge, signEndorsement } from "../../../shared/mcp/lib/webauthn.ts";
import { Store } from "../../brain/store.ts";
import { approvalKeys, type Job, type JobSpec, normalRemote, signJob } from "../../../shared/mcp/lib/nodes.ts";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { type Fired, readRoutine, type Routine, routinesDir, writeState } from "../../../shared/mcp/lib/routines.ts";
import { isolate, resolvePolicy } from "../../../shared/mcp/lib/policy.ts";

const job = (x: Partial<Job> = {}): Job => ({
  id: "0f1e2d3c-aaaa",
  node: "srv",
  kind: "routine",
  spec: { name: "nightly", repo: "r", path: "app", action: { kind: "agent", profile: "work", task: "tidy" } },
  status: "accepted",
  created: "2026-10-15T20:00:00Z",
  updated: "2026-10-15T20:00:00Z",
  by: "desk",
  ...x,
});

Deno.test("agentd: a job becomes a one-shot routine in the clone; a resume names its run and account", () => {
  const now = new Date("2026-10-15T21:00:00Z");
  const r = jobRoutine(job(), "/srv/site", now);
  assertEquals([r.id, r.folder, r.project, r.trigger, r.job], [
    "job-0f1e2d3caaaa",
    "/srv/site/app",
    "/srv/site",
    { kind: "at", at: now.toISOString() },
    { id: "0f1e2d3c-aaaa" },
  ]);
  const res = jobRoutine(
    job({ kind: "resume", spec: { ...job().spec, id: "nightly-1", from: "desk", account: "home/codex" } }),
    "/srv/site",
    now,
  );
  assertEquals(res.job?.resume, { run: "nightly-1", from: "desk", profile: "home", provider: "codex" });
  let err = "";
  try {
    jobRoutine(job({ kind: "resume" }), "/srv/site", now);
  } catch (e) {
    err = (e as Error).message;
  }
  assertStringIncludes(err, "names its run");
  const back = specOfRun(r, { id: "run-1" } as Fired, "git.example.com/me/site");
  assertEquals(back, { ...job().spec, repo: "git.example.com/me/site", account: "work/claude", id: "run-1" });
});

Deno.test("agentd: refuse what is not the owner's, wait for room or the sandbox, take the rest", () => {
  assertEquals(decide("not signed", true, true), { act: "refuse", why: "not signed" });
  assertEquals(decide(null, false, true), { act: "wait" });
  assertEquals(decide(null, true, false), { act: "wait" });
  assertEquals(decide(null, true, true), { act: "take" });
});

Deno.test("agentd: node.json keeps the owner's other keys when turned on or off", () => {
  const raw = { repoRoots: ["~/work"], headless: true };
  assertEquals(nodeConfigWith(raw, { enabled: true, maxSessions: 2 }), { ...raw, enabled: true, maxSessions: 2 });
  assertEquals(nodeConfigWith(null, { enabled: false }), { enabled: false });
});

Deno.test("agentd: the sandbox probe's verdict, and listeners beyond loopback", () => {
  assertEquals(probeVerdict({ code: 0, err: "" }, true), { ok: true });
  assertEquals(probeVerdict(null, true).ok, false);
  assertStringIncludes(probeVerdict({ code: 0, err: "" }, false).reason!, "socat");
  const p = probeVerdict({ code: 1, err: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" }, true);
  assertStringIncludes(p.reason!, "Can't mount proc");
  assertStringIncludes(p.reason!, "seccomp profile");
  const ss = [
    "LISTEN 0 4096 127.0.0.1:7331 0.0.0.0:*",
    "LISTEN 0 4096 [::1]:7332 [::]:*",
    "LISTEN 0 4096 0.0.0.0:7331 0.0.0.0:*",
    "LISTEN 0 4096 *:7332 *:*",
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
  ].join("\n");
  assertEquals(exposedListeners(ss, [7331, 7332]), ["0.0.0.0:7331", "*:7332"]);
});

async function git(cwd: string, args: string[]) {
  const r = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).output();
  assert(r.success, `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

Deno.test("agentd: a tick takes the owner's job, refuses a forged one, and follows a run to its end", async () => {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "am-agentd-" }));
  const env: Record<string, string> = {
    XDG_STATE_HOME: `${tmp}/state`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const ambient = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("GIT_") && !(k in env));
  const saved = Object.fromEntries([...Object.keys(env), ...ambient].map((k) => [k, Deno.env.get(k)]));
  for (const k of ambient) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    // a remote and this node's clone of it
    const remote = `${tmp}/remote.git`, clone = `${tmp}/work/site`;
    await git(tmp, ["init", "--quiet", "--bare", "-b", "dev", remote]);
    await Deno.mkdir(`${clone}/app`, { recursive: true });
    await git(clone, ["init", "--quiet", "-b", "dev"]);
    await git(clone, ["remote", "add", "origin", remote]);
    await Deno.writeTextFile(`${clone}/app/a.txt`, "a\n");
    await git(clone, ["add", "."]);
    await git(clone, ["commit", "--quiet", "-m", "first"]);
    await git(clone, ["push", "--quiet", "origin", "dev"]);

    // the service, its own code on a database in memory, reached as the node "srv" would
    const db = new Store(":memory:").db;
    const fleet = new Fleet(db), waiting = new Waiting(db, SITE);
    const as = (node: string): Service => ({
      url: SITE.origin,
      async call<T>(method: string, path: string, body?: unknown): Promise<T> {
        const req = new Request(`https://service.test${path}`, {
          method,
          body: body ? JSON.stringify(body) : undefined,
        });
        const u = new URL(req.url);
        const r = (await waitingRoute(req, u, node, waiting, () => [], "u1")) ??
          (await fleetRoute(req, u, node, fleet, (me) => ({ answers: waiting.pending(me) })))!;
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        return j as T;
      },
    });
    const owner = await approvalKeys(new Uint8Array(32).fill(1));
    const stranger = await approvalKeys(new Uint8Array(32).fill(2));
    const cfg = cleanNodeConfig({ enabled: true, name: "srv", repoRoots: [`${tmp}/work`], approvalKey: owner.public });
    const spec: JobSpec = {
      name: "nightly",
      repo: normalRemote(remote),
      path: "app",
      action: { kind: "agent", profile: "work", task: "tidy" },
    };
    const accepted = async (keys: typeof owner) => {
      const p = fleet.create("desk", { kind: "routine", node: "srv", spec });
      const expires = new Date(Date.now() + 3600_000).toISOString();
      const signature = await signJob({ ...p, expires }, keys.sign);
      return fleet.act(p.id, "desk", { op: "accept", signature, expires });
    };
    const good = await accepted(owner), forged = await accepted(stranger);
    const log: string[] = [], told: string[] = [];
    const o = { log: (s: string) => void log.push(s), notify: (t: string) => void told.push(t) };

    await nodeTick({ ...cfg, maxSessions: 0 }, as("srv"), null, o);
    assertEquals(fleet.get(good.id)!.status, "accepted", "no room: it waits");
    assertEquals(fleet.get(forged.id)!.status, "declined", "a forged job is refused even with no room");
    assertStringIncludes(fleet.get(forged.id)!.reason!, "the signature is not the owner's");

    await nodeTick(cfg, as("srv"), null, o);
    assertEquals(fleet.get(good.id)!.status, "running", "claimed");
    const r = (await readRoutine(`job-${good.id.replace(/-/g, "").slice(0, 12)}`))!;
    assertEquals([r.folder, r.project, r.job?.id], [`${clone}/app`, clone, good.id]);
    assertEquals((await readNodeState()).seen.sort(), [forged.id, good.id].sort());
    await nodeTick(cfg, as("srv"), null, o);
    assertEquals(fleet.jobs().filter((j) => j.status === "running").length, 1, "never taken twice");

    // the routine fired (as the tick of routines.ts would): agentd pushes its branch and reports
    const iso = await isolate(clone, "nightly-1", resolvePolicy());
    await Deno.writeTextFile(`${iso.path}/app/b.txt`, "b\n");
    await git(iso.path, ["add", "."]);
    await git(iso.path, ["commit", "--quiet", "-m", "work"]);
    const fired: Fired = {
      id: "nightly-1",
      at: new Date().toISOString(),
      branch: iso.branch,
      worktree: iso.path,
      told: [],
    };
    await writeState(r.id, { runs: [fired] }, routinesDir());
    await nodeTick(cfg, as("srv"), null, o);
    const head = await git(iso.path, ["rev-parse", "HEAD"]);
    assertEquals(fleet.get(good.id)!.head, head, "reported with the head it pushed");
    assertEquals(await git(remote, ["rev-parse", "refs/heads/agent/nightly-1"]), head, "the branch is on the remote");
    await writeState(r.id, { runs: [{ ...fired, ended: new Date().toISOString() }] }, routinesDir());
    await nodeTick(cfg, as("srv"), null, o);
    assertEquals(fleet.get(good.id)!.status, "done");

    // a routine of this node's own: recorded on the service as a local job, resumable from its branch
    const own: Routine = { ...r, id: "own-1", job: undefined, name: "own" };
    await Deno.writeTextFile(`${routinesDir()}/own-1.json`, JSON.stringify(own));
    const iso2 = await isolate(clone, "own-2", resolvePolicy());
    await writeState("own-1", { runs: [{ ...fired, id: "own-2", branch: iso2.branch, worktree: iso2.path }] });
    await nodeTick(cfg, as("srv"), null, o);
    const local = fleet.jobs().find((j) => j.local)!;
    assertEquals([local.node, local.status, local.spec.id, local.spec.repo], ["srv", "running", "own-2", spec.repo]);
    assertEquals(told.length, 1, "the owner was told of the refusal");

    // approved from the phone: an endorsed passkey's assertion is taken as the owner's yes, an unendorsed one is not
    const makePasskey = async (endorsed: boolean) => {
      const ph = await Authenticator.make();
      const chal = (await (await waitingRoute(
        new Request("https://x.test/api/passkeys/options", { method: "POST" }),
        new URL("https://x.test/api/passkeys/options"),
        null,
        waiting,
        () => [],
        "u1",
      ))!.json()).challenge;
      await waiting.register({ name: "Pixel", credential: await ph.register(chal) });
      if (endorsed) waiting.endorse(ph.id, { signature: await signEndorsement(ph.id, ph.publicKey, owner.sign) });
      return ph;
    };
    const byPhone = async (ph: Authenticator) => {
      const p = fleet.create("desk", { kind: "routine", node: "srv", spec });
      const expires = new Date(Date.now() + 3600_000).toISOString();
      const assertion = await ph.assert(await jobChallenge({ id: p.id, node: "srv", kind: "routine", spec, expires }));
      return fleet.act(p.id, "", { op: "accept", assertion, expires });
    };
    const viaGood = await byPhone(await makePasskey(true));
    const viaBad = await byPhone(await makePasskey(false));
    await nodeTick(cfg, as("srv"), null, o);
    assertEquals(fleet.get(viaGood.id)!.status, "running", "the phone's yes, endorsed, starts the job");
    assertEquals(fleet.get(viaBad.id)!.status, "declined", "an unendorsed passkey's does not");
    assertStringIncludes(fleet.get(viaBad.id)!.reason!, "has not been endorsed");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(tmp, { recursive: true });
  }
});
