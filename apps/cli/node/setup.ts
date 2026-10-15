// setup.ts — `agents node setup`: a server node set up by one command in its container's terminal (ADR 0013).
// Each step looks at what is already there and does only what is missing, so running it again is how a step that
// waited (Syncthing, the forge, a token made on the owner's desktop) is finished. It ends with the node on: the
// container's entry point sees it and starts serving, no restart.

import { brainAccount } from "../../../shared/mcp/lib/brain-tasks.ts";
import { claudeToken, loadNodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { listAccounts } from "../../../shared/mcp/lib/providers.ts";
import { hasVault, keyMatches, loadKey, pairVault, vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { lstat, readlink } from "../lib/fs.ts";
import { ANSI } from "../lib/output.ts";
import { CONFIG, HOME, RUNTIME, shortHome } from "../lib/paths.ts";
import { CONFIG_HOME } from "../init.ts";
import { readStdin } from "../vault.ts";
import { readNodeToken } from "./service.ts";
import {
  downloadModel,
  findOnPath,
  findWhisperBin,
  findWhisperModel,
  modelDir,
  MODELS,
  realFindIO,
  voiceReady,
} from "./voice.ts";

const ok = (m: string) => console.log(`${ANSI.g}✓${ANSI.x} ${m}`);
const todo = (m: string) => console.log(`${ANSI.y}!${ANSI.x} ${m}`);
const stop = (m: string) => {
  console.error(`${ANSI.r}✗${ANSI.x} ${m}`);
  return 1;
};

/** Pure: a clone's folder name from its remote (`git@host:me/repo.git` → `repo`). */
export function cloneName(remote: string): string {
  return remote.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
}

/** A line from the terminal, shown as it is typed. */
async function ask(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
}

async function run(cmd: string, args: string[], env?: Record<string, string>, quiet = false): Promise<boolean> {
  const out = quiet ? "null" : "inherit";
  const r = await new Deno.Command(cmd, { args, env, stdin: "null", stdout: out, stderr: out }).output()
    .catch(() => null);
  return !!r?.success;
}

// the forge's host key is taken the first time it is seen, never asked about (the node has no one to ask)
const GIT_ENV = { GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes" };

const MiB = (n: number) => `${Math.round(n / 2 ** 20)} MiB`;

async function voiceStep(current: Parameters<typeof voiceReady>[0], nodeCommand: (args: string[]) => Promise<number>) {
  const find = realFindIO();
  if (await voiceReady(current, find)) return ok("voice notes: whisper.cpp and its model are ready");
  const [bin, ffmpeg] = [await findWhisperBin(find), await findOnPath(find, "ffmpeg")];
  if (!bin || !ffmpeg) {
    return todo(`voice notes (optional): ${!bin ? "no whisper-cli" : "no ffmpeg"} here, so this node takes none`);
  }
  let model = await findWhisperModel(find);
  if (!model) {
    if (!Deno.stdin.isTerminal()) {
      return todo("voice notes: no model; run `agents node setup` in a terminal to choose one");
    }
    const choices = MODELS.map((m) => `${m.name[0]} = ${m.name} (${MiB(m.bytes)}, ${m.note})`).join("; ");
    const a =
      (await ask(`\nVoice notes need a speech model. Download one into this node's volume? ${choices}; Enter = no: `))
        .toLowerCase();
    const pick = MODELS.find((m) => a !== "" && (a === m.name || a === m.name[0]));
    if (!pick) return todo("voice notes: no model chosen; run `agents node setup` again to download one");
    const dest = `${modelDir()}/${pick.file}`;
    console.log(`downloading ${pick.file} (${MiB(pick.bytes)}) from Hugging Face, checked against its SHA-256…`);
    let shown = -1;
    const r = await downloadModel(pick, dest, {
      progress: (done) => {
        const pct = Math.floor((done / pick.bytes) * 10) * 10;
        if (pct !== shown) (shown = pct, Deno.stdout.writeSync(new TextEncoder().encode(`\r  ${pct}%`)));
      },
    });
    console.log();
    if (!r.ok) return todo(`voice notes: ${r.why}`);
    model = dest;
    ok(`${pick.file}: downloaded, checksum verified`);
  }
  if ((await nodeCommand(["voice", "--bin", bin, "--model", model])) === 0) ok("voice notes are on");
}

export async function nodeSetup(nodeCommand: (args: string[]) => Promise<number>): Promise<number> {
  console.log(`${ANSI.b}agents node setup${ANSI.x} — this machine as a server node (ADR 0013)\n`);

  // 1. the owner's configuration, mounted read only from its Syncthing folder
  const shared = !!(await lstat(`${CONFIG_HOME}/owner.json`));
  const linked = await readlink(CONFIG).catch(() => null);
  if (shared && linked !== CONFIG_HOME) {
    if ((await lstat(CONFIG))?.isSymlink || !(await lstat(CONFIG))) {
      await Deno.remove(CONFIG).catch(() => {});
      await Deno.symlink(CONFIG_HOME, CONFIG);
      ok(`the owner's configuration: ${shortHome(CONFIG)} → ${shortHome(CONFIG_HOME)}`);
      // what this process may reach was decided from the configuration it started with (bin/agents)
      console.log(`\nThe configuration changed under this command: run ${ANSI.b}agents node setup${ANSI.x} again.`);
      return 0;
    }
  }
  if (!(await lstat(`${CONFIG}/owner.json`))) {
    return stop(
      `no configuration: mount the owner's (${
        shortHome(CONFIG_HOME)
      }, NODE_CONFIG_DIR) or \`agents init ~/config --brain <address>\``,
    );
  }
  if (shared) ok(`the owner's configuration, read only (${shortHome(CONFIG_HOME)})`);
  else todo(`a configuration of this node's own (${shortHome(linked ?? CONFIG)}): the owner's is not mounted here`);
  if (!brainAccount()) {
    return stop("no brain account in the configuration: add it on your machine (accounts.json, service brain)");
  }

  // 2. the vault: its entries arrive by Syncthing, its key once, from the recovery code
  if (!hasVault(vaultDir())) {
    return stop(`no vault in ${shortHome(vaultDir())}: mount the owner's (NODE_VAULT_DIR) and wait for Syncthing`);
  }
  const opens = await loadKey().then(keyMatches, () => false);
  if (opens) ok("the vault opens here");
  else {
    console.log(`\nThe vault's recovery code (on your machine: ${ANSI.b}agents vault recovery-code${ANSI.x}).`);
    try {
      await pairVault(await readStdin("recovery code (not shown): "), "file");
    } catch (e) {
      return stop((e as Error).message);
    }
    ok("the vault opens here (its key in a file only this user reads)");
  }

  // 3. this node's own token at the service
  if (await readNodeToken()) ok("a node token of its own");
  else {
    console.log();
    if ((await nodeCommand(["login", "--no-browser"])) !== 0) return stop("the node did not sign in: run setup again");
  }

  // 4. Claude's accounts: a long-lived token each, made on the owner's desktop
  const claude = (await listAccounts(CONFIG)).filter((a) => a.provider === "claude");
  const missing: string[] = [];
  for (const a of claude) {
    const has = (await claudeToken(a.profile)) || (await lstat(`${RUNTIME}/${a.profile}/.credentials.json`));
    if (has) ok(`Claude, ${a.profile}: ready`);
    else missing.push(a.profile);
  }
  for (const p of missing) {
    todo(`Claude, ${p}: no token in the vault; on your desktop: ${ANSI.b}agents node token ${p}${ANSI.x}`);
  }

  // 5. the git key, and the forge that takes it
  const cfg = await loadNodeConfig();
  const key = `${HOME}/.ssh/id_ed25519`;
  if (!(await lstat(key))) {
    await Deno.mkdir(`${HOME}/.ssh`, { recursive: true, mode: 0o700 });
    const host = Deno.hostname();
    if (!(await run("ssh-keygen", ["-q", "-t", "ed25519", "-f", key, "-N", "", "-C", `agents-node@${host}`]))) {
      return stop("ssh-keygen failed");
    }
  }
  const pub = (await Deno.readTextFile(`${key}.pub`)).trim();
  if (cfg.repos.length) {
    const first = cfg.repos[0];
    while (!(await run("git", ["ls-remote", "--heads", first], GIT_ENV, true))) {
      console.log(
        `\nThe forge does not take this node's key yet. Add it (a deploy key, or your user's):\n\n  ${pub}\n`,
      );
      const a = await ask("Enter when it is added, s to skip the clones: ");
      if (a.toLowerCase() === "s") break;
    }
  } else {
    ok(`the git key (no repositories in nodes.json \`repos\`): ${pub}`);
  }

  // 6. the clones the owner lists, under the first of repoRoots
  const root = (cfg.repoRoots[0] ?? "~").replace(/^~(?=\/|$)/, HOME);
  for (const remote of cfg.repos) {
    const dir = `${root}/${cloneName(remote)}`;
    if (await lstat(`${dir}/.git`)) ok(`clone ${shortHome(dir)}`);
    else if (await run("git", ["clone", "--quiet", remote, dir], GIT_ENV)) ok(`cloned ${shortHome(dir)}`);
    else todo(`${remote}: not cloned (the forge refused it): run setup again`);
  }

  // 7. voice notes, when whisper.cpp and ffmpeg are here (the image has both): the model is the owner's to accept,
  // downloaded once into the volume and kept only if its checksum matches
  await voiceStep(cfg.voice, nodeCommand);

  // 8. on, headless: the entry point sees it and starts serving
  if (!(cfg.enabled && cfg.headless)) {
    if ((await nodeCommand(["enable", "--headless"])) !== 0) return stop("the node could not be turned on");
  }
  ok("the node is on, headless");
  console.log(
    `\n${ANSI.b}Done.${ANSI.x} The container starts serving within seconds; \`agents nodes\` on your machine shows it.` +
      (missing.length ? `\nIt runs no job of ${missing.join(", ")} until their tokens are in the vault.` : ""),
  );
  return 0;
}
