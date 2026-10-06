// End to end against a running brain with an empty data folder: the OAuth dance Claude does, then
// the MCP tools, as the first account. Start one, then run this with the same URL, account and passphrase:
//   BRAIN_URL=http://127.0.0.1:8787 BRAIN_MASTER_KEY=$(head -c32 /dev/urandom | base64) BRAIN_ADMIN_ID=me BRAIN_PASSPHRASE=… \
//     BRAIN_DEV=1 BRAIN_DATA=$(mktemp -d) PORT=8787 deno run -A apps/brain/main.ts
//   BRAIN_URL=http://127.0.0.1:8787 BRAIN_USER=me BRAIN_PASSPHRASE=… deno run -A apps/brain/tests/e2e.ts
const B = Deno.env.get("BRAIN_URL") ?? "http://127.0.0.1:8787";
const PASS = Deno.env.get("BRAIN_PASSPHRASE") ?? "";
const USER = Deno.env.get("BRAIN_USER") ?? "me";
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "ok  " : "FAIL"} ${m}`);
  if (!c) Deno.exitCode = 1;
};
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let r = await fetch(`${B}/mcp`, { method: "POST", body: "{}" });
ok(
  r.status === 401 && /resource_metadata=/.test(r.headers.get("www-authenticate") ?? ""),
  "no token: 401 with resource_metadata",
);
await r.body?.cancel();
const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource`)).json();
const asm = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
ok(prm.authorization_servers[0] === B && asm.code_challenge_methods_supported[0] === "S256", "discovery");

