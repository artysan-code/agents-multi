// vault.ts — `agents vault …`: the secret store from the terminal (the console does the same
// from Connections). The store itself is shared/mcp/lib/vault.ts, which the MCP servers use too.
//
// A secret is never an argument: it is read from stdin, so it does not land in the shell history or
// in `ps`. And nothing here prints one, except `recovery-code`, which prints the key on purpose.

import { ANSI } from "./lib/output.ts";
import { RUNTIME } from "./lib/paths.ts";
import { parseRun, profileFrom, runTool } from "./toolrun.ts";
import { ACCOUNTS } from "./mcp/registry.ts";
import { type Account, loadAccounts, resolveAccount, visibleAccounts } from "../../shared/mcp/lib/accounts.ts";
import {
  currentRecoveryCode,
  deleteSecret,
  getSecret,
  initVault,
  keyMatches,
  listSecrets,
  loadKey,
  pairVault,
  setSecret,
  vaultDir,
  VaultError,
} from "../../shared/mcp/lib/vault.ts";
import { amEnv } from "../../shared/mcp/lib/env.ts";

async function readStdin(prompt: string): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    await Deno.stdout.write(new TextEncoder().encode(prompt));
    // no echo while a secret is typed
    await new Deno.Command("stty", { args: ["-echo"], stdin: "inherit" }).output().catch(() => {});
    try {
      const buf = new Uint8Array(4096);
      const n = await Deno.stdin.read(buf);
      return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
    } finally {
      await new Deno.Command("stty", { args: ["echo"], stdin: "inherit" }).output().catch(() => {});
      console.log();
    }
  }
  return (await new Response(Deno.stdin.readable).text()).trim();
}

/** Pure: the one request that says whether a secret opens an account — where, and the header that
 *  carries it — or null for a service with no such check. A path is on the account's address; a
 *  full URL is the service's own API (Supabase: a personal access token is not tied to an address). */
