// web-fixture.ts — a small stand-in for the service, to look at the web app (src/web/) with realistic data and no
// service: it serves dist-web under /app and fakes the API of ADR 0014 in memory, including a chat answer that
// streams over Server-Sent Events. Not a test and not part of the product.
//
//   pnpm exec vite build --config vite.web.config.ts
//   deno run --allow-net --allow-read apps/ui/scripts/web-fixture.ts [--port 8799]
//
// Send "fail" in a chat to see a failed turn, "hang" to see one nobody picks up. The state of the passkeys is
// changed with /__set?passkeys=none|pending|ready (default ready); /__set?empty=1 empties every list.

import { toFile } from "../../../shared/mcp/lib/tasks/format.ts";
import type { Task } from "../../../shared/mcp/lib/tasks/types.ts";

const port = Number(Deno.args[Deno.args.indexOf("--port") + 1]) || 8799;
const root = new URL("../dist-web/", import.meta.url);
const mode = { passkeys: "ready", empty: false, slow: 0 };

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Turn {
  id: string;
  q: string;
  a: string;
  acts: { k: string; n: string; d?: string }[];
  state: string;
  node: string | null;
  error: string | null;
  created: string;
  ended: string | null;
}
const chats = new Map<string, { id: string; title: string; updated: string; node: string | null; turns: Turn[] }>();
const seed = (id: string, title: string, min: number, node: string, q: string, a: string, acts: Turn["acts"] = []) =>
  chats.set(id, {
    id,
    title,
    updated: ago(min),
    node,
    turns: [{ id: `${id}-1`, q, a, acts, state: "done", node, error: null, created: ago(min + 1), ended: ago(min) }],
  });
seed("c1", "Plan for today", 12, "studio", "What is on my plate today?",
  "You have **three things** today:\n\n1. Call the accountant at 10:30\n2. Review the G7 branch before lunch\n3. Send the invoice for September\n\nThe call is the only one with a fixed time. I moved the invoice to the afternoon so it does not collide with the review.",
  [{ k: "tasks", n: "tasks_update", d: "Send the invoice → 15:00" }]);
seed("c2", "Release notes wording", 190, "studio", "Rewrite the changelog for 1.2.1",
  "Here is a tighter version:\n\n## 1.2.1\n\n- The phone has a web app at `/app`\n- Pair a machine with an eight-character code\n- Say yes from the phone with a passkey\n\n```ts\nconst ship = (kind: \"beta\" | \"stable\") => run(`deno task ship ${kind}`);\n```\n\nKeep the second line first: it is what people will try.",
  [{ k: "brain", n: "brain_append", d: "Diary: changelog reworded" }]);
seed("c3", "Cloudflare worker idea", 60 * 26, "hetzner", "Sketch a worker that mirrors the feed", "A small worker with a cron trigger and a KV namespace is enough. I would keep it under 80 lines.");
seed("c4", "Italian invoice template", 60 * 24 * 4, "studio", "Make a template for fatture", "Done: the page is in the brain under `note/fatture`.", [{ k: "brain", n: "brain_write", d: "note/fatture" }]);

const ANSWER = [
  "Sure. Here is what I found and did.\n\n",
  "**Tomorrow** looks light: one call at 10:00 and the release review. I added a reminder so you do not forget the call.\n\n",
  "- 10:00 call the accountant\n- 15:00 release review (G7)\n\n",
  "If you want the same check every morning, this is the routine I would propose:\n\n```bash\nagents routine add --at 08:30 --weekdays \"brief\"\n```\n\n",
  "It needs your yes before it runs, so nothing starts by itself.",
];

const streams = new Map<string, Set<(name: string, data: unknown) => void>>();
const emit = (chat: string, name: string, data: unknown) => streams.get(chat)?.forEach((f) => f(name, data));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function answer(chatId: string, turn: Turn, text: string) {
  if (text.includes("hang")) return;
  await wait(900);
  turn.state = "running";
  turn.node = "studio";
  emit(chatId, "turn", { turn: turn.id, state: "running", node: "studio" });
  await wait(700);
  if (text.includes("fail")) {
    turn.state = "failed";
    turn.error = "The machine lost its connection to Claude.";
    emit(chatId, "turn", { turn: turn.id, state: "failed", node: "studio", error: turn.error });
    return;
  }
  for (const piece of ANSWER) {
    for (const part of piece.match(/.{1,6}/gs) ?? []) {
      turn.a += part;
      emit(chatId, "text", { turn: turn.id, d: part });
      await wait(35);
    }
    if (piece.includes("reminder")) {
      const act = { k: "tasks", n: "tasks_add", d: "Call the accountant, tomorrow 10:00" };
      turn.acts.push(act);
      emit(chatId, "act", { turn: turn.id, ...act });
    }
  }
  turn.state = "done";
  turn.ended = new Date().toISOString();
  const chat = chats.get(chatId)!;
  chat.updated = turn.ended;
  emit(chatId, "done", { turn: turn.id, a: turn.a });
}

