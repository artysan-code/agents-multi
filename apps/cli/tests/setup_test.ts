// Tests for the first-run wizard's server side (setup.ts, console/setup.ts): the step derived from
// the filesystem, the checks on what the page sends, each step's writes in a throwaway home, and the
// routes refusing every write once a machine is configured.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkBrainUrl,
  checkFolder,
  checkProfiles,
  nextStep,
  passStep,
  type ProfileWrite,
  readRecord,
  setFolder,
  setOwner,
  setProfiles,
  setupActive,
  type SetupFacts,
  setupFacts,
  setupOpen,
  type SetupPaths,
  type SetupRecord,
  type SetupStep,
  setupView,
  updateRecord,
  watchFor,
} from "../setup.ts";
import { init } from "../init.ts";
import { createHandler } from "../console/server.ts";
import { setupRoutes } from "../console/setup.ts";

const facts = (f: Partial<SetupFacts> = {}): SetupFacts => ({
  configured: false,
  owner: null,
  folder: null,
  profiles: [],
  installed: false,
  claudeCode: true,
  vault: "none",
  brain: { url: null, connected: false },
  record: null,
  ...f,
});
const rec = (passed: SetupStep[] = [], more = {}): SetupRecord => ({
  started: "2026-10-07T00:00:00Z",
  passed,
  later: [],
  ...more,
});
const me = { id: "ann", name: "Ann", language: "Italian" };
const prof = (signedIn = false) => ({ profile: "personal", command: "claude", installed: true, signedIn });

Deno.test("nextStep: from nothing to done, each step by what it leaves behind", () => {
  assertEquals(nextStep(facts()), "welcome");
  assertEquals(nextStep(facts({ record: rec() })), "welcome");
  assertEquals(nextStep(facts({ record: rec(["welcome"]) })), "you");
  assertEquals(
    nextStep(facts({ record: rec(["welcome"], { owner: { name: "Ann", language: "Italian" } }) })),
    "folder",
  );
  const configured = { configured: true, owner: me };
  // init made the example's profile: it is confirmed (or changed) before install
  assertEquals(
    nextStep(facts({ ...configured, record: rec(["welcome"]), profiles: [{ ...prof(), installed: false }] })),
    "profiles",
  );
  assertEquals(
    nextStep(
      facts({ ...configured, record: rec(["welcome", "profiles"]), profiles: [{ ...prof(), installed: false }] }),
    ),
    "install",
  );
  const inst = { ...configured, installed: true, profiles: [prof()] };
  assertEquals(nextStep(facts({ ...inst, record: rec(["welcome", "profiles"]) })), "vault");
  // no Claude Code yet: its step, until it is there or put off
  assertEquals(nextStep(facts({ ...inst, claudeCode: false, record: rec(["welcome", "profiles"]) })), "claude");
  assertEquals(
    nextStep(facts({ ...inst, claudeCode: false, record: rec(["welcome", "profiles", "claude"]) })),
    "vault",
  );
  // the vault step passes only by a confirmation (code saved, paired, later), even with a vault there
  assertEquals(nextStep(facts({ ...inst, vault: "ok", record: rec(["welcome", "profiles"]) })), "vault");
  assertEquals(nextStep(facts({ ...inst, record: rec(["welcome", "profiles", "vault"]) })), "logins");
  assertEquals(
    nextStep(facts({ ...inst, profiles: [prof(true)], record: rec(["welcome", "profiles", "vault"]) })),
    "brain",
  );
  assertEquals(nextStep(facts({ ...inst, record: rec(["welcome", "profiles", "vault", "logins"]) })), "brain");
  assertEquals(
    nextStep(
      facts({ ...inst, brain: { url: "https://b", connected: true }, record: rec(["welcome", "vault", "logins"]) }),
    ),
    "done",
  );
  assertEquals(nextStep(facts({ ...inst, record: rec(["welcome", "vault", "logins", "brain"]) })), "done");
});

Deno.test("nextStep: an installed machine never goes back to profiles or install", () => {
  const f = facts({ configured: true, owner: me, installed: true, profiles: [prof()], record: rec(["welcome"]) });
  assertEquals(nextStep(f), "vault");
  // a profile added since, not installed yet: install again
  const added = { ...f, installed: false, profiles: [prof(), { ...prof(), profile: "work", installed: false }] };
  assertEquals(nextStep({ ...added, record: rec(["welcome", "profiles"]) }), "install");
});

