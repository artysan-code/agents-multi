// Tests for the desktop app's updates as the console relays them (console/app-update.ts): the app's
// status lines are checked, the link follows them and forgets them when the app goes, the actions are
// passed on, and the route answers the page with the status and the app's verdict.
import { assertEquals } from "jsr:@std/assert@1";
import {
  AppLink,
  appRequest,
  appSocket,
  appUpdateRoute,
  backoff,
  type Conn,
  NO_APP,
  NOT_RUNNING,
  parseStatus,
} from "../console/app-update.ts";
import { createHandler } from "../console/server.ts";

/** A fake app on the other end of a connection: what the console wrote, and lines to answer with. */
function fakeApp(answer: (request: string) => string[]) {
  const written: string[] = [];
  let push: ((line: string) => void) | null = null;
  let end: (() => void) | null = null;
  const dial = (): Promise<Conn> => {
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        push = (line) => c.enqueue(new TextEncoder().encode(`${line}\n`));
        end = () => {
          try {
            c.close();
          } catch { /* already closed */ }
        };
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const request = new TextDecoder().decode(chunk).trim();
        written.push(request);
        for (const l of answer(request)) push!(l);
        if (!request.includes('"watch"')) end!();
      },
    });
    return Promise.resolve({ readable, writable, close: () => end?.() });
  };
  return { dial, written, push: (l: string) => push!(l), end: () => end!() };
}

const STATUS = JSON.stringify({
  current: "1.0.0",
  channel: "stable",
  state: "idle",
  available: null,
});

