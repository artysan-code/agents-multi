// The tasks in the brain (shared/mcp/lib/brain-tasks.ts): which profiles use it, and what the
// store says when the brain refuses or is away. The HTTP side runs end to end in brain/tests/e2e.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { brainAccount, brainStore } from "../../shared/mcp/lib/brain-tasks.ts";

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