Deno.test("setupActive: no configuration, or a setup started and not finished", () => {
  assertEquals(setupActive({ configured: false, record: null }), true);
  assertEquals(setupActive({ configured: true, record: null }), false); // configured by hand: never
  assertEquals(setupActive({ configured: true, record: rec() }), true);
  assertEquals(setupActive({ configured: true, record: rec([], { finished: "x" }) }), false);
  assertEquals(setupActive({ configured: false, record: rec([], { finished: "x" }) }), true);
});

Deno.test("checkProfiles: names and commands of a fixed shape, unique, none of our own commands", () => {
  const reserved = ["agents", "claude-launch", "claude"];
  assertEquals(checkProfiles([{ name: "personal", command: "claude" }], reserved), {
    ok: true,
    profiles: [{ name: "personal", command: "claude" }],
  });
  // no command: claude-<name>
  assertEquals(checkProfiles([{ name: "work" }], reserved), {
    ok: true,
    profiles: [{ name: "work", command: "claude-work" }],
  });
  assertEquals(checkProfiles([], reserved).ok, false);
  assertEquals(checkProfiles([{ name: "Work" }], reserved).ok, false);
  assertEquals(checkProfiles([{ name: "../x" }], reserved).ok, false);
  assertEquals(checkProfiles([{ name: "work", command: "agents" }], reserved).ok, false);
  assertEquals(checkProfiles([{ name: "work", command: "claude-launch" }], reserved).ok, false);
  assertEquals(checkProfiles([{ name: "work", command: "rm -rf" }], reserved).ok, false);
  assertEquals(
    checkProfiles([{ name: "a1", command: "claude" }, { name: "b1", command: "claude" }], reserved).ok,
    false,
  );
  assertEquals(checkProfiles([{ name: "a1" }, { name: "a1" }], reserved).ok, false);
});

Deno.test("checkFolder: inside the home folder, ~ expanded, no dots", () => {
  assertEquals(checkFolder("~/agents-multi-config", "/h"), { ok: true, dir: "/h/agents-multi-config" });
  assertEquals(checkFolder("/h/Sync/cfg/", "/h"), { ok: true, dir: "/h/Sync/cfg" });
  assertEquals(checkFolder("~", "/h").ok, false);
  assertEquals(checkFolder("/etc/cfg", "/h").ok, false);
  assertEquals(checkFolder("/hx/cfg", "/h").ok, false);
  assertEquals(checkFolder("~/../etc", "/h").ok, false);
  assertEquals(checkFolder("cfg", "/h").ok, false);
  assertEquals(checkFolder("", "/h").ok, false);
});

Deno.test("checkBrainUrl: the origin, https or this machine", () => {
  assertEquals(checkBrainUrl("https://brain.example.org/account"), { ok: true, url: "https://brain.example.org" });
  assertEquals(checkBrainUrl("http://127.0.0.1:8789"), { ok: true, url: "http://127.0.0.1:8789" });
  assertEquals(checkBrainUrl("http://brain.example.org").ok, false);
  assertEquals(checkBrainUrl("brain.example.org").ok, false);
});

/** A throwaway home with the places the setup reads and writes. */
async function home(): Promise<SetupPaths> {
  const h = await Deno.makeTempDir();
  return {
    home: h,
    config: `${h}/.agents-multi/config`,
    runtime: `${h}/.agents-multi`,
    bin: `${h}/.local/bin`,
    state: `${h}/state`,
  };
}
const io = { vault: () => Promise.resolve("ok" as const), hasSecret: () => Promise.resolve(true) };

