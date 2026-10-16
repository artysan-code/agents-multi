// command.ts — `agents node`: this machine as a node of the service (ADR 0012). What it would announce, turning
// it on or off (`config/node.json`, the owner's configuration), the sandbox probe, and the owner's public
// approval key, which a node with no vault pins.

import { approvalKeys } from "../../../shared/mcp/lib/nodes.ts";
import {
  CLAUDE_TOKEN,
  loadNodeConfig,
  machineNodeFile,
  nodesFile,
  validGitHost,
  type VoiceConfig,
  voicePath,
} from "../../../shared/mcp/lib/headless.ts";
import { setSecret } from "../../../shared/mcp/lib/vault.ts";
import { launchers } from "../lib/profiles.ts";
import { readStdin } from "../vault.ts";
import { nodeSetup } from "./setup.ts";
import { loadKey } from "../../../shared/mcp/lib/vault.ts";
import { ANSI } from "../lib/output.ts";
import { CONFIG } from "../lib/paths.ts";
import { writeAtomic } from "../lib/fs.ts";
import { approvalKey, nodeFacts, nodeName } from "./facts.ts";
import { headlessProbe } from "./probe.ts";
import { nodeTokenFile, readNodeToken, service, writeNodeToken } from "./service.ts";
import { followLogin, startBrainLogin } from "../brain-login.ts";
import { brainAccount } from "../../../shared/mcp/lib/brain-tasks.ts";
import { machineHeadless, NODE_ONLY } from "../../../shared/mcp/lib/headless.ts";
import { readNodeState } from "./agentd.ts";
import { bigCode, pairMachine, spinnerFrame } from "./pair.ts";
import { platformOf } from "../../../shared/mcp/lib/platform.ts";
import { expandVoicePath, findOnPath, findWhisperBin, findWhisperModel, realFindIO, voiceReady } from "./voice.ts";
import { seedCommand } from "./seed.ts";
import { syncIfPresent } from "./server-vault.ts";

const GiB = 2 ** 30;

/** Pure: whether a pasted text is a long-lived token of `claude setup-token`. */
export const isSetupToken = (t: string) => /^sk-ant-oat01-[\w-]{20,}$/.test(t.trim());

/** Pure: this machine's node.json after `enable`/`disable`: its other keys kept, the ones the command sets changed. */
export function nodeConfigWith(raw: unknown, set: { enabled: boolean; headless?: boolean; maxSessions?: number }) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = { ...base, enabled: set.enabled };
  if (set.headless !== undefined) out.headless = set.headless;
  if (set.maxSessions !== undefined) out.maxSessions = set.maxSessions;
  return out;
}

/** Pure: this machine's node.json with its voice setting set, or removed (`null`); its other keys kept. */
export function voiceConfigWith(raw: unknown, voice: VoiceConfig | null): Record<string, unknown> {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw as Record<string, unknown> } : {};
  if (voice) base.voice = voice;
  else delete base.voice;
  return base;
}

/** Pure: the owner's nodes.json with a host added to or removed from `gitHosts` (the hosts whose repositories are
 *  the owner's: cloned on need, their runs published by name); its other keys kept; why not, for a host that
 *  is not `host`, `host:port` or `host/owner`. */
export function gitHostsWith(
  raw: unknown,
  op: "add" | "remove",
  host: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; why: string } {
  const h = host.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]*@/, "").replace(/\/+$/, "");
  if (!validGitHost(h)) return { ok: false, why: `${host}: not a host, host:port or host/owner` };
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw as Record<string, unknown> } : {};
  const list = Array.isArray(base.gitHosts) ? base.gitHosts.filter((x): x is string => typeof x === "string") : [];
  base.gitHosts = op === "add" ? (list.includes(h) ? list : [...list, h]) : list.filter((x) => x !== h);
  return { ok: true, config: base };
}