const task = (id: string, over: Partial<Task>): Task => ({
  id,
  title: id,
  status: "todo",
  created: ago(5000),
  updated: ago(100),
  ...over,
});
const tasks = (): string[] =>
  mode.empty ? [] : [
    task("t-1", { title: "Call the accountant", due: day(0), time: "10:30", project: "work/otacon" }),
    task("t-2", { title: "Review the G7 branch", due: day(0), time: "11:30", ref: "TASK-495", project: "personal/opensource/agents-multi", status: "doing" }),
    task("t-3", { title: "Send the invoice for September", due: day(0), time: "15:00" }),
    task("t-4", { title: "Buy a new charger cable", due: day(0), status: "waiting" }),
    task("t-5", { title: "Renew the domain", due: day(-3), priority: 1 }),
    task("t-6", { title: "Reply to the lawyer", due: day(-1), time: "09:00" }),
    task("t-7", { title: "Backup the photos", due: day(0), status: "done", done: ago(90) }),
  ].map(toFile);

const pages = [
  { path: "progetti/personal/opensource/agents-multi", title: "Agents Multi", area: "progetti", updated: ago(40) },
  { path: "io/lavoro", title: "How I work", area: "io", updated: ago(60 * 5) },
  { path: "clienti/otacon", title: "Otacon", area: "clienti", updated: ago(60 * 30) },
  { path: "note/fatture", title: "Invoice template", area: "note", updated: ago(60 * 24 * 4) },
  { path: "diario/2026-10", title: "Diary, October", area: "diario", updated: ago(60 * 2) },
];

const nodes = () => mode.empty ? [] : [
  { name: "studio", platform: "linux", version: "1.2.1-rc.2", headless: false, load: 0.42, memTotal: 32e9, memFree: 19e9, cap: 4, running: 1, accounts: ["personal/claude", "work/claude"], present: true, sandbox: null, seen: ago(0.2) },
  { name: "hetzner", platform: "linux", version: "1.2.1-rc.2", headless: true, load: 0.08, memTotal: 8e9, memFree: 5.5e9, cap: 2, running: 0, accounts: ["personal/claude"], present: false, sandbox: true, seen: ago(0.4) },
  { name: "macbook", platform: "darwin", version: "1.2.0", headless: false, load: 1.9, memTotal: 16e9, memFree: 2e9, cap: 3, running: 0, accounts: ["personal/claude"], present: false, sandbox: null, seen: ago(60 * 26) },
];

const keys = () =>
  mode.passkeys === "none" ? [] : [{ id: "AbCd1234", name: "iPhone", publicKey: "pk", endorsement: mode.passkeys === "ready" ? "sig" : null, created: ago(60 * 24 * 2) }];

const waitingNow = () =>
  mode.empty ? { requests: [], jobs: [] } : {
    requests: [
      { id: "ch-1/rq-1", child: "ch-1", request: "rq-1", profile: "work", project: "work/otacon/smc", kind: "request", what: "Bash: git push origin wf/smc-fix", node: "studio" },
      {
        id: "ch-2/rq-2", child: "ch-2", request: "rq-2", profile: "personal", project: "personal/dnd/dragons-lair", kind: "question", what: "Which database should the new map service use?", node: "hetzner",
        questions: [{ question: "Which database?", header: "Storage", options: [{ label: "SQLite", description: "One file, nothing to run" }, { label: "Postgres", description: "A server of its own" }] }],
      },
    ],
    jobs: [{
      id: "j-1", node: "hetzner", kind: "routine", status: "proposed", by: "studio", created: ago(25), reason: "The nightly backup missed twice. Run it now on the server?",
      spec: { name: "Nightly backup", repo: "git@example:me/backup.git", path: "", action: { kind: "child" }, account: "personal/claude" },
    }],
  };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const types: Record<string, string> = {
  html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png",
  woff2: "font/woff2", webmanifest: "application/manifest+json", json: "application/json",
};