export function probeRequest(
  a: Pick<Account, "service" | "url">,
  secret: string,
): { url: string; header: string } | null {
  const probes: Record<string, { path: string; header: string }> = {
    coolify: { path: "/api/v1/version", header: `Authorization: Bearer ${secret}` },
    n8n: { path: "/api/v1/workflows?limit=1", header: `X-N8N-API-KEY: ${secret}` },
    brain: { path: "/api/tasks", header: `Authorization: Bearer ${secret}` },
    gitea: { path: "/api/v1/user", header: `Authorization: token ${secret}` },
    supabase: { path: "https://api.supabase.com/v1/projects", header: `Authorization: Bearer ${secret}` },
  };
  const p = probes[a.service];
  if (!p) return null;
  if (/^https:\/\//.test(p.path)) return { url: p.path, header: p.header };
  return a.url ? { url: `${a.url.replace(/\/+$/, "")}${p.path}`, header: p.header } : null;
}

/** Does this secret open this account? One authenticated request, the secret passed to curl as a
 *  header file on stdin, never on its command line. `checked` false: nothing to try it against. */
export async function probeAccount(
  a: Account,
  secret: string,
): Promise<{ ok: boolean; detail: string; checked?: boolean }> {
  const p = probeRequest(a, secret);
  if (!p) return { ok: true, detail: "no check for this service", checked: false };
  const child = new Deno.Command("curl", {
    args: ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "-H", "@-", p.url],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(p.header + "\n"));
  await w.close();
  const code = new TextDecoder().decode((await child.output()).stdout).trim();
  return { ok: code.startsWith("2"), detail: `HTTP ${code || "unreachable"}` };
}

export async function vaultCommand(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  try {
    switch (sub) {
      case "init": {
        const code = await initVault();
        console.log(`${ANSI.b}vault created${ANSI.x} in ${vaultDir()}, key in this machine's keyring.\n`);
        console.log(`Recovery code — keep it somewhere safe outside this machine (KeePassXC, paper):\n\n  ${code}\n`);
        console.log("Another machine joins with `agents vault pair` and this code.");
        return 0;
      }
      case "pair": {
        await pairVault(await readStdin("recovery code: "));
        console.log("paired: this machine opens the vault");
        return 0;
      }
      case "recovery-code": {
        console.log(await currentRecoveryCode());
        return 0;
      }
      case "status": {
        const key = await loadKey().catch((e) => e as Error);
        console.log(`${ANSI.b}agents vault${ANSI.x} — ${vaultDir()}`);
        if (key instanceof Error) {
          console.log(`  ${ANSI.y}!${ANSI.x} ${key.message}`);
          return 1;
        }
        if (!(await keyMatches(key))) {
          console.log(`  ${ANSI.r}✗${ANSI.x} this machine's key does not open this vault`);
          return 1;
        }
        const l = await listSecrets(key);
        const accounts = loadAccounts(ACCOUNTS);
        for (const a of accounts) {
          if (a.auth === "oauth") {
            console.log(`  ${ANSI.d}· ${a.service}/${a.name} (signs in by itself, /mcp)${ANSI.x}`);
            continue;
          }
          const has = l.entries.some((e) => e.service === a.service && e.account === a.name);
          console.log(
            `  ${has ? `${ANSI.g}✓${ANSI.x}` : `${ANSI.y}!${ANSI.x}`} ${a.service}/${a.name}${
              has ? "" : "  no secret"
            }`,
          );
        }
        const orphans = l.entries.filter((e) => !accounts.some((a) => a.service === e.service && a.name === e.account));
        for (const e of orphans) {
          console.log(`  ${ANSI.d}· ${e.service}/${e.account} (secret with no account)${ANSI.x}`);
        }
        if (l.unreadable) console.log(`  ${ANSI.r}✗${ANSI.x} ${l.unreadable} entries this key cannot open`);
        if (l.conflicts) {
          console.log(`  ${ANSI.y}!${ANSI.x} ${l.conflicts} Syncthing conflict copies in ${vaultDir()}/secrets`);
        }
        return 0;
      }
      case "set": {
        const [service, account, field = "token"] = rest;
        if (!service || !account) {
          console.error(
            "usage: agents vault set <service> <account> [field]   (the secret from stdin; field defaults to token)",
          );
          return 2;
        }
        await setSecret(
          service,
          account,
          await readStdin(`secret for ${service}/${account}${field === "token" ? "" : ` (${field})`}: `),
          field,
        );
        console.log(`stored ${service}/${account}${field === "token" ? "" : ` ${field}`}`);
        return 0;
      }
      case "delete": {
        const [service, account] = rest;
        if (!service || !account) {
          console.error("usage: agents vault delete <service> <account>");
          return 2;
        }
        console.log(
          await deleteSecret(service, account) ? `deleted ${service}/${account}` : `no secret ${service}/${account}`,
        );
        return 0;
      }
      case "run": {
        // a service's command-line tool with the account's token in its environment (toolrun.ts)
        const plan = parseRun(rest);
        const profile = profileFrom({
          profile: amEnv("PROFILE"),
          configDir: Deno.env.get("CLAUDE_CONFIG_DIR"),
        }, RUNTIME);
        const account = resolveAccount(
          visibleAccounts(loadAccounts(ACCOUNTS), plan.service, profile),
          plan.account,
          plan.service,
        );
        const secret = await getSecret(plan.service, account.name);
        if (!secret) {
          console.error(
            `no secret for ${plan.service}/${account.name} on this machine: console › Connections, or agents vault set ${plan.service} ${account.name}`,
          );
          return 1;
        }
        return await runTool({ ...plan, account: account.name }, secret);
      }
      default:
        console.error(
          "usage: agents vault [status|init|pair|recovery-code|set <service> <account>|delete <service> <account>|run <service> [account] -- <tool> …]",
        );
        return 2;
    }
  } catch (e) {
    if (e instanceof VaultError) {
      console.error(`vault: ${e.message}`);
      return 1;
    }
    if (sub === "run" && e instanceof Error) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}
