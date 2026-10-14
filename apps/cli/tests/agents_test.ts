// Tests for the hub's children (shared/mcp/lib/agents.ts): a child's state from its events, what needs
// the owner between two looks, the lines written on its stdin, and a whole round with a stand-in for
// Claude — started detached, a permission asked, answered, the turn ended, a message, the stop.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  accessOf,
  adoptable,
  adoptChild,
  answer,
  answerLine,
  type Attention,
  attentionBetween,
  attentionOf,
  childId,
  childIn,
  childMode,
  type ChildState,
  type Coordinator,
  inScope,
  isUnder,
  listChildren,
  mayAct,
  mayAdopt,
  type Owned,
  projectOf,
  questionsOf,
  readChild,
  refusal,
  rootFromGitFile,
  runsBy,
  sayTo,
  type Scope,
  sessionRule,
  startChild,
  stateOf,
  stopChild,
  validId,
  waitForAttention,
  whatOf,
} from "../../../shared/mcp/lib/agents.ts";
import { forgetProcs, type ProcReader, procReader } from "../../../shared/mcp/lib/proc.ts";
import { adoptRun, answerRun, follow, listRuns, runIn } from "../../../shared/mcp/lib/runs.ts";
import { REPO } from "../lib/paths.ts";

const ev = (o: unknown) => JSON.stringify(o);
const ask = (id: string, command = "git push") =>
  ev({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command } },
  });

Deno.test("agents: a child's state — working, waiting on a request, idle after a turn, ended", () => {
  const init = ev({ type: "system", subtype: "init", session_id: "s" });
  const said = ev({ type: "assistant", message: { content: [{ type: "text", text: "looking" }] } });
  const done = ev({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.2 });
  const working = stateOf([init, said], new Set(), true);
  assertEquals([working.phase, working.session, working.said], ["working", "s", ["looking"]]);
  const waiting = stateOf([init, said, ask("r1")], new Set(), true);
  assertEquals([waiting.phase, waiting.pending[0].what], ["waiting", "Bash: git push"]);
  assertEquals(stateOf([init, ask("r1")], new Set(["r1"]), true).phase, "working"); // answered
  const cancelled = ev({ type: "control_cancel_request", request_id: "r1" });
  assertEquals(stateOf([init, ask("r1"), cancelled], new Set(), true).pending, []);
  const idle = stateOf([init, said, done], new Set(), true);
  assertEquals([idle.phase, idle.turns, idle.lastResult, idle.costUsd], ["idle", 1, "done", 0.2]);
  assertEquals(stateOf([init, "torn {", done], new Set(), false).phase, "ended");
});

Deno.test("agents: what needs the owner between two looks — new requests, finished turns, a child gone", () => {
  const s = (o: Partial<ChildState>): ChildState => ({
    phase: "working",
    session: null,
    pending: [],
    said: [],
    turns: 0,
    lastResult: null,
    error: null,
    costUsd: 0,
    ...o,
  });
  const p = (request: string) => ({
    request,
    kind: "request" as const,
    tool: "Bash",
    what: `Bash: ${request}`,
    input: {},
    session: "Bash",
    at: 0,
  });
  const before = new Map([["a", s({ pending: [p("r1")] })], ["b", s({})]]);
  const after = new Map([
    ["a", s({ phase: "waiting", pending: [p("r1"), p("r2")] })],
    ["b", s({ phase: "ended", turns: 1, lastResult: "ok" })],
    ["c", s({ pending: [p("r9")] })],
  ]);
  assertEquals(attentionBetween(before, after), [
    { id: "a", kind: "request", detail: "Bash: r2", request: "r2", session: "Bash" },
    { id: "b", kind: "done", detail: "ok" },
    { id: "b", kind: "ended", detail: "" },
    { id: "c", kind: "request", detail: "Bash: r9", request: "r9", session: "Bash" },
  ]);
  assertEquals(attentionBetween(after, after), []);
});