Deno.test("app update: the socket is the app's word, else the runtime folder's", () => {
  assertEquals(
    appSocket({
      AGENTS_MULTI_APP_SOCKET: "/run/x.sock",
      XDG_RUNTIME_DIR: "/run/u",
    }),
    "/run/x.sock",
  );
  assertEquals(
    appSocket({ XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/run/user/1000/agents-multi-app.sock",
  );
  // without a runtime folder: the private state folder, never /tmp
  assertEquals(appSocket({ HOME: "/home/u" }), "/home/u/.local/state/agents-multi/agents-multi-app.sock");
  assertEquals(
    appSocket({ HOME: "/home/u", XDG_STATE_HOME: "/s", XDG_RUNTIME_DIR: "" }),
    "/s/agents-multi/agents-multi-app.sock",
  );
});

Deno.test("app update: a status line is checked field by field", () => {
  assertEquals(parseStatus(STATUS), {
    app: true,
    current: "1.0.0",
    channel: "stable",
    state: "idle",
    available: null,
  });
  const full = parseStatus(JSON.stringify({
    current: "1.0.0",
    channel: "beta",
    state: "downloading",
    available: {
      version: "1.1.0-beta.1",
      notes: "### Added",
      date: "2026-10-07 10:00:00.0 +00:00:00",
    },
    progress: 1.7,
    error: "x",
    off: "package-manager:pacman",
    updated: { from: "0.9.0", to: "1.0.0" },
    checkedAt: 42,
    extra: "ignored",
  }));
  assertEquals(full, {
    app: true,
    current: "1.0.0",
    channel: "beta",
    state: "downloading",
    available: {
      version: "1.1.0-beta.1",
      notes: "### Added",
      date: "2026-10-07 10:00:00.0 +00:00:00",
    },
    progress: 1,
    error: "x",
    off: "package-manager:pacman",
    updated: { from: "0.9.0", to: "1.0.0" },
    checkedAt: 42,
  });
  assertEquals(parseStatus("not json"), null);
  assertEquals(
    parseStatus(JSON.stringify({ current: "1.0.0", state: "exploded" })),
    null,
  );
  assertEquals(parseStatus(JSON.stringify({ state: "idle" })), null);
  assertEquals(parseStatus("null"), null);
});

Deno.test("app update: following the app again waits 2 s doubling to 30 s", () => {
  assertEquals([0, 1, 2, 3, 4, 9].map(backoff), [
    2000,
    4000,
    8000,
    16000,
    30000,
    30000,
  ]);
});

Deno.test("app update: the link follows the app's status and forgets it when the app goes", async () => {
  const app = fakeApp((r) => r.includes('"watch"') ? [STATUS] : []);
  let changes = 0;
  const link = new AppLink(app.dial, () => changes++);
  assertEquals(link.view(), NO_APP);
  const ac = new AbortController();
  const following = link.follow(ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(app.written, ['{"op":"watch"}']);
  assertEquals([link.view().app, link.view().state, changes], [
    true,
    "idle",
    1,
  ]);
  app.push(
    JSON.stringify({
      current: "1.0.0",
      channel: "stable",
      state: "checking",
      available: null,
    }),
  );
  app.push("garbage"); // ignored
  await new Promise((r) => setTimeout(r, 10));
  assertEquals([link.view().state, changes], ["checking", 2]);
  app.end(); // the app quit or relaunches
  await new Promise((r) => setTimeout(r, 10));
  assertEquals([link.view(), changes], [NO_APP, 3]);
  ac.abort();
  await following;
});

Deno.test("app update: an action is passed on and the app's answer comes back", async () => {
  const app = fakeApp((r) =>
    r.includes("install") ? ['{"ok":false,"error":"updates are off: not-packaged"}'] : ['{"ok":true}']
  );
  const link = new AppLink(app.dial, () => {});
  assertEquals(await link.send({ op: "check" }), { ok: true });
  assertEquals(await link.send({ op: "install" }), {
    ok: false,
    error: "updates are off: not-packaged",
  });
  assertEquals(await link.send({ op: "channel", channel: "beta" }), {
    ok: true,
  });
  assertEquals(app.written, [
    '{"op":"check"}',
    '{"op":"install"}',
    '{"op":"channel","channel":"beta"}',
  ]);
  const none = new AppLink(() => Promise.reject(new Error("ENOENT")), () => {});
  assertEquals(await none.send({ op: "check" }), {
    ok: false,
    error: NOT_RUNNING,
  });
});

Deno.test("app update: the route gives the status and passes the page's actions on, behind the header", async () => {
  const sent: string[] = [];
  const answers: Record<string, { ok: boolean; error?: string }> = {
    check: { ok: true },
    install: { ok: false, error: "updates are off: build" },
    dismiss: { ok: false, error: NOT_RUNNING },
  };
  const handle = createHandler({
    "/api/app/update": appUpdateRoute({
      view: () => NO_APP,
      send: (r) => {
        sent.push(r.op === "channel" ? `channel:${r.channel}` : r.op);
        return Promise.resolve(answers[r.op] ?? { ok: true });
      },
    }),
  });
  const req = (init: RequestInit = {}) =>
    handle(
      new Request("http://127.0.0.1:7331/api/app/update", {
        ...init,
        headers: { host: "127.0.0.1:7331", ...init.headers },
      }),
    );
  const post = (body: unknown, csrf = true) =>
    req({
      method: "POST",
      body: JSON.stringify(body),
      headers: csrf ? { "x-claude-multi": "1" } : {},
    });

  assertEquals(await (await req()).json(), NO_APP);
  assertEquals((await post({ action: "check" }, false)).status, 403);
  assertEquals(sent, []);
  assertEquals((await post({ action: "rm" })).status, 400);
  const ok = await post({ action: "check" });
  assertEquals([ok.status, await ok.json()], [200, { ok: true }]);
  assertEquals((await post({ action: "install" })).status, 409);
  assertEquals((await post({ action: "dismiss" })).status, 503);
  assertEquals(
    (await post({ action: "channel", channel: "nightly" })).status,
    400,
  );
  assertEquals(
    (await post({ action: "channel", channel: "beta" })).status,
    200,
  );
  assertEquals(sent, ["check", "install", "dismiss", "channel:beta"]);
});

Deno.test("app update: a page's body becomes a request only with a known action and channel", () => {
  assertEquals(appRequest({ action: "check" }), { op: "check" });
  assertEquals(appRequest({ action: "channel", channel: "stable" }), {
    op: "channel",
    channel: "stable",
  });
  assertEquals(appRequest({ action: "channel" }), null);
  assertEquals(appRequest({ action: "channel", channel: "../x" }), null);
  assertEquals(appRequest({ action: "watch" }), null);
  assertEquals(appRequest({}), null);
});
