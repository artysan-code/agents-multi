// The tasks in the brain (shared/mcp/lib/brain-tasks.ts): which profiles use it, and what the
// store says when the brain refuses or is away. The HTTP side runs end to end in apps/brain/tests/e2e.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { brainAccount, brainStore, lazyStore, scoped } from "../../../shared/mcp/lib/brain-tasks.ts";
import { toPrune } from "../brain-backup.ts";
import { StaleError, toFile } from "../../../shared/mcp/lib/tasks.ts";

Deno.test("brainAccount: the brain account a profile sees, none without one", () => {
  const all = [
    { service: "brain", name: "brain", url: "https://brain.example" },
    { service: "coolify", name: "main", url: "https://main.example" },
  ];
  assertEquals(brainAccount("acme", all)?.name, "brain");
  assertEquals(brainAccount(undefined, all)?.name, "brain"); // the console has no profile
  assertEquals(brainAccount("personal", [{ service: "brain", name: "b", url: "https://x", profiles: ["work"] }]), null);
  assertEquals(brainAccount("personal", [all[1]]), null);
});

Deno.test("brainStore: a refused token and an absent brain say so, a missing task is null", async () => {
  const answer = (status: number, body = "{}") => () => Promise.resolve(new Response(body, { status }));
  await assertRejects(() => brainStore("https://b", "t", answer(401)).list(), Error, "refused the token");
  await assertRejects(
    () => brainStore("https://b", "t", () => Promise.reject(new TypeError("dns"))).list(),
    Error,
    "not answering",
  );
  assertEquals(await brainStore("https://b", "t", answer(404)).get("t-20260101-aaaaaa"), null);
  let seen: Request | null = null;
  const capture = (input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Request(input, init);
    return Promise.resolve(new Response("{}"));
  };
  await brainStore("https://b/", "tok", capture).write({
    id: "t-20260101-aaaaaa",
    title: "x",
    status: "todo",
    created: "c",
    updated: "u",
  });
  assert(seen !== null);
  assertEquals([(seen as Request).method, (seen as Request).url, (seen as Request).headers.get("authorization")], [
    "PUT",
    "https://b/api/tasks/t-20260101-aaaaaa",
    "Bearer tok",
  ]);
});

Deno.test("brainStore: a change names the version it was made from; a 409 brings the task as it is now", async () => {
  const t = { id: "t-20260101-aaaaaa", title: "x", status: "todo" as const, created: "c", updated: "u2" };
  let ifMatch: string | null = null;
  await brainStore("https://b", "tok", (input, init) => {
    ifMatch = new Request(input, init).headers.get("if-match");
    return Promise.resolve(new Response("{}"));
  }).write(t, "u1");
  assertEquals(ifMatch, "u1");
  const now = { ...t, title: "changed elsewhere", updated: "u3" };
  const e = await assertRejects(() =>
    brainStore(
      "https://b",
      "tok",
      () => Promise.resolve(Response.json({ error: "x", task: toFile(now) }, { status: 409 })),
    ).write(t, "u1")
  );
  assert(e instanceof StaleError);
  assertEquals((e as StaleError).current.title, "changed elsewhere");
});

Deno.test("scoped: a work profile sees and writes only the tasks of its projects", async () => {
  const mk = (id: string, project?: string) => ({
    id,
    title: id,
    status: "todo" as const,
    created: "c",
    updated: "u",
    ...(project ? { project } : {}),
  });
  const all = [
    mk("t-1", "work/acme/portal"),
    mk("t-2", "work/acme"),
    mk("t-3", "work"),
    mk("t-4", "work/acmex"),
    mk("t-5"),
  ];
  const written: string[] = [];
  const base = {
    list: () => Promise.resolve(all),
    get: (id: string) => Promise.resolve(all.find((t) => t.id === id) ?? null),
    write: (t: { id: string }) => {
      written.push(t.id);
      return Promise.resolve();
    },
  };
  const s = scoped(base, ["work/acme"]);
  assertEquals((await s.list()).map((t) => t.id), ["t-1", "t-2"]);
  assertEquals(await s.get("t-3"), null);
  await s.write(mk("t-6", "work/acme/site"));
  await assertRejects(() => s.write(mk("t-7", "personal/dnd")), Error, "work/acme");
  await assertRejects(() => s.write(mk("t-8")), Error, "work/acme");
  assertEquals(written, ["t-6"]);
});

Deno.test("lazyStore: a token missing at start is read again later, then kept", async () => {
  const account = { service: "brain", name: "brain", url: "https://b" };
  let token: string | null = null, reads = 0;
  const made: string[] = [];
  const s = lazyStore(account, () => {
    reads++;
    return Promise.resolve(token);
  }, (url, tok) => {
    made.push(`${url} ${tok}`);
    return { list: () => Promise.resolve([]), get: () => Promise.resolve(null), write: () => Promise.resolve() };
  });
  await assertRejects(() => s.list(), Error, "https://b/account");
  token = "tok";
  assertEquals(await s.list(), []);
  await s.get("t-1");
  assertEquals([reads, made], [2, ["https://b tok"]]);
});

Deno.test("toPrune: the oldest brain copies beyond the ones to keep, nothing else", () => {
  const names = [
    "brain-2026-10-01T09-00.brn",
    "brain-2026-10-02T09-00.brn",
    "brain-2026-09-30T09-00.brn",
    "notes.txt",
    ".brain-x.brn.tmp",
  ];
  assertEquals(toPrune(names, 2), ["brain-2026-09-30T09-00.brn"]);
  assertEquals(toPrune(names, 5), []);
});