Deno.test("setup steps in a throwaway home: owner, folder (init), profiles, passes, facts", async () => {
  const p = await home();
  assertEquals((await setupFacts(p, io)).configured, false);
  assertEquals(await setupOpen(p), true);
  assertEquals(await passStep({ step: "welcome" }, p), { ok: true });
  assertEquals(await passStep({ step: "install" }, p), { ok: false, message: "not a step to pass: install" });
  assertEquals((await setOwner({ name: "Ann Lee", language: "Italian" }, p)).ok, true);
  assertEquals((await setOwner({ name: " ", language: "Italian" }, p)).ok, false);
  assertEquals(nextStep(await setupFacts(p, io)), "folder");

  // the folder: outside home refused; a folder with other files refused; a new one made by init
  assertEquals((await setFolder({ folder: "/etc/x" }, init, p)).ok, false);
  await Deno.mkdir(`${p.home}/busy`);
  await Deno.writeTextFile(`${p.home}/busy/notes.txt`, "x");
  assertEquals((await setFolder({ folder: "~/busy" }, init, p)).ok, false);
  assertEquals(await setFolder({ folder: "~/cfg" }, init, p), { ok: true, existing: false });
  assertEquals((await readRecord(p))?.created, true);
  // the same answer again (Back, then Continue): only linked, and still the wizard's own
  assertEquals(await setFolder({ folder: "~/cfg" }, init, p), { ok: true, existing: true });
  assertEquals((await readRecord(p))?.created, true);
  assertEquals(JSON.parse(await Deno.readTextFile(`${p.home}/cfg/owner.json`)), {
    id: "annlee",
    name: "Ann Lee",
    language: "Italian",
  });
  assertEquals(await Deno.readLink(p.config), `${p.home}/cfg`);
  // asked again with another folder: the earlier link is replaced, the configuration there only linked
  await Deno.mkdir(`${p.home}/other`);
  await Deno.writeTextFile(`${p.home}/other/owner.json`, JSON.stringify({ id: "x", name: "X", language: "English" }));
  assertEquals(await setFolder({ folder: "~/other" }, init, p), { ok: true, existing: true });
  assertEquals(await Deno.readLink(p.config), `${p.home}/other`);
  assertEquals(await setFolder({ folder: "~/cfg" }, init, p), { ok: true, existing: true });

  // a configuration linked from another machine: none of its profiles is removed from here
  assertEquals((await readRecord(p))?.created, false);
  await Deno.mkdir(`${p.home}/cfg/profiles/old`, { recursive: true });
  await Deno.writeTextFile(`${p.home}/cfg/profiles/old/profile.json`, "{}");
  assertEquals(
    (await setProfiles({ profiles: [{ name: "personal", command: "claude" }] }, () => Promise.resolve({}), p)).ok,
    false,
  );
  assert(await Deno.stat(`${p.home}/cfg/profiles/old/profile.json`));
  await Deno.remove(`${p.home}/cfg/profiles/old`, { recursive: true });
  await updateRecord((x) => x.created = true, p);

  // the owner, changed after init: into owner.json, the id kept
  await setOwner({ name: "Ann", language: "English" }, p);
  assertEquals(JSON.parse(await Deno.readTextFile(`${p.home}/cfg/owner.json`)).id, "annlee");
  assertEquals(JSON.parse(await Deno.readTextFile(`${p.home}/cfg/owner.json`)).name, "Ann");

  let f = await setupFacts(p, io);
  assertEquals([f.configured, f.folder, f.profiles.map((x) => x.profile)], [true, `${p.home}/cfg`, ["personal"]]);
  assertEquals(nextStep(f), "profiles");

  // profiles: the example's personal left out (never installed: removed), two new ones written
  const written: string[] = [];
  const write = async (x: ProfileWrite) => {
    written.push(`${x.name}:${x.command}`);
    await Deno.mkdir(`${p.config}/profiles/${x.name}`, { recursive: true });
    await Deno.writeTextFile(`${p.config}/profiles/${x.name}/profile.json`, JSON.stringify(x));
    return {};
  };
  const r = await setProfiles({ profiles: [{ name: "home", command: "claude" }, { name: "work" }] }, write, p, [
    "agents",
  ]);
  assertEquals(r, { ok: true });
  assertEquals(written, ["home:claude", "work:claude-work"]);
  f = await setupFacts(p, io);
  assertEquals(f.profiles.map((x) => `${x.profile}:${x.command}`), ["home:claude", "work:claude-work"]);
  assertEquals(nextStep(f), "install");
  // the same list again: nothing rewritten; a command changed: written with the rest of its manifest
  await Deno.writeTextFile(
    `${p.config}/profiles/work/profile.json`,
    JSON.stringify({ command: "claude-work", alias: "cw", desktopDir: "~/.config/Claude-Work" }),
  );
  written.length = 0;
  await setProfiles({ profiles: [{ name: "home", command: "claude" }, { name: "work" }] }, write, p);
  assertEquals(written, []);
  await setProfiles({ profiles: [{ name: "home", command: "claude" }, { name: "work", command: "cwork" }] }, write, p);
  assertEquals(JSON.parse(await Deno.readTextFile(`${p.config}/profiles/work/profile.json`)), {
    name: "work",
    command: "cwork",
    alias: "cw",
    desktopDir: "~/.config/Claude-Work",
  });
  await setProfiles({ profiles: [{ name: "home", command: "claude" }, { name: "work" }] }, write, p);

  // an installed profile is not removed from here
  await Deno.mkdir(`${p.runtime}/work`, { recursive: true });
  assertEquals((await setProfiles({ profiles: [{ name: "home", command: "claude" }] }, write, p)).ok, false);
  assert(await Deno.stat(`${p.config}/profiles/work`));

  // installed: the shared link, each profile's folder and launcher
  await Deno.mkdir(`${p.runtime}/home`, { recursive: true });
  await Deno.mkdir(p.bin, { recursive: true });
  await Deno.symlink("app/current/shared", `${p.runtime}/shared`);
  for (const c of ["claude", "claude-work"]) await Deno.symlink("/nowhere", `${p.bin}/${c}`);
  f = await setupFacts(p, io);
  assertEquals([f.installed, f.claudeCode, nextStep(f)], [true, false, "claude"]);
  // Claude Code in place (the job's result): the step is done by what it left
  await Deno.writeTextFile(`${p.bin}/claude-bin`, "");
  f = await setupFacts(p, io);
  assertEquals([f.claudeCode, nextStep(f)], [true, "vault"]);
  await passStep({ step: "vault" }, p);
  await Deno.writeTextFile(`${p.runtime}/home/.credentials.json`, "{}");
  f = await setupFacts(p, io);
  assertEquals([f.profiles.map((x) => x.signedIn), nextStep(f)], [[true, false], "logins"]);
  await passStep({ step: "logins", later: true }, p);
  // the brain: an account with an address and a secret in the vault
  await Deno.writeTextFile(
    `${p.config}/accounts.json`,
    JSON.stringify({ accounts: [{ service: "brain", name: "brain", url: "https://b.example" }] }),
  );
  f = await setupFacts(p, io);
  assertEquals([f.brain, nextStep(f)], [{ url: "https://b.example", connected: true }, "done"]);
  assertEquals((await setupFacts(p, { ...io, hasSecret: () => Promise.resolve(false) })).brain.connected, false);
  assertEquals((await readRecord(p))?.later, ["logins"]);

  // finished: the wizard is no longer shown, and its writes are closed
  assertEquals(await setupOpen(p), true);
  await updateRecord((x) => x.finished = "now", p);
  assertEquals([setupActive(await setupFacts(p, io)), await setupOpen(p)], [false, false]);
  assertEquals(await setupView(p), { active: false });
});

