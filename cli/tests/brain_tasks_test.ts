// The tasks in the brain (shared/mcp/lib/brain-tasks.ts): which profiles use it, and what the
// store says when the brain refuses or is away. The HTTP side runs end to end in brain/tests/e2e.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { brainAccount, brainStore, scoped } from "../../shared/mcp/lib/brain-tasks.ts";

Deno.test("brainAccount: the brain account a profile sees, none without one", () => {
  const all = [
    { service: "brain", name: "brain", url: "https://brain.example" },
    { service: "coolify", name: "ark", url: "https://ark.example" },
  ];
  assertEquals(brainAccount("acme", all)?.name, "brain");
  assertEquals(brainAccount(undefined, all)?.name, "brain"); // the console has no profile
  assertEquals(brainAccount("personal", [{ service: "brain", name: "b", url: "https://x", profiles: ["work"] }]), null);
  assertEquals(brainAccount("personal", [all[1]]), null);
});

Deno.test("brainStore: a refused token and an absent brain say so, a missing task is null", async () => {
  const answer = (status: number, body = "{}") => () => Promise.resolve(new Response(body, { status }));
  await assertRejects(() => brainStore("https://b", "t", answer(401)).list(), Error, "refused the token");
  await assertRejects(() => brainStore("https://b", "t", () => Promise.reject(new TypeError("dns"))).list(), Error, "not answering");
  assertEquals(await brainStore("https://b", "t", answer(404)).get("t-20260101-aaaaaa"), null);
  let seen: Request | null = null;
  const capture = (input: RequestInfo | URL, init?: RequestInit) => { seen = new Request(input, init); return Promise.resolve(new Response("{}")); };
  await brainStore("https://b/", "tok", capture).write({ id: "t-20260101-aaaaaa", title: "x", status: "todo", created: "c", updated: "u" });
  assert(seen !== null);
  assertEquals([(seen as Request).method, (seen as Request).url, (seen as Request).headers.get("authorization")], ["PUT", "https://b/api/tasks/t-20260101-aaaaaa", "Bearer tok"]);
});

Deno.test("scoped: a work profile sees and writes only the tasks of its projects", async () => {
  const mk = (id: string, project?: string) => ({ id, title: id, status: "todo" as const, created: "c", updated: "u", ...(project ? { project } : {}) });
  const all = [mk("t-1", "work/acme/site"), mk("t-2", "work/acme"), mk("t-3", "work"), mk("t-4", "work/acmex"), mk("t-5")];
  const written: string[] = [];
  const base = { list: () => Promise.resolve(all), get: (id: string) => Promise.resolve(all.find((t) => t.id === id) ?? null), write: (t: { id: string }) => { written.push(t.id); return Promise.resolve(); } };
  const s = scoped(base, ["work/acme"]);
  assertEquals((await s.list()).map((t) => t.id), ["t-1", "t-2"]);
  assertEquals(await s.get("t-3"), null);
  await s.write(mk("t-6", "work/acme/shop"));
  await assertRejects(() => s.write(mk("t-7", "personal/dnd")), Error, "work/acme");
  await assertRejects(() => s.write(mk("t-8")), Error, "work/acme");
  assertEquals(written, ["t-6"]);
});
