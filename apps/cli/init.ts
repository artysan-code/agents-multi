// init.ts — `agents init <folder>`: a person's configuration, made from config.example/ and
// linked from ~/.agents-multi/config. The repository is code; profiles, accounts, rules and
// preferences live in that folder, which its owner keeps in step between their machines.
//
//   agents init ~/personal/claude-multi-config --name Ann --language Italian [--id ann]
//   agents init <existing folder>     only link it (a second machine)
//   agents init ~/config --name Ann --brain https://brain.example   a server node: the brain's account comes too

import { lstat, readlink } from "./lib/fs.ts";
import { ANSI } from "./lib/output.ts";
import { CONFIG as CONFIG_DEFAULT, expandHome, REPO, shortHome } from "./lib/paths.ts";

/** Pure: an owner id from a name — lower case, letters and digits only. */
export function idFrom(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "me";
}

/** Pure: accounts.json with the brain's account at this address: added when there is none, else unchanged. */
export function withBrainAccount(raw: { accounts?: unknown[] } & Record<string, unknown>, url: string) {
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const has = accounts.some((a) => (a as { service?: string })?.service === "brain");
  return has ? { ...raw, accounts } : { ...raw, accounts: [...accounts, { service: "brain", name: "brain", url }] };
}

async function copyTree(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    if (e.isDirectory) await copyTree(`${from}/${e.name}`, `${to}/${e.name}`);
    else await Deno.copyFile(`${from}/${e.name}`, `${to}/${e.name}`);
  }
}

export async function init(args: string[], CONFIG = CONFIG_DEFAULT): Promise<number> {
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const folder = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!folder) {
    console.error("usage: agents init <folder> [--name N] [--language L] [--id I] [--brain URL]");
    return 2;
  }
  // checked before anything is written; setup.ts imports this module, so it is loaded only when needed
  let brain: string | undefined;
  if (opt("--brain") !== undefined) {
    const { checkBrainUrl } = await import("./setup.ts");
    const u = checkBrainUrl(opt("--brain"));
    if (!u.ok) {
      console.error(`${ANSI.r}✗${ANSI.x} --brain: ${u.message}`);
      return 2;
    }
    brain = u.url;
  }
  const dir = expandHome(folder).replace(/\/+$/, "");
  const abs = dir.startsWith("/") ? dir : `${Deno.cwd()}/${dir}`;

  // checked before anything is written: a link to another configuration is never replaced
  const cur = await lstat(CONFIG);
  const linked = !!cur?.isSymlink && await readlink(CONFIG) === abs;
  if (cur && !linked) {
    console.error(
      `${ANSI.r}✗${ANSI.x} ${shortHome(CONFIG)} exists and is not a link to ${shortHome(abs)}: move it away first`,
    );
    return 1;
  }

  const existing = await lstat(`${abs}/owner.json`);
  if (!existing) {
    await copyTree(`${REPO}/config.example`, abs);
    const owner = JSON.parse(await Deno.readTextFile(`${abs}/owner.json`));
    if (opt("--name")) owner.name = opt("--name");
    if (opt("--language")) owner.language = opt("--language");
    owner.id = opt("--id") ?? (opt("--name") ? idFrom(opt("--name")!) : owner.id);
    await Deno.writeTextFile(`${abs}/owner.json`, JSON.stringify(owner, null, 2) + "\n");
    console.log(
      `${ANSI.g}+${ANSI.x} configuration made in ${
        shortHome(abs)
      } (owner ${owner.id}): edit owner.json and profiles/ as you like`,
    );
  } else console.log(`${ANSI.d}${shortHome(abs)} already holds a configuration: only linking it${ANSI.x}`);
  if (brain) {
    // the brain's address, before any sign-in: bin/agents lets a process reach only the brains named here
    const file = `${abs}/accounts.json`;
    const raw = await Deno.readTextFile(file).then(JSON.parse).catch(() => ({ accounts: [] }));
    const next = withBrainAccount(raw, brain);
    if (next.accounts.length !== (raw.accounts?.length ?? 0)) {
      await Deno.writeTextFile(file, JSON.stringify(next, null, 2) + "\n");
      console.log(`${ANSI.g}+${ANSI.x} the brain's account: ${brain}`);
    } else console.log(`${ANSI.d}accounts.json already has a brain account${ANSI.x}`);
  }

  // ~/.agents-multi/config → the folder; never over something else
  if (linked) console.log(`${ANSI.d}${shortHome(CONFIG)} already links to it${ANSI.x}`);
  else {
    await Deno.mkdir(CONFIG.slice(0, CONFIG.lastIndexOf("/")), { recursive: true });
    await Deno.symlink(abs, CONFIG);
    console.log(`${ANSI.g}+${ANSI.x} ${shortHome(CONFIG)} → ${shortHome(abs)}`);
  }
  console.log(
    `\nNext: agents install, then agents vault init, then claude in each profile to sign in (README › First run).`,
  );
  return 0;
}