Deno.test("watchFor: says once when the file appears, not for others; a second watch of it is the same one", async () => {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/.credentials.json`;
  let told = 0;
  const seen = Promise.withResolvers<void>();
  watchFor(file, () => (told++, seen.resolve()), 5000);
  watchFor(file, () => told++, 5000);
  await new Promise((r) => setTimeout(r, 50));
  await Deno.writeTextFile(`${dir}/other.json`, "{}");
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(told, 0);
  await Deno.writeTextFile(file, "{}");
  await seen.promise;
  await Deno.writeTextFile(file, "{ }");
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(told, 1);
});

Deno.test("setup routes: on a configured machine every write is refused, header or not", async () => {
  // the tests' configuration (CLAUDE_MULTI_CONFIG) has an owner and no setup of its own: configured by hand
  const handle = createHandler(setupRoutes({ invalidate: () => {} }));
  const req = (path: string, init: RequestInit = {}) =>
    new Request(`http://127.0.0.1:7331${path}`, {
      ...init,
      headers: { host: "127.0.0.1:7331", ...(init.headers as Record<string, string> ?? {}) },
    });
  const post = (path: string, body: unknown, header = true) =>
    handle(req(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: header ? { "x-claude-multi": "1" } : {},
    }));
  for (
    const [path, body] of Object.entries({
      "/api/setup/owner": { name: "X", language: "English" },
      "/api/setup/folder": { folder: "~/x" },
      "/api/setup/profiles": { profiles: [{ name: "x1" }] },
      "/api/setup/pass": { step: "welcome" },
      "/api/setup/vault": { mode: "init" },
      "/api/setup/login": { profile: "personal" },
      "/api/setup/brain": { url: "https://b.example" },
      "/api/setup/finish": {},
    })
  ) {
    assertEquals((await post(path, body, false)).status, 403, path);
    const r = await post(path, body);
    assertEquals(r.status, 409, path);
    assertEquals((await r.json()).ok, false);
  }
  assertEquals((await handle(req("/api/setup/owner"))).status, 405);
});