Deno.test("agents: the lines on a child's stdin, ids and a request in one line", () => {
  const p = {
    request: "r1",
    kind: "request" as const,
    tool: "Bash",
    what: "",
    input: { command: "ls -la" },
    session: "Bash(ls:*)",
    at: 0,
  };
  assertEquals(JSON.parse(answerLine(p, "allow")).response.response, {
    behavior: "allow",
    updatedInput: { command: "ls -la" },
  });
  assertEquals(JSON.parse(answerLine(p, "session")).response.response, {
    behavior: "allow",
    updatedInput: { command: "ls -la" },
    updatedPermissions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
      behavior: "allow",
      destination: "session",
    }],
  });
  assertEquals(JSON.parse(answerLine(p, "deny", " no ")).response.response, { behavior: "deny", message: "no" });
  assertEquals(JSON.parse(answerLine(p, "deny")).response.request_id, "r1");
  assertEquals(whatOf("Edit", { file_path: "/a/b.ts", old_string: "x" }), "Edit: /a/b.ts");
  assertEquals(whatOf("Bash", { command: "a\n  b" }), "Bash: a b");
  const id = childId("otacon", "/home/x/work/Lead Qualificator", new Date("2026-10-09T10:20:00Z"), "ab12");
  assertEquals(id, "otacon-lead-qualificator-10091020-ab12");
  assert(validId(id));
  for (const bad of ["../x", "A-b", "x", "a b", ""]) assert(!validId(bad), bad);
});