async function handle(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const p = u.pathname;
  if (mode.slow) await wait(mode.slow);
  if (p === "/__set") {
    for (const [k, v] of u.searchParams) {
      if (k === "passkeys") mode.passkeys = v;
      if (k === "empty") mode.empty = v === "1";
      if (k === "slow") mode.slow = Number(v);
    }
    return json(mode);
  }
  if (p === "/") return Response.redirect(new URL("/app/", u), 302);
  if (p === "/manifest.webmanifest" || p.startsWith("/icons/")) return Response.redirect(new URL(`/app${p}`, u), 302);
  if (p === "/account" || p === "/account/logout") return new Response("account page (fixture)", { headers: { "content-type": "text/plain" } });

  // ---- chats
  if (p === "/api/chats" && req.method === "GET") {
    const list = mode.empty ? [] : [...chats.values()].sort((a, b) => b.updated.localeCompare(a.updated));
    return json({ chats: list.map(({ id, title, updated, node }) => ({ id, title, updated, node })) });
  }
  if (p === "/api/chats" && req.method === "POST") {
    const b = await req.json() as { text: string; chat?: string; node?: string };
    let chat = b.chat ? chats.get(b.chat) : undefined;
    if (!chat) {
      const id = `c${chats.size + 1}`;
      chat = { id, title: b.text.slice(0, 40), updated: new Date().toISOString(), node: null, turns: [] };
      chats.set(id, chat);
    }
    const turn: Turn = { id: `${chat.id}-${chat.turns.length + 1}`, q: b.text, a: "", acts: [], state: "waiting", node: null, error: null, created: new Date().toISOString(), ended: null };
    chat.turns.push(turn);
    chat.updated = turn.created;
    emit(chat.id, "turn", { turn: turn.id, state: "waiting" });
    void answer(chat.id, turn, b.text);
    return json({ chat: { id: chat.id, title: chat.title, updated: chat.updated, node: chat.node }, turn });
  }
  const one = p.match(/^\/api\/chats\/([\w-]+)$/);
  if (one && req.method === "GET") {
    const c = chats.get(one[1]);
    return c ? json({ chat: { id: c.id, title: c.title, turns: c.turns } }) : json({ error: "no such chat" }, 404);
  }
  if (one && req.method === "DELETE") return chats.delete(one[1]) ? json({ ok: true }) : json({ error: "no such chat" }, 404);
  const ev = p.match(/^\/api\/chats\/([\w-]+)\/events$/);
  if (ev) {
    const enc = new TextEncoder();
    let send: (n: string, d: unknown) => void;
    const body = new ReadableStream({
      start(ctl) {
        send = (n, d) => ctl.enqueue(enc.encode(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`));
        (streams.get(ev[1]) ?? streams.set(ev[1], new Set()).get(ev[1])!).add(send);
        ctl.enqueue(enc.encode(": open\n\n"));
      },
      cancel() {
        streams.get(ev[1])?.delete(send);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  // ---- tasks, brain, machines
  if (p === "/api/tasks") return json({ tasks: tasks() });
  if (p.startsWith("/tasks/") && p.endsWith("/status")) return new Response(null, { status: 303, headers: { location: "/board" } });
  if (p === "/api/brain/pages") return json({ pages: mode.empty ? [] : pages, areas: {}, edges: [] });
  if (p === "/api/brain/search") {
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    return json({ results: pages.filter((x) => x.title.toLowerCase().includes(q) || q.length > 3).slice(0, 4).map((x) => ({ path: x.path, title: x.title, excerpt: "…the decision was to keep the service small and let each person's machine do the work…" })) });
  }
  if (p === "/api/brain/page") {
    const path = u.searchParams.get("path") ?? "";
    const pg = pages.find((x) => x.path === path) ?? pages[0];
    return json({
      ...pg,
      body: "# Agents Multi\n\nA multi-profile setup for Claude Code: several accounts on one machine, a console, and a desktop app.\n\n## Now\n\n- The phone has a web app ([[note/fatture]])\n- Passkeys say yes from the phone\n\n## Decisions\n\n> The service never runs agents. It relays.\n\nMore in `docs/adr/0014`.\n",
    });
  }
  if (p === "/api/nodes") return json({ nodes: nodes(), jobs: [], now: new Date().toISOString() });
  if (p === "/api/settings/orchestrator") return json({ node: "studio", order: ["studio", "hetzner"] });

  // ---- pairing, waiting, passkeys, push
  if (p === "/api/pair/claim") {
    const b = await req.json() as { code: string };
    return b.code === "ABCD1234" ? json({ node: "new-laptop" }) : json({ error: "That code is unknown or has expired." }, 404);
  }
  if (p === "/api/waiting" && req.method === "GET") return json(waitingNow());
  if (p.startsWith("/api/waiting/") || p.startsWith("/api/jobs/")) return json({ ok: true });
  if (p === "/api/passkeys" && req.method === "GET") return json(keys());
  if (p === "/api/passkeys/options") return json({ challenge: "AAAA", rp: { name: "Agents Multi" }, user: { id: "AAAA", name: "me" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] });
  if (p === "/api/passkeys" && req.method === "POST") {
    mode.passkeys = "pending";
    return json({ id: "AbCd1234", state: "pending" });
  }
  if (p.startsWith("/api/passkeys/")) return json({ ok: true });
  if (p === "/api/push/key") return json({ key: "BAAA" });
  if (p.startsWith("/api/push/")) return json({ ok: true });

  // ---- the built app
  if (p.startsWith("/app")) {
    let rel = decodeURIComponent(p.slice(4)).replace(/^\/+/, "");
    if (!rel || !/\.\w+$/.test(rel)) rel = "index.html";
    try {
      const bytes = await Deno.readFile(new URL(rel, root));
      return new Response(bytes, { headers: { "content-type": types[rel.split(".").pop()!] ?? "application/octet-stream", "cache-control": "no-store" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  return json({ error: "not found" }, 404);
}

Deno.serve({ port, hostname: "127.0.0.1" }, handle);
console.log(`fixture on http://127.0.0.1:${port}/app/`);