/** The line that tells the owner how to say which repositories are theirs, when nothing does yet. */
export const HOSTS_HINT =
  "no repos nor gitHosts say which repositories are yours: their runs go to the phone as a client's (state only, " +
  "names hidden) and none is cloned on need. Add your forge: agents node hosts add git.example.me (or github.com/you)";

/** Turns this machine's node on or off in its own node.json (the other keys kept). */
async function writeEnabled(file: string, set: { enabled: boolean; headless?: boolean; maxSessions?: number }) {
  await loadNodeConfig(CONFIG); // the old config/node.json is moved first, so that this does not undo it
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const raw = await Deno.readTextFile(file).then(JSON.parse).catch(() => ({}));
  await writeAtomic(file, JSON.stringify(nodeConfigWith(raw, set), null, 2) + "\n");
}

export async function nodeCommand(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  // this machine's file (ADR 0013): the owner's settings are config/nodes.json, the same everywhere
  const file = machineNodeFile();
  const opt = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (sub) {
    case "status": {
      const cfg = await loadNodeConfig(CONFIG);
      const probe = cfg.headless ? await headlessProbe() : null;
      const facts = await nodeFacts(cfg, probe ? probe.ok : null);
      const svc = await service().catch((e) => (e as Error).message);
      const key = await approvalKey(cfg);
      const st = await readNodeState();
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ name: nodeName(cfg), config: cfg, facts, probe, key: !!key, state: st }, null, 2));
        return 0;
      }
      const followed = Object.values(st.runs).filter((r) => !r.done).length;
      console.log(
        `${ANSI.b}${nodeName(cfg)}${ANSI.x}  ${cfg.enabled ? "on" : "off"}${cfg.headless ? ", headless" : ""}`,
      );
      console.log(`  service     ${typeof svc === "string" ? `${ANSI.d}${svc}${ANSI.x}` : svc.url}`);
      console.log(`  sessions    ${facts.running} of ${facts.cap}  (memory ${(facts.memTotal / GiB).toFixed(1)} GiB)`);
      console.log(`  accounts    ${facts.accounts.join(", ") || "none logged in"}`);
      console.log(`  owner here  ${facts.present ? "yes" : "no"}`);
      console.log(
        `  voice       ${
          cfg.voice
            ? facts.voice
              ? `on (${cfg.voice.bin}, ${cfg.voice.model})`
              : "set, but whisper, its model or ffmpeg is missing"
            : "off: agents node voice"
        }`,
      );
      if (probe) console.log(`  sandbox     ${probe.ok ? "works" : `does not work: ${probe.reason}`}`);
      console.log(
        `  approval    ${key ? "the owner's key is known here" : "no key: no vault, and no approvalKey in node.json"}`,
      );
      console.log(`  runs        ${followed} followed`);
      const token = await readNodeToken();
      console.log(`  token       ${token ? "its own" : "none: agents node pair"}`);
      if (!cfg.enabled) console.log(`\n${ANSI.d}agents node enable [--headless] turns it on (${file})${ANSI.x}`);
      return 0;
    }
    case "login": {
      // this machine's own token: the service names the node after it (ADR 0012), so it is never the vault's
      if (await machineHeadless()) {
        console.error(NODE_ONLY);
        return 1;
      }
      const account = rest.find((a) => !a.startsWith("--")) ?? brainAccount()?.name;
      if (!account) {
        console.error(
          "no brain account in accounts.json: add one (service brain, with its address), or `agents init <folder> --brain <address>` on a new node",
        );
        return 1;
      }
      const done = Promise.withResolvers<{ ok: boolean; message: string }>();
      const url = await startBrainLogin(account, done.resolve, {
        store: async (_service, _account, value, field = "token") => {
          if (field === "token") await writeNodeToken(value);
        },
        where: `${nodeTokenFile()}, this machine only`,
      });
      return await followLogin(url, done.promise, rest.includes("--no-browser"));
    }
    case "pair": {
      if (rest.includes("--server")) {
        // a server with no configuration yet (ADR 0013, F2): the code and the key's fingerprint in its log, the
        // owner pairs it from their console, the vault key arrives sealed to this server's key
        const { adoptVaultKey, loadPairKey, pairKeyFile, pairServer, serverPairLines } = await import("./pair.ts");
        const { amEnv } = await import("../../../shared/mcp/lib/env.ts");
        const url = opt("--url") ?? amEnv("SERVICE_URL") ?? brainAccount()?.url;
        if (!url || !/^https?:\/\//.test(url)) {
          console.error("no service address: --url https://<your brain>, or AGENTS_MULTI_SERVICE_URL in the container");
          return 1;
        }
        if (await readNodeToken()) {
          console.log(`already paired: the node token is in ${nodeTokenFile()}`);
          return 0;
        }
        const stop = new AbortController();
        Deno.addSignalListener("SIGINT", () => stop.abort());
        Deno.addSignalListener("SIGTERM", () => stop.abort());
        const key = await loadPairKey();
        const name = nodeName(await loadNodeConfig(CONFIG));
        const r = await pairServer(url, name, platformOf(), key, {
          signal: stop.signal,
          show: ({ code, expires, fingerprint }) =>
            console.log(
              serverPairLines({ code, fingerprint: fingerprint ?? "", service: url, expires }).join("\n"),
            ),
        });
        if (!r.ok) {
          console.error(r.message);
          return 1;
        }
        await writeNodeToken(r.token);
        let vault = "no vault key came with it: `agents node setup` asks for the recovery code";
        if (r.sealed && r.id) {
          try {
            vault = (await adoptVaultKey(r.sealed, key, r.id)) === "checked"
              ? "the vault key arrived, sealed to this server, and opens the vault"
              : "the vault key arrived, sealed to this server; the vault is still on its way (Syncthing)";
          } catch (e) {
            vault = `the vault key did not open: ${(e as Error).message}`;
          }
        }
        // the key pair has served: a new pairing makes a new one
        await Deno.remove(pairKeyFile()).catch(() => {});
        console.log(`PAIRED ${name}\n  the node token is in ${nodeTokenFile()}, this machine only\n  ${vault}`);
        return 0;
      }
      // a code instead of a browser sign-in (ADR 0014), for a desktop or a phone-only owner: its token is a
      // machine's, so a server pairs with --server (ADR 0013, F2)
      if (await machineHeadless()) {
        console.error(NODE_ONLY);
        return 1;
      }
      const account = brainAccount();
      if (!account?.url) {
        console.error(
          "no brain account with an address in accounts.json: add one (service brain), or `agents init <folder> --brain <address>` on a new node",
        );
        return 1;
      }
      // --plain: lines a program reads (the console's job); otherwise the code is shown big, with a spinner
      const plain = rest.includes("--plain");
      const tty = !plain && Deno.stdout.isTerminal();
      const stop = new AbortController();
      Deno.addSignalListener("SIGINT", () => stop.abort());
      const cfg = await loadNodeConfig(CONFIG);
      const r = await pairMachine(account.url, nodeName(cfg), platformOf(), {
        signal: stop.signal,
        show: ({ code, url, expires }) => {
          if (plain) {
            console.log(`CODE ${code}\nOPEN ${url}\nEXPIRES ${expires}`);
            return;
          }
          console.log(`\n  Open ${ANSI.c}${url}${ANSI.x}, sign in, and type this code:\n`);
          console.log(`      ${bigCode(code)}\n`);
          console.log(`  ${ANSI.d}good for 10 minutes; Ctrl-C to cancel${ANSI.x}\n`);
        },
        tick: tty
          ? (ms) => Deno.stdout.writeSync(new TextEncoder().encode(`\r  ${spinnerFrame(ms)} waiting for the code…`))
          : undefined,
      });
      if (tty) Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[K"));
      if (!r.ok) {
        console.error(r.message);
        return 1;
      }
      await writeNodeToken(r.token);
      await writeEnabled(file, { enabled: true });
      console.log(
        plain
          ? `PAIRED ${nodeName(cfg)}`
          : `${ANSI.g}+${ANSI.x} paired as ${
            nodeName(cfg)
          }: the token is in ${nodeTokenFile()}, this machine only; the node is on (the console picks it up within 30 s)`,
      );
      return 0;
    }
    case "enable":
    case "disable": {
      const max = opt("--max");
      if (max !== undefined && !/^\d+$/.test(max)) {
        console.error("--max is a number of sessions");
        return 2;
      }
      await writeEnabled(file, {
        enabled: sub === "enable",
        ...(rest.includes("--headless") ? { headless: true } : {}),
        ...(max !== undefined ? { maxSessions: Number(max) } : {}),
      });
      console.log(`${sub === "enable" ? "on" : "off"}: ${file}; the console picks it up within 30 s`);
      if (sub === "enable") {
        const cfg = await loadNodeConfig(CONFIG);
        if (!cfg.repos.length && !cfg.gitHosts?.length) console.log(HOSTS_HINT);
      }
      if (sub === "enable" && !(await readNodeToken())) {
        console.log("it announces itself only with a token of its own: agents node pair (or agents node login)");
      }
      return 0;
    }
    case "voice": {
      // voice notes (ADR 0014): find whisper.cpp and a ggml model here, or take the ones named, and keep them in
      // this machine's node.json; the node then announces it takes voice notes
      const raw = await Deno.readTextFile(file).then(JSON.parse).catch(() => ({}));
      if (rest.includes("--off")) {
        await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await writeAtomic(file, JSON.stringify(voiceConfigWith(raw, null), null, 2) + "\n");
        console.log("voice notes off on this machine");
        return 0;
      }
      const find = realFindIO();
      const given = (n: string) => {
        const v = opt(n);
        if (v === undefined) return undefined;
        return voicePath(v) ?? null;
      };
      const gb = given("--bin"), gm = given("--model");
      if (gb === null || gm === null) {
        console.error("--bin and --model are absolute paths (or start with ~/)");
        return 2;
      }
      const bin = gb ?? await findWhisperBin(find), model = gm ?? await findWhisperModel(find);
      const ffmpeg = await findOnPath(find, "ffmpeg");
      const mark = (ok: boolean) => ok ? `${ANSI.g}found${ANSI.x}` : `${ANSI.y}missing${ANSI.x}`;
      const exists = async (p: string | null | undefined) => !!p && await find.isFile(expandVoicePath(p));
      console.log(`  whisper-cli  ${mark(await exists(bin))}  ${bin ?? "--bin <path to whisper-cli>"}`);
      console.log(`  ggml model   ${mark(await exists(model))}  ${model ?? "--model <path to a ggml-*.bin>"}`);
      console.log(`  ffmpeg       ${mark(!!ffmpeg)}  ${ffmpeg ?? "install ffmpeg"}`);
      if (!bin || !model || !(await exists(bin)) || !(await exists(model))) {
        console.log(
          `\n${ANSI.d}whisper.cpp: build it (cmake -B build && cmake --build build -j --config Release) and fetch a multilingual model (models/download-ggml-model.sh base); the server node image has the program, \`agents node setup\` offers the model${ANSI.x}`,
        );
        return 1;
      }
      const voice = { bin, model };
      await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      await writeAtomic(file, JSON.stringify(voiceConfigWith(raw, voice), null, 2) + "\n");
      const ready = await voiceReady(voice, find);
      console.log(
        ready
          ? `\n${ANSI.g}+${ANSI.x} voice notes on: ${file}; the node announces it within 30 s`
          : `\nsaved in ${file}, but ffmpeg is missing: the node takes no voice note until it is installed`,
      );
      return 0;
    }
    case "setup":
      return await nodeSetup(nodeCommand);
    case "token": {
      // an account's long-lived token for the servers (ADR 0013): made here, with a browser, kept in the vault
      const profile = rest.find((a) => !a.startsWith("--"));
      const l = (await launchers()).find((x) => x.profile === profile);
      if (!profile || !l) {
        console.error(`usage: agents node token <profile>  (${(await launchers()).map((x) => x.profile).join(", ")})`);
        return 2;
      }
      if (!rest.includes("--paste")) {
        console.log(
          `${ANSI.b}${profile}${ANSI.x}: Claude Code makes a one-year token for this account (claude setup-token).`,
        );
        console.log(
          `${ANSI.d}Sign in with the account of ${profile} in the browser it opens, then copy the token it prints.${ANSI.x}\n`,
        );
        const r = await new Deno.Command(l.command, {
          args: ["setup-token"],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })
          .spawn().status;
        if (!r.success) {
          console.error(`claude setup-token ended with ${r.code}: nothing stored`);
          return 1;
        }
      }
      const token = await readStdin("paste the token (not shown): ");
      if (!isSetupToken(token)) {
        console.error("that is not a token of claude setup-token (sk-ant-oat01-…): nothing stored");
        return 1;
      }
      await setSecret(CLAUDE_TOKEN.service, profile, token.trim(), CLAUDE_TOKEN.field);
      console.log(
        `${ANSI.g}+${ANSI.x} ${profile}: the token is in the vault; a server node runs this account once its vault has it`,
      );
      // a server has a vault of its own (ADR 0015): the token reaches it there
      console.log((await syncIfPresent()) ?? "no server vault yet: agents vault server sync makes it");
      return 0;
    }
    case "probe": {
      const p = await headlessProbe();
      console.log(p.ok ? "the Bash sandbox works here, and the token's scrub" : `not ready for work here: ${p.reason}`);
      return p.ok ? 0 : 1;
    }
    case "key": {
      // the public half only: what a node with no vault puts in node.json as approvalKey
      console.log((await approvalKeys((await loadKey()).raw)).public);
      return 0;
    }
    case "hosts": {
      // the owner's forges (config/nodes.json gitHosts, the same on every machine): what is theirs, cloned on need
      // and published by name to the phone; anything else is a client's
      const [op, host] = rest;
      const shared = nodesFile(CONFIG);
      await loadNodeConfig(CONFIG); // the old config/node.json is moved first
      const raw = await Deno.readTextFile(shared).then(JSON.parse).catch(() => ({}));
      if (!op || op === "list") {
        const list = (await loadNodeConfig(CONFIG)).gitHosts ?? [];
        console.log(list.length ? list.join("\n") : "none: agents node hosts add <host>");
        return 0;
      }
      if ((op !== "add" && op !== "remove") || !host) {
        console.error("usage: agents node hosts [list | add <host> | remove <host>]");
        return 2;
      }
      const r = gitHostsWith(raw, op, host);
      if (!r.ok) {
        console.error(r.why);
        return 2;
      }
      await writeAtomic(shared, JSON.stringify(r.config, null, 2) + "\n");
      console.log(`gitHosts: ${(r.config.gitHosts as string[]).join(", ") || "none"} (${shared})`);
      return 0;
    }
    case "seed": // the env files git ignores, sealed in the vault for a machine that clones the repository (seed.ts)
    {
      const code = await seedCommand(rest);
      if (code === 0 && !rest.includes("--dry-run")) {
        const line = await syncIfPresent();
        if (line) console.log(line);
      }
      return code;
    }
    default:
      console.error(
        "usage: agents node [status [--json]|pair|login [--no-browser]|enable [--headless] [--max N]|disable|token <profile>|setup|probe|key|voice [--bin P] [--model P] [--off]|hosts [add|remove <host>]]",
      );
      return 2;
  }
}