Deno.test("agents: a child's AskUserQuestion waits as a question, answered with the owner's labels", () => {
  const questions = [
    { question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
  ];
  const line = ev({
    type: "control_request",
    request_id: "q1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions } },
  });
  const st = stateOf([line], new Set(), true);
  const q = st.pending[0];
  assertEquals([st.phase, q.kind, q.what, q.session, q.questions], [
    "waiting",
    "question",
    "Question: Which color?",
    "",
    questions,
  ]);
  assertEquals(attentionOf("a", q), { id: "a", kind: "question", detail: q.what, request: "q1", questions });
  assertEquals(JSON.parse(answerLine(q, "allow", undefined, { "Which color?": "Blue" })).response.response, {
    behavior: "allow",
    updatedInput: { questions, answers: { "Which color?": "Blue" } },
  });
  // "session" on a question answers it the same way: there is no rule to add
  assertEquals(
    JSON.parse(answerLine(q, "session", undefined, { "Which color?": "Red" })).response.response.updatedPermissions,
    undefined,
  );
  assertThrows(() => answerLine(q, "allow"), Error, "no answer for: Which color?");
  assertThrows(() => answerLine(q, "allow", undefined, { "Which color?": " " }), Error, "no answer");
  assertEquals(JSON.parse(answerLine(q, "deny")).response.response.behavior, "deny");
  assertEquals(questionsOf("AskUserQuestion", { questions: [] }), null);
  assertEquals(questionsOf("Bash", { questions }), null);
});

Deno.test("agents: the events follow what waits now, then what happens, and skip a child that ended", async () => {
  const runs = await Deno.makeTempDir();
  const child = async (id: string, pid: number, lines: string[]) => {
    await Deno.mkdir(`${runs}/${id}`);
    await Deno.writeTextFile(`${runs}/${id}/meta.json`, JSON.stringify({ id, started: id }));
    await Deno.writeTextFile(`${runs}/${id}/claude.pid`, String(pid));
    await Deno.writeTextFile(`${runs}/${id}/out.jsonl`, lines.join("\n") + "\n");
  };
  await child("live-one", Deno.pid, [ask("r1")]);
  await child("gone-one", 0, [ask("r2")]);
  const stop = new AbortController();
  const it = follow(runs, 50, stop.signal);
  assertEquals((await it.next()).value, {
    id: "live-one",
    kind: "request",
    detail: "Bash: git push",
    request: "r1",
    session: "Bash(git push)",
  });
  await Deno.writeTextFile(
    `${runs}/live-one/out.jsonl`,
    ev({ type: "result", subtype: "success", result: "ok" }) + "\n",
    {
      append: true,
    },
  );
  assertEquals((await it.next()).value, { id: "live-one", kind: "done", detail: "ok" });
  stop.abort();
  await it.return(undefined);
  await Deno.remove(runs, { recursive: true });
});

Deno.test("agents: a whole round with a stand-in for Claude, detached, through its fifo", async () => {
  const home = await Deno.makeTempDir();
  try {
    const runs = `${home}/runs`, config = `${home}/config`, work = `${home}/work/proj`;
    await Deno.mkdir(`${config}/profiles/fake`, { recursive: true });
    await Deno.mkdir(work, { recursive: true });
    await Deno.writeTextFile(
      `${config}/profiles/fake/profile.json`,
      JSON.stringify({ command: `${REPO}/apps/cli/tests/fixtures/fake-claude.sh` }),
    );
    await assertRejects(() => startChild({ profile: "nope", dir: work, task: "x" }, runs, home, config));
    await assertRejects(() => startChild({ profile: "fake", dir: "/etc", task: "x" }, runs, home, config));
    // `..` and a link both lead out of the home folder
    await assertRejects(() => startChild({ profile: "fake", dir: "~/..", task: "x" }, runs, home, config));
    await Deno.symlink("/etc", `${home}/work/out`);
    await assertRejects(() => startChild({ profile: "fake", dir: "~/work/out", task: "x" }, runs, home, config));
    await Deno.mkdir(`${home}/.agents-multi/fake`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.agents-multi/fake/settings.json`,
      JSON.stringify({ permissions: { defaultMode: "auto" } }),
    );
    const meta = await startChild({ profile: "fake", dir: "~/work/proj", task: "push it" }, runs, home, config);
    assertEquals([meta.dir, meta.mode], [work, "auto"]);
    const until = async (ok: (s: ChildState) => boolean) => {
      for (let t = 0; t < 100; t++) {
        const c = await readChild(meta.id, runs);
        if (c && ok(c.state)) return c.state;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`stuck: ${JSON.stringify((await readChild(meta.id, runs))?.state)}`);
    };
    const waiting = await until((s) => s.phase === "waiting");
    assertEquals(waiting.pending.map((p) => p.what), ["Bash: git push"]);
    await assertRejects(() => answer(meta.id, "r-404", "allow", undefined, runs));
    await answer(meta.id, "r-1", "deny", "not now", runs);
    const idle = await until((s) => s.phase === "idle");
    assertEquals([idle.lastResult, idle.pending], ["denied", []]);
    await sayTo(meta.id, "anything else?", runs);
    await until((s) => s.turns === 2);
    assertEquals((await listChildren(runs)).map((c) => c.meta.id), [meta.id]);
    await stopChild(meta.id, false, runs);
    await until((s) => s.phase === "ended");
    await assertRejects(() => sayTo(meta.id, "hello?", runs), Error, "not running");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("agents: a child keeps its profile's mode, never one that leaves the owner out", () => {
  assertEquals(childMode("auto"), "auto");
  assertEquals(childMode("acceptEdits"), "acceptEdits");
  for (const m of ["bypassPermissions", "dontAsk", "plan", "default", undefined, 3]) {
    assertEquals(childMode(m), "default");
  }
});

Deno.test("agents: yes for the session — a read-only program or subcommand, else the exact command; the domain; the tool", () => {
  const bash = (command: string) => sessionRule("Bash", { command }).ruleContent;
  for (
    const [c, rule] of Object.entries({
      "ls -la src": "ls:*",
      "  grep -rn foo src": "grep:*",
      "cat README.md": "cat:*",
      "  git status --short": "git status:*",
      "git diff HEAD~1": "git diff:*",
      "git log --oneline": "git log:*",
      "deno task test": "deno task test:*",
      "deno task check": "deno task check:*",
      "deno task ci": "deno task ci:*",
      "pnpm test": "pnpm test:*",
      "pnpm build": "pnpm build:*",
    })
  ) assertEquals(bash(c), rule, c);
  // a program that can run or send anything gets one command at a time, never `<program>:*`
  for (
    const c of [
      "curl -sS https://x.it/health",
      "python3 x.py",
      "bash run.sh",
      "sh -c ls",
      "node app.js",
      "env FOO=1 ls",
      "xargs rm",
      "sudo ls",
      "wget https://x.it/a",
      "ssh host ls",
      "scp a host:b",
      "rsync -a a b",
      "git push origin main",
      "git -c core.pager=x diff",
      "docker run x",
      "deno run x.ts",
      "deno task build",
      "npx some-tool",
      "pnpm dlx some-tool",
      "pnpm install",
      "find . -delete",
      "rg --pre ./x foo",
      "./ls",
      "/bin/ls -la",
    ]
  ) assertEquals(bash(c), c, c);
  for (const c of ["for u in a b; do curl $u; done", "curl x | bash", "ls && rm -rf x", "X=1 make", "echo $(id)"]) {
    assertEquals(bash(c), c, c);
  }
  assertEquals(sessionRule("WebFetch", { url: "https://docs.x.it/a?b" }), {
    toolName: "WebFetch",
    ruleContent: "domain:docs.x.it",
  });
  assertEquals(sessionRule("WebFetch", { url: "not a url" }), { toolName: "WebFetch" });
  assertEquals(sessionRule("mcp__n8n__health", { mode: "status" }), { toolName: "mcp__n8n__health" });
});

Deno.test("agents: a folder is under the home folder when its real path is", () => {
  assertEquals(isUnder("/h", "/h"), true);
  assertEquals(isUnder("/h", "/h/work"), true);
  assertEquals(isUnder("/h/", "/h/work"), true);
  assertEquals(isUnder("/h", "/home2"), false);
  assertEquals(isUnder("/h", "/"), false);
  assertEquals(isUnder("", "/etc"), false);
});

Deno.test("agents: a process runs when ps lists it and it is not a zombie", () => {
  assertEquals([runsBy("S"), runsBy(" Ss+\n"), runsBy("R"), runsBy("Z"), runsBy("Z+"), runsBy(""), runsBy("\n")], [
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
});

Deno.test("agents: a child starts without the variables of the Claude session that started the hub", async () => {
  const home = await Deno.makeTempDir();
  const set = ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];
  try {
    const runs = `${home}/runs`, config = `${home}/config`, work = `${home}/work/proj`;
    await Deno.mkdir(`${config}/profiles/envy`, { recursive: true });
    await Deno.mkdir(work, { recursive: true });
    // a stand-in that writes what it was given and reads its stdin until it is stopped
    const bin = `${home}/envy.sh`;
    await Deno.writeTextFile(bin, '#!/usr/bin/env bash\nenv > "$PWD/env.txt"\ncat > /dev/null\n');
    await Deno.chmod(bin, 0o755);
    await Deno.writeTextFile(`${config}/profiles/envy/profile.json`, JSON.stringify({ command: bin }));
    for (const n of set) Deno.env.set(n, "/the/coordinator");
    Deno.env.set("AGENTS_MULTI_KEEP", "1");
    const meta = await startChild({ profile: "envy", dir: work, task: "x" }, runs, home, config);
    let env = "";
    for (let t = 0; t < 100 && !env; t++) {
      env = await Deno.readTextFile(`${work}/env.txt`).catch(() => "");
      if (!env) await new Promise((r) => setTimeout(r, 50));
    }
    const names = env.split("\n").map((l) => l.split("=")[0]);
    for (const n of set) assert(!names.includes(n), `${n} reached the child`);
    assert(names.includes("AGENTS_MULTI_KEEP") && names.includes("HOME"));
    await stopChild(meta.id, true, runs);
  } finally {
    for (const n of [...set, "AGENTS_MULTI_KEEP"]) Deno.env.delete(n);
    await Deno.remove(home, { recursive: true });
  }
});

// ---- isolation by project (docs/adr/0005, "Isolated by project")

Deno.test("agents: rootFromGitFile — a worktree resolves to its main repository, a submodule to itself", () => {
  assertEquals(rootFromGitFile("gitdir: /h/p/main/.git/worktrees/wt\n", "/h/p/wt"), "/h/p/main");
  assertEquals(rootFromGitFile("gitdir: ../main/.git/worktrees/wt", "/h/p/wt"), "/h/p/main");
  assertEquals(rootFromGitFile("gitdir: ../.git/modules/sub", "/h/p/sub"), "/h/p/sub");
  assertEquals(rootFromGitFile("not a gitdir file", "/h/p/x"), "/h/p/x");
});

Deno.test("agents: projectOf — a repository's subfolder, its worktree, a plain folder", async () => {
  const t = await Deno.realPath(await Deno.makeTempDir());
  try {
    const git = (cwd: string, ...a: string[]) =>
      new Deno.Command("git", {
        args: a,
        cwd,
        clearEnv: true,
        env: { PATH: Deno.env.get("PATH") ?? "", HOME: t },
        stdout: "null",
        stderr: "null",
      })
        .output();
    await Deno.mkdir(`${t}/repo/src/deep`, { recursive: true });
    await git(`${t}/repo`, "init", "-q");
    await git(`${t}/repo`, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    await git(`${t}/repo`, "worktree", "add", "-q", `${t}/wt`, "-b", "other");
    await Deno.mkdir(`${t}/plain/sub`, { recursive: true });
    assertEquals(await projectOf(`${t}/repo/src/deep`), `${t}/repo`);
    assertEquals(await projectOf(`${t}/wt`), `${t}/repo`);
    assertEquals(await projectOf(`${t}/plain/sub`), `${t}/plain/sub`);
  } finally {
    await Deno.remove(t, { recursive: true });
  }
});

/** Two live processes to be coordinators, and a coordinator that is gone (a live pid, another start time:
 *  a pid that was reused). Real processes: the hub reads /proc. */
async function withCoordinators(
  f: (who: { a: Coordinator; b: Coordinator; gone: Coordinator }) => Promise<void>,
): Promise<void> {
  const sleepers = [0, 1].map(() => new Deno.Command("sleep", { args: ["60"], stdout: "null" }).spawn());
  try {
    forgetProcs();
    const [a, b] = sleepers.map((p) => ({ pid: p.pid, start: procReader(p.pid)!.start }));
    await f({ a, b, gone: { pid: a.pid, start: "1" } });
  } finally {
    for (const p of sleepers) {
      p.kill();
      await p.status;
    }
  }
}

Deno.test("agents: accessOf and the scope filters — own, peer, orphan, other project, all", async () => {
  await withCoordinators(({ a, b, gone }) => {
    const here: Scope = { project: "/p/a", me: a };
    const at = (project: string | undefined, owner?: Coordinator): Owned => ({ project, owner });
    assertEquals(accessOf(at("/p/a", a), here), "own");
    assertEquals(accessOf(at("/p/a", { ...a, session: "x" }), { ...here, me: { ...a, session: "y" } }), "own");
    assertEquals(accessOf(at("/p/a", b), here), "peer");
    assertEquals(accessOf(at("/p/a", gone), here), "orphan", "pid reused: another start time");
    assertEquals(accessOf(at("/p/a"), here), "orphan", "no owner recorded (older than owners)");
    assertEquals(accessOf(at("/p/b", a), here), "other");
    assertEquals(accessOf(at(undefined, a), here), "other", "no project at all");
    assertEquals(accessOf(undefined, here), "other");
    // default: own and the project's orphans; project adds the peers; all adds everything
    const seen = (v: Scope["view"]) =>
      [at("/p/a", a), at("/p/a", b), at("/p/a", gone), at("/p/b", a), at(undefined)].map((o) =>
        inScope(o, { ...here, view: v })
      );
    assertEquals(seen("mine"), [true, false, true, false, false]);
    assertEquals(seen(undefined), [true, false, true, false, false]);
    assertEquals(seen("project"), [true, true, true, false, false]);
    assertEquals(seen("all"), [true, true, true, true, true]);
    // acting: only on its own — an orphan is adopted first, a peer's and another project's never
    assertEquals([at("/p/a", a), at("/p/a", b), at("/p/a", gone), at("/p/b", a)].map((o) => mayAct(o, here)), [
      true,
      false,
      false,
      false,
    ]);
    assert(mayAct(at("/p/a", a), { ...here, view: "all" }), "the view does not change who owns");
    assertEquals([at("/p/a", a), at("/p/a", b), at("/p/a", gone), at("/p/b", gone)].map((o) => mayAdopt(o, here)), [
      false,
      false,
      true,
      false,
    ]);
    // a person at a plain terminal (no coordinator) is the coordinator of the project's children
    const person: Scope = { project: "/p/a" };
    assertEquals([at("/p/a", b), at("/p/a", gone), at("/p/a"), at("/p/b", b)].map((o) => mayAct(o, person)), [
      true,
      true,
      true,
      false,
    ]);
    assertEquals(mayAdopt(at("/p/a", gone), person), false, "nobody to adopt it for");
    assertEquals(adoptable("x", at("/p/a", gone), here), a);
    assertThrows(() => adoptable("x", at("/p/a", gone), person), Error, "no `claude` process");
    assertThrows(() => adoptable("x", at("/p/a", b), here), Error, "live coordinator");
    assertThrows(() => adoptable("x", at("/p/a", a), here), Error, "already yours");
    assertThrows(() => adoptable("x", at("/p/b", gone), here), Error, "across projects");
    assert(refusal("x", at("/p/a", b), here).includes("another live session"));
    return Promise.resolve();
  });
});

Deno.test("agents: a fake process table — accessOf needs no real process", () => {
  const table = new Map([[10, { ppid: 1, comm: "claude-bin", start: "500" }]]);
  const read: ProcReader = (pid) => table.get(pid) ?? null;
  const me: Coordinator = { pid: 10, start: "500" };
  const scope: Scope = { project: "/p", me };
  assertEquals(accessOf({ project: "/p", owner: me }, scope, read), "own");
  table.set(10, { ppid: 1, comm: "claude-bin", start: "900" });
  assertEquals(accessOf({ project: "/p", owner: me }, scope, read), "orphan", "same pid, new process");
  table.delete(10);
  assertEquals(accessOf({ project: "/p", owner: me }, scope, read), "orphan", "gone");
});

Deno.test("agents: children of two sessions in one project — each sees its own, orphans adoptable, never across projects", async () => {
  const t = await Deno.realPath(await Deno.makeTempDir());
  const runs = `${t}/runs`;
  try {
    await withCoordinators(async ({ a, b, gone }) => {
      const make = async (id: string, project: string | undefined, owner?: Coordinator) => {
        await Deno.mkdir(`${runs}/${id}`, { recursive: true });
        const meta = {
          id,
          profile: "x",
          command: "x",
          dir: project ?? "/p/a",
          task: "t",
          started: "2026-01-01T00:00:00Z",
          project,
          owner,
        };
        await Deno.writeTextFile(`${runs}/${id}/meta.json`, JSON.stringify(meta));
      };
      await make("by-a-0101", "/p/a", a);
      await make("by-b-0101", "/p/a", b);
      await make("dead-0101", "/p/a", gone);
      await make("legacy-0101", undefined); // older than projects: its folder's project, no owner
      await make("elsewhere-0101", "/p/b", gone);
      const ids = async (s: Scope) => (await listChildren(runs, s)).map((c) => c.meta.id).sort();
      const sa: Scope = { project: "/p/a", me: a };
      const sb: Scope = { project: "/p/a", me: b };
      assertEquals(await ids(sa), ["by-a-0101", "dead-0101", "legacy-0101"]);
      assertEquals(await ids(sb), ["by-b-0101", "dead-0101", "legacy-0101"]);
      assertEquals(await ids({ ...sa, view: "project" }), ["by-a-0101", "by-b-0101", "dead-0101", "legacy-0101"]);
      assertEquals((await ids({ ...sa, view: "all" })).length, 5);
      assertEquals((await listChildren(runs)).length, 5, "no scope (the runner's own view) sees all");
      const access = Object.fromEntries((await listChildren(runs, sa)).map((c) => [c.meta.id, c.access]));
      assertEquals(access, { "by-a-0101": "own", "dead-0101": "orphan", "legacy-0101": "orphan" });
      // a peer's: not even read, but with project read-only; never written
      await assertRejects(() => childIn("by-b-0101", sa, runs), Error, "another live session");
      assertEquals((await childIn("by-b-0101", { ...sa, view: "project" }, runs)).access, "peer");
      await assertRejects(() => sayTo("by-b-0101", "hi", runs, { ...sa, view: "project" }), Error, "another live");
      await assertRejects(() => stopChild("by-b-0101", false, runs, sa), Error, "another live");
      await assertRejects(
        () => answer("by-b-0101", "r", "allow", undefined, runs, undefined, { ...sa, view: "all" }),
        Error,
        "another live",
      );
      // another project's
      await assertRejects(() => childIn("elsewhere-0101", sa, runs), Error, "another project");
      assertEquals((await childIn("elsewhere-0101", { ...sa, view: "all" }, runs)).access, "other");
      await assertRejects(() => adoptChild("elsewhere-0101", sa, runs), Error, "across projects");
      // an orphan: seen and marked, not acted on until adopted
      await assertRejects(() => sayTo("dead-0101", "hi", runs, sa), Error, "adopt it first");
      await assertRejects(() => adoptChild("by-b-0101", sa, runs), Error, "live coordinator");
      await assertRejects(() => adoptChild("by-a-0101", sa, runs), Error, "already yours");
      await adoptChild("dead-0101", sa, runs);
      await adoptChild("legacy-0101", sa, runs);
      assertEquals((await readChild("dead-0101", runs))?.meta.owner, a);
      assertEquals((await readChild("legacy-0101", runs))?.meta.project, "/p/a");
      assertEquals(await ids(sa), ["by-a-0101", "dead-0101", "legacy-0101"]);
      assertEquals(await ids(sb), ["by-b-0101"], "adopted: no longer b's to see");
      assertEquals((await childIn("dead-0101", sa, runs, true)).access, "own");
      // the person at a terminal acts on the project's children without adopting
      const person: Scope = { project: "/p/a" };
      await assertRejects(() => adoptChild("by-a-0101", person, runs), Error, "no `claude` process");
      assertEquals((await childIn("by-b-0101", person, runs, true)).meta.id, "by-b-0101");
      await assertRejects(() => childIn("elsewhere-0101", person, runs, true), Error, "another project");
    });
  } finally {
    await Deno.remove(t, { recursive: true });
  }
});

Deno.test("agents: runs keep to their coordinator; an orphan run is adopted with its children, an old run is its folder's project's", async () => {
  const t = await Deno.realPath(await Deno.makeTempDir());
  const runs = `${t}/runs`;
  try {
    await withCoordinators(async ({ a, b, gone }) => {
      const run = async (id: string, owned?: Owned, folder?: string) => {
        const dir = `${runs}/runs/${id}`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/plan.json`, JSON.stringify({ name: id, folder, steps: [] }));
        await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify({ status: "running", steps: {} }));
        if (owned) await Deno.writeTextFile(`${dir}/owner.json`, JSON.stringify(owned));
      };
      await run("r-a", { project: "/p/a", owner: a });
      await run("r-b", { project: "/p/a", owner: b });
      await run("r-dead", { project: "/p/a", owner: gone });
      await run("r-other", { project: "/p/b", owner: gone });
      await run("r-old", undefined, "/p/a"); // no owner.json: its folder's project, an orphan
      // a child of the orphan run, orphan too
      await Deno.mkdir(`${runs}/step-0101`, { recursive: true });
      await Deno.writeTextFile(
        `${runs}/step-0101/meta.json`,
        JSON.stringify({
          id: "step-0101",
          profile: "x",
          command: "x",
          dir: "/p/a",
          task: "t",
          started: "2026-01-01T00:00:00Z",
          project: "/p/a",
          owner: gone,
          run: { id: "r-dead", step: "s" },
        }),
      );
      const sa: Scope = { project: "/p/a", me: a };
      assertEquals((await listRuns(runs, sa)).map((r) => [r.id, r.access]), [
        ["r-a", "own"],
        ["r-dead", "orphan"],
        ["r-old", "orphan"],
      ]);
      assertEquals((await listRuns(runs, { ...sa, view: "project" })).length, 4);
      assertEquals((await listRuns(runs, { ...sa, view: "all" })).length, 5);
      await assertRejects(() => runIn("r-b", sa, runs), Error, "another live session");
      await assertRejects(() => runIn("r-other", sa, runs), Error, "another project");
      await assertRejects(() => answerRun("r-b", "stop", undefined, runs, { ...sa, view: "project" }), Error, "live");
      await assertRejects(() => answerRun("r-dead", "stop", undefined, runs, sa), Error, "adopt it first");
      await assertRejects(() => adoptRun("r-other", sa, runs), Error, "across projects");
      await assertRejects(() => adoptRun("r-b", sa, runs), Error, "live coordinator");
      await adoptRun("r-dead", sa, runs);
      assertEquals((await runIn("r-dead", sa, runs, true)).access, "own");
      assertEquals((await readChild("step-0101", runs))?.meta.owner, a, "its children come with it");
      await adoptRun("r-old", sa, runs);
      assertEquals((await runIn("r-old", sa, runs, true)).project, "/p/a");
      assertEquals((await listRuns(runs, { project: "/p/a", me: b })).map((r) => r.id), ["r-b"]);
    });
  } finally {
    await Deno.remove(t, { recursive: true });
  }
});

