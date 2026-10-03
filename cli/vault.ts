// vault.ts — `claude-multi vault …`: the secret store from the terminal (the console does the same
// from Connections). The store itself is shared/mcp/lib/vault.ts, which the MCP servers use too.
//
// A secret is never an argument: it is read from stdin, so it does not land in the shell history or
// in `ps`. And nothing here prints one, except `recovery-code`, which prints the key on purpose.

import { ANSI, HOME, lstat, readText } from "./lib.ts";
import { ACCOUNTS } from "./mcp.ts";
import { type Account, loadAccounts } from "../shared/mcp/lib/accounts.ts";
import {
  currentRecoveryCode, deleteSecret, getSecret, initVault, keyMatches, listSecrets, loadKey, pairVault, setSecret, vaultDir, VaultError,
} from "../shared/mcp/lib/vault.ts";

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

/** Does this secret open this account? One authenticated request, the secret passed to curl as a
 *  header file on stdin, never on its command line. */
export async function probeAccount(a: Account, secret: string): Promise<{ ok: boolean; detail: string }> {
  const probes: Record<string, { path: string; header: string }> = {
    coolify: { path: "/api/v1/version", header: `Authorization: Bearer ${secret}` },
    n8n: { path: "/api/v1/workflows?limit=1", header: `X-N8N-API-KEY: ${secret}` },
    brain: { path: "/api/tasks", header: `Authorization: Bearer ${secret}` },
  };
  const p = probes[a.service];
  if (!p || !a.url) return { ok: true, detail: "no check for this service" };
  const child = new Deno.Command("curl", {
    args: ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "-H", "@-", `${a.url}${p.path}`],
    stdin: "piped", stdout: "piped", stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(p.header + "\n"));
  await w.close();
  const code = new TextDecoder().decode((await child.output()).stdout).trim();
  return { ok: code.startsWith("2"), detail: `HTTP ${code || "unreachable"}` };
}

/** The secrets claude-multi used before the vault, where they were. */
const LEGACY: { service: string; account: string; file: string; read: (text: string) => string | null }[] = [
  { service: "coolify", account: "ark", file: `${HOME}/.config/secrets/coolify-ark.token`, read: (t) => t.trim() || null },
  { service: "n8n", account: "ark", file: `${HOME}/.config/n8n-ark/.env`, read: (t) => t.match(/^N8N_API_KEY=["']?([^"'\n]+)/m)?.[1] ?? null },
];

/** Which of them are still there: presence only, their content is not read. */
export async function legacyFilesPresent(): Promise<string[]> {
  const out: string[] = [];
  for (const l of LEGACY) if (await lstat(l.file)) out.push(l.file);
  return out;
}

export async function vaultCommand(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  try {
    switch (sub) {
      case "init": {
        const code = await initVault();
        console.log(`${ANSI.b}vault created${ANSI.x} in ${vaultDir()}, key in this machine's keyring.\n`);
        console.log(`Recovery code — keep it somewhere safe outside this machine (KeePassXC, paper):\n\n  ${code}\n`);
        console.log("Another machine joins with `claude-multi vault pair` and this code.");
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
        console.log(`${ANSI.b}claude-multi vault${ANSI.x} — ${vaultDir()}`);
        if (key instanceof Error) { console.log(`  ${ANSI.y}!${ANSI.x} ${key.message}`); return 1; }
        if (!(await keyMatches(key))) { console.log(`  ${ANSI.r}✗${ANSI.x} this machine's key does not open this vault`); return 1; }
        const l = await listSecrets(key);
        const accounts = loadAccounts(ACCOUNTS);
        for (const a of accounts) {
          if (a.auth === "oauth") { console.log(`  ${ANSI.d}· ${a.service}/${a.name} (signs in by itself, /mcp)${ANSI.x}`); continue; }
          const has = l.entries.some((e) => e.service === a.service && e.account === a.name);
          console.log(`  ${has ? `${ANSI.g}✓${ANSI.x}` : `${ANSI.y}!${ANSI.x}`} ${a.service}/${a.name}${has ? "" : "  no secret"}`);
        }
        const orphans = l.entries.filter((e) => !accounts.some((a) => a.service === e.service && a.name === e.account));
        for (const e of orphans) console.log(`  ${ANSI.d}· ${e.service}/${e.account} (secret with no account)${ANSI.x}`);
        if (l.unreadable) console.log(`  ${ANSI.r}✗${ANSI.x} ${l.unreadable} entries this key cannot open`);
        if (l.conflicts) console.log(`  ${ANSI.y}!${ANSI.x} ${l.conflicts} Syncthing conflict copies in ${vaultDir()}/secrets`);
        return 0;
      }
      case "set": {
        const [service, account, field = "token"] = rest;
        if (!service || !account) { console.error("usage: claude-multi vault set <service> <account> [field]   (the secret from stdin; field defaults to token)"); return 2; }
        await setSecret(service, account, await readStdin(`secret for ${service}/${account}${field === "token" ? "" : ` (${field})`}: `), field);
        console.log(`stored ${service}/${account}${field === "token" ? "" : ` ${field}`}`);
        return 0;
      }
      case "delete": {
        const [service, account] = rest;
        if (!service || !account) { console.error("usage: claude-multi vault delete <service> <account>"); return 2; }
        console.log(await deleteSecret(service, account) ? `deleted ${service}/${account}` : `no secret ${service}/${account}`);
        return 0;
      }
      case "import-legacy": {
        // import, check that the secret really opens its account, and only then remove the old file
        const accounts = loadAccounts(ACCOUNTS);
        let failed = 0;
        for (const l of LEGACY) {
          const text = await readText(l.file);
          if (text === null) { console.log(`  ${ANSI.d}· ${l.file}: not here${ANSI.x}`); continue; }
          const secret = l.read(text);
          const account = accounts.find((a) => a.service === l.service && a.name === l.account);
          if (!secret || !account) { console.log(`  ${ANSI.r}✗${ANSI.x} ${l.file}: nothing to import`); failed++; continue; }
          const probe = await probeAccount(account, secret);
          if (!probe.ok) { console.log(`  ${ANSI.r}✗${ANSI.x} ${l.service}/${l.account}: the old secret does not work (${probe.detail}); file kept`); failed++; continue; }
          await setSecret(l.service, l.account, secret);
          if ((await getSecret(l.service, l.account)) !== secret) { console.log(`  ${ANSI.r}✗${ANSI.x} ${l.service}/${l.account}: read-back mismatch; file kept`); failed++; continue; }
          await Deno.remove(l.file);
          console.log(`  ${ANSI.g}✓${ANSI.x} ${l.service}/${l.account} imported (${probe.detail}), ${l.file} removed`);
        }
        return failed ? 1 : 0;
      }
      default:
        console.error("usage: claude-multi vault [status|init|pair|recovery-code|set <service> <account>|delete <service> <account>|import-legacy]");
        return 2;
    }
  } catch (e) {
    if (e instanceof VaultError) { console.error(`vault: ${e.message}`); return 1; }
    throw e;
  }
}