r = await fetch(`${B}/register`, {
  method: "POST",
  body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], client_name: "x" }),
});
ok(r.status === 400, "register refuses a foreign redirect");
await r.body?.cancel();
const reg = await (await fetch(`${B}/register`, {
  method: "POST",
  body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"], client_name: "Claude Code" }),
})).json();
ok(!!reg.client_id, "register a loopback client");

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const q = new URLSearchParams({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: "http://127.0.0.1:43210/callback",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "s1",
  resource: `${B}/mcp`,
});
r = await fetch(`${B}/authorize?${q}`);
ok(r.status === 200 && (await r.text()).includes("Collega Claude Code"), "authorize page");
r = await fetch(`${B}/authorize`, {
  method: "POST",
  body: new URLSearchParams({ ...Object.fromEntries(q), user: USER, passphrase: "sbagliata-lunga" }),
  redirect: "manual",
});
ok(r.status === 401, "wrong passphrase refused");
await r.body?.cancel();
r = await fetch(`${B}/authorize`, {
  method: "POST",
  body: new URLSearchParams({ ...Object.fromEntries(q), user: USER, passphrase: PASS }),
  redirect: "manual",
});
const loc = new URL(r.headers.get("location") ?? "http://x/");
ok(
  r.status === 302 && loc.port === "43210" && loc.searchParams.get("state") === "s1",
  "signed in: redirected with code and state",
);
const code = loc.searchParams.get("code")!;
const tokenReq = (f: Record<string, string>) =>
  fetch(`${B}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(f),
  });
r = await tokenReq({
  grant_type: "authorization_code",
  code,
  client_id: reg.client_id,
  redirect_uri: "http://127.0.0.1:43210/callback",
  code_verifier: "wrong".padEnd(43, "x"),
});
ok(r.status === 400, "bad PKCE verifier refused (and the code is now spent)");
await r.body?.cancel();
// a fresh code for the real exchange
r = await fetch(`${B}/authorize`, {
  method: "POST",
  body: new URLSearchParams({ ...Object.fromEntries(q), user: USER, passphrase: PASS }),
  redirect: "manual",
});
const code2 = new URL(r.headers.get("location")!).searchParams.get("code")!;
const tok = await (await tokenReq({
  grant_type: "authorization_code",
  code: code2,
  client_id: reg.client_id,
  redirect_uri: "http://127.0.0.1:43210/callback",
  code_verifier: verifier,
})).json();
ok(!!tok.access_token && !!tok.refresh_token, "token exchange");

let id = 0;
const mcp = async (method: string, params: unknown = {}) => {
  const res = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return await res.json();
};
const call = async (name: string, args: unknown) => {
  const j = await mcp("tools/call", { name, arguments: args });
  if (j.error || j.result?.isError) return { error: j.error?.message ?? j.result.content[0].text };
  return JSON.parse(j.result.content[0].text);
};
const init = await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "1" },
});
ok(
  init.result?.serverInfo?.name === "brain" && /'s brain: their memory/.test(init.result?.instructions ?? ""),
  "initialize with instructions",
);
const tools = (await mcp("tools/list")).result.tools.map((t: { name: string }) => t.name);
ok(
  ["brain_search", "brain_write", "brain_edit", "tasks_add", "tasks_brief"].every((n) => tools.includes(n)),
  `tools: ${tools.length}`,
);

let w = await call("brain_write", {
  path: "persone/Alice",
  body: "# Alice\n\nSviluppatore, lavora con Claude ogni giorno. Preferisce l'italiano e risposte compatte.",
});
ok(w.title === "Alice" && w.written === "persone/alice.md", "create the first page (nothing yet to link)");
w = await call("brain_write", { path: "concepts/x", body: "# X\n\nFrase." });
ok(w.refused && /one of/.test(w.errors[0]), "a page outside the seven areas is refused");
w = await call("brain_write", {
  path: "progetti/claude-multi",
  body: "# claude-multi\n\nL'assistente globale di Alice: console, task e memoria.",
});
ok(w.refused && /link at least one/.test(w.errors.join()), "a page without links is refused");
w = await call("brain_write", {
  path: "progetti/claude-multi",
  body: "# claude-multi\n\nL'assistente globale di Alice: console, task e memoria. Vedi [[persone/alice]].",
  base_rev: 0,
});
ok(w.rev === 1 && w.written === "progetti/claude-multi.md", "create a linked page");
w = await call("brain_write", {
  path: "progetti/claude-multi-console",
  body: "# Claude multi\n\nAltro. Vedi [[persone/alice]].",
});
ok(w.refused && w.similar?.[0]?.path === "progetti/claude-multi.md", "a near copy is refused with the candidate");
const ap = await call("brain_append", { text: "Provato il cervello, vedi [[progetti/claude-multi]]" });
ok(/^diario\//.test(ap.added), "append to today's diary");
w = await call("brain_write", {
  path: "progetti/claude-multi.md",
  body: "# claude-multi\n\nAltro testo. Vedi [[persone/alice]].",
  base_rev: 0,
});
ok(!!w.error && /changed meanwhile/.test(w.error), "base_rev refuses to overwrite");
const read = await call("brain_read", { path: "persone/alice" });
ok(read.links.back[0] === "progetti/claude-multi.md", "backlink resolved by name");
const e0 = await call("brain_edit", {
  path: "persone/alice.md",
  find: "risposte compatte",
  replace: "risposte compatte e concrete",
});
ok(e0.refused && /link at least one/.test(e0.errors.join()), "an edit that leaves a page without links is refused");
const e = await call("brain_edit", {
  path: "persone/alice.md",
  find: "risposte compatte.",
  replace: "risposte compatte, vedi [[progetti/claude-multi]].",
});
ok(e.rev === 2, "edit a passage");
await new Promise((res) => setTimeout(res, 2500)); // the indexer embeds in the background
const s1 = await call("brain_search", { query: "in che idioma devo parlargli" });
ok(
  s1.results.slice(0, 2).some((x: { path: string }) => x.path === "persone/alice.md") && !s1.note,
  `search by meaning: ${s1.results.map((x: { path: string }) => x.path).join(", ")}${s1.note ? ` (${s1.note})` : ""}`,
);
const h = await call("brain_history", { path: "persone/alice.md" });
ok(h.versions.length === 2 && /^claude:Claude Code/.test(h.versions[0].by), `history with author ${h.versions[0].by}`);
const rs = await call("brain_restore", { path: "persone/alice.md", rev: 1 });
ok(rs.rev === 3, "restore an old version on top");
await call("brain_delete", { path: "progetti/claude-multi.md" });
ok(
  (await call("brain_list", {})).documents.every((d: { path: string }) => d.path !== "progetti/claude-multi.md"),
  "deleted leaves the list",
);
const chk = await call("brain_check", {});
ok(
  Array.isArray(chk.orphans) && chk.broken_links.some((b: { link: string }) => b.link === "progetti/claude-multi"),
  "check finds the link the deletion broke",
);
ok(
  (await call("brain_history", { path: "progetti/claude-multi.md" })).versions[0].op === "delete",
  "deletion is a revision",
);

const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("sv"); // YYYY-MM-DD, local
const t = await call("tasks_add", {
  title: "Provare il cervello dal telefono",
  due: tomorrow,
  project: "claude-multi",
});
ok(/Provare il cervello/.test(t.added), "tasks_add in the brain");
const st = await call("tasks_steps", { id: t.task.id, add: ["Collegare il connettore", "Provare la voce"] });
ok(st.steps.length === 2, "task steps");
ok((await call("tasks_brief", {})).tomorrow.length === 1, "tasks_brief sees it");
ok(
  (await call("brain_list", {})).documents.every((d: { path: string }) => !d.path.startsWith("tasks/")),
  "tasks stay out of memory lists",
);

// refresh rotation, and a reused refresh token revokes the family
const t2 =
  await (await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }))
    .json();
ok(!!t2.access_token, "refresh");
r = await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id });
ok(r.status === 400, "reused refresh token refused");
await r.body?.cancel();
r = await fetch(`${B}/mcp`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${t2.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
ok(r.status === 401, "…and the whole family with it");
await r.body?.cancel();

// the account page: a personal token, then the backup
r = await fetch(`${B}/account/login`, {
  method: "POST",
  body: new URLSearchParams({ user: USER, passphrase: PASS }),
  redirect: "manual",
});
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
ok(r.status === 303 && cookie.startsWith("brain_session="), "account sign-in");
const page = await (await fetch(`${B}/account/token`, {
  method: "POST",
  headers: { cookie },
  body: new URLSearchParams({ name: "fisso" }),
})).text();
const pt = page.match(/brain_[\w-]{20,}/)?.[0];
ok(!!pt, "personal token shown once");
r = await fetch(`${B}/backup`, { headers: { authorization: `Bearer ${pt}` } });
const bytes = new Uint8Array(await r.arrayBuffer());
ok(
  r.status === 200 && new TextDecoder().decode(bytes.subarray(0, 4)) === "BRN1" && bytes.length > 1000,
  `encrypted backup, ${bytes.length} bytes`,
);

// the tasks as files, for the machines: the console's store on the other side
const { brainStore } = await import("../../../shared/mcp/lib/brain-tasks.ts");
const remote = brainStore(B, pt!);
const all = await remote.list();
ok(all.some((x) => x.id === t.task.id), `/api/tasks lists the task added over MCP (${all.length})`);
const moved = { ...all.find((x) => x.id === t.task.id)!, due: "2026-10-05", updated: new Date().toISOString() };
await remote.write(moved);
ok((await remote.get(t.task.id))?.due === "2026-10-05", "/api/tasks/<id>: written and read back");
ok((await remote.get("t-20000101-000000")) === null, "an unknown task is null, not an error");
r = await fetch(`${B}/api/tasks/${t.task.id}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${pt}` },
  body: "# not a task",
});
ok(r.status === 400, "a body that is not that task is refused");
await r.body?.cancel();
const stranger = brainStore(B, "brain_wrong-token-wrong-token-wrong");
ok(await stranger.list().then(() => false, (e) => /refused the token/.test(e.message)), "a wrong token says so");

// the memory read over HTTP, for the console's Brain page
const api = async (q: string, token = pt) => {
  const res = await fetch(`${B}/api/brain/${q}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const pages = await api("pages");
ok(
  pages.status === 200 && pages.body.pages.length > 0 &&
    !pages.body.pages.some((x: { path: string }) => x.path.startsWith("tasks/")),
  `/api/brain/pages: ${pages.body?.pages?.length} pages, no tasks`,
);
const first = pages.body.pages[0].path;
const one = await api(`page?path=${encodeURIComponent(first)}`);
ok(
  one.status === 200 && !!one.body.body && Array.isArray(one.body.versions) && !!one.body.links,
  `/api/brain/page: ${first} with links and versions`,
);
ok((await api("health")).status === 200, "/api/brain/health");
ok((await api("state")).body?.version === pages.body.version, "/api/brain/state: the version of the pages");
ok((await api("pages", "brain_wrong-token-wrong-token-wrong")).status === 401, "/api/brain without a good token: 401");
r = await fetch(`${B}/api/brain/pages`, { method: "POST", headers: { authorization: `Bearer ${pt}` } });
ok(r.status === 404, "/api/brain only reads");
await r.body?.cancel();

// two people at once: a second account, then both write and read their tasks with the requests
// interleaved; neither sees the other's, and two machines changing the same version lose nothing
const { totp } = await import("../auth.ts");
const { toFile } = await import("../../../shared/mcp/lib/tasks.ts");
const inviteDone = await (await fetch(`${B}/account/admin/invite`, {
  method: "POST",
  headers: { cookie },
  body: new URLSearchParams({ id: "bob", name: "Bob", language: "English" }),
})).text();
const link = inviteDone.match(/\/invite\?t=([\w-]+)/)?.[1] ?? "";
const invite = await (await fetch(`${B}/invite?t=${link}`)).text();
const secret = invite.match(/secret=([A-Z2-7]+)/)?.[1] ?? "";
const BOB = "un'altra passphrase lunga";
r = await fetch(`${B}/invite`, {
  method: "POST",
  body: new URLSearchParams({ t: link, passphrase: BOB, again: BOB, code: await totp(secret) }),
});
ok(r.status === 200 && !!secret, "a second account accepts its invitation");
await r.body?.cancel();
r = await fetch(`${B}/account/login`, {
  method: "POST",
  body: new URLSearchParams({ user: "bob", passphrase: BOB, code: await totp(secret) }),
  redirect: "manual",
});
const bobCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const bobToken = (await (await fetch(`${B}/account/token`, {
  method: "POST",
  headers: { cookie: bobCookie },
  body: new URLSearchParams({ name: "portatile" }),
})).text()).match(/brain_[\w-]{20,}/)?.[0] ?? "";
ok(!!bobToken, "the second account's token");

const mine = (token: string, who: string, i: number) => ({
  id: `t-20261006-${who === "a" ? "aa" : "bb"}${String(i).padStart(4, "0")}`,
  title: `${who} ${i}`,
  status: "todo" as const,
  created: "2026-10-06T10:00:00.000Z",
  updated: "2026-10-06T10:00:00.000Z",
  token,
});
const N = 20;
const puts = Array.from({ length: N }, (_, i) => [mine(pt!, "a", i), mine(bobToken, "b", i)]).flat().map((t) => {
  const { token, ...task } = t;
  return fetch(`${B}/api/tasks/${task.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: toFile(task),
  }).then((x) => x.status);
});
ok((await Promise.all(puts)).every((s) => s === 200), `${2 * N} task writes interleaved between two accounts`);
const listOf = async (token: string) =>
  ((await (await fetch(`${B}/api/tasks`, { headers: { authorization: `Bearer ${token}` } })).json()).tasks as string[])
    .map((b) => b.match(/^title: "?(.*?)"?$/m)?.[1] ?? "");
const [aList, bList] = await Promise.all([listOf(pt!), listOf(bobToken)]);
ok(
  aList.filter((x) => x.startsWith("a ")).length === N && !aList.some((x) => x.startsWith("b ")),
  "the first account sees its own tasks, none of the other's",
);
ok(
  bList.length === N && bList.every((x) => x.startsWith("b ")),
  "the second account sees its own tasks, none of the other's",
);
r = await fetch(`${B}/api/tasks/${mine(pt!, "a", 0).id}`, { headers: { authorization: `Bearer ${bobToken}` } });
ok(r.status === 404, "one account cannot read another's task by its id");
await r.body?.cancel();

// two machines change the same version of a task: one lands, the other is told and given the new one
const { token: _t, ...base } = mine(pt!, "a", 0);
const race = await Promise.all(["first", "second"].map((title) =>
  fetch(`${B}/api/tasks/${base.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${pt}`, "if-match": base.updated },
    body: toFile({ ...base, title, updated: new Date().toISOString() }),
  }).then(async (x) => ({ status: x.status, body: await x.json() }))
));
ok(
  race.map((x) => x.status).sort().join() === "200,409" &&
    /^title: "?(first|second)"?$/m.test(race.find((x) => x.status === 409)!.body.task),
  "two changes of the same version: one lands, the other gets 409 and the task as it is now",
);