Deno.test("agents: follow and waitForAttention keep to the caller's session, mark an orphan's events, all shows every one", async () => {
  const t = await Deno.realPath(await Deno.makeTempDir());
  const runs = `${t}/runs`;
  try {
    await withCoordinators(async ({ a, b, gone }) => {
      for (
        const [id, project, owner] of [["a-one-0101", "/p/a", a], ["b-two-0101", "/p/a", b], [
          "dead-0101",
          "/p/a",
          gone,
        ], ["z-three-0101", "/p/b", a]] as const
      ) {
        const dir = `${runs}/${id}`;
        await Deno.mkdir(dir, { recursive: true });
        const meta = {
          id,
          profile: "x",
          command: "x",
          dir: "/",
          task: "t",
          started: "2026-01-01T00:00:00Z",
          project,
          owner,
        };
        await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify(meta));
        await Deno.writeTextFile(`${dir}/out.jsonl`, ask(`req-${id}`) + "\n");
        await Deno.writeTextFile(`${dir}/child.pid`, String(Deno.pid));
      }
      const first = async (scope: Scope) => {
        const ac = new AbortController();
        const got: Attention[] = [];
        setTimeout(() => ac.abort(), 400);
        for await (const x of follow(runs, 50, ac.signal, scope)) {
          got.push(x);
          if (got.length >= 4) break;
        }
        return got;
      };
      const mine = await first({ project: "/p/a", me: a });
      const byId = (l: Attention[]) => l.toSorted((x, y) => x.id.localeCompare(y.id));
      assertEquals(byId(mine).map((x) => [x.id, x.orphan]), [["a-one-0101", undefined], ["dead-0101", true]]);
      assertEquals(byId(await first({ project: "/p/a", me: b })).map((x) => x.id), ["b-two-0101", "dead-0101"]);
      assertEquals((await first({ project: "/p/a", me: a, view: "all" })).length, 4);
      const found = await waitForAttention(300, runs, 50, { project: "/p/a", me: a });
      assertEquals(found, [], "nothing new for it");
    });
  } finally {
    await Deno.remove(t, { recursive: true });
  }
});
