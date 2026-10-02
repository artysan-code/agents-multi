// brain-backup.ts — `claude-multi brain-backup`: a copy of Samuel's brain on this machine, fetched
// only when the brain changed since the last one.
//
// claude-brain-backup.timer runs it every half hour while the machine is on (never a job at night:
// the machines are off then). It asks the brain what it is at (/backup/state); when that is what
// the last copy holds it stops there, otherwise it fetches the sealed copy (/backup), checks it
// opens with the backup key from the vault when the vault has one, and keeps the newest KEEP
// copies in DATA/brain-backups. The copies stay sealed on disk: reading one needs the key.

import { DATA, readJson, STATE } from "./lib.ts";
import { brainAccount } from "../shared/mcp/lib/brain-tasks.ts";
import { getSecret } from "../shared/mcp/lib/vault.ts";
import { open } from "../brain/backup.ts";
import { dayOf, hhmm } from "../shared/mcp/lib/tasks.ts";

export const BACKUPS = `${DATA}/brain-backups`;
const LAST = `${STATE}/brain-backup.json`;
const KEEP = 14;

export interface BackupState { version: string; file: string; at: string; verified: boolean; checked: string }

export function lastBackup(): Promise<BackupState | null> {
  return readJson<BackupState>(LAST);
}

/** Pure: the copies to delete, oldest first, so that `keep` remain. Names sort by time. */
export function toPrune(names: string[], keep = KEEP): string[] {
  const own = names.filter((n) => /^brain-[\dT-]+\.brn$/.test(n)).sort();
  return own.slice(0, Math.max(0, own.length - keep));
}

export async function brainBackup(force = false): Promise<number> {
  const account = brainAccount();
  const token = account && await getSecret("brain", account.name).catch(() => null);
  if (!account?.url || !token) {
    console.error(account ? "no token for the brain on this machine (console, Connections)" : "no brain account in shared/mcp/accounts.json");
    return 1;
  }
  const base = account.url.replace(/\/+$/, "");
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  const last = await lastBackup();
  const now = new Date().toISOString();

  const st = await get("/backup/state");
  if (!st.ok) { console.error(`the brain answered ${st.status} on /backup/state`); await st.body?.cancel(); return 1; }
  const { version } = await st.json() as { version: string };
  if (!force && last?.version === version) {
    await Deno.writeTextFile(LAST, JSON.stringify({ ...last, checked: now }, null, 2) + "\n");
    console.log(`brain: already backed up (${last.file})`);
    return 0;
  }

  const r = await get("/backup");
  if (!r.ok) { console.error(`the brain answered ${r.status} on /backup`); await r.body?.cancel(); return 1; }
  const sealed = new Uint8Array(await r.arrayBuffer());
  if (new TextDecoder().decode(sealed.subarray(0, 4)) !== "BRN1") { console.error("the brain sent something that is not a backup"); return 1; }

  // opened with the key when there is one: a copy nobody can open is not a backup
  const key = await getSecret("brain", account.name, "backup-key").catch(() => null);
  let verified = false;
  if (key) {
    const plain = await open(sealed, key);
    if (new TextDecoder().decode(plain.subarray(0, 15)) !== "SQLite format 3") { console.error("the backup opens, but is not a database"); return 1; }
    verified = true;
  }

  await Deno.mkdir(BACKUPS, { recursive: true });
  const d = new Date(now), file = `brain-${dayOf(d)}T${hhmm(d).replace(":", "-")}.brn`; // local time, as Samuel reads it
  const tmp = `${BACKUPS}/.${file}.tmp`;
  await Deno.writeFile(tmp, sealed);
  await Deno.rename(tmp, `${BACKUPS}/${file}`);
  const names: string[] = [];
  for await (const e of Deno.readDir(BACKUPS)) if (e.isFile) names.push(e.name);
  for (const old of toPrune(names)) await Deno.remove(`${BACKUPS}/${old}`).catch(() => {});

  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(LAST, JSON.stringify({ version, file, at: now, verified, checked: now } satisfies BackupState, null, 2) + "\n");
  console.log(`brain: new copy ${file} (${(sealed.length / 1024).toFixed(0)} KB${verified ? ", opens with the key" : ", not checked: no backup-key in the vault"})`);
  return 0;
}
