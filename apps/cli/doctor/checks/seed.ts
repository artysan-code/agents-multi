// seed.ts — the env files sealed in the vault for a node (agents node seed, ADR 0014, slice A): no entry names a
// machine the service does not know, and no client's entry is older than 90 days.

import { getSecret, listSecrets, loadKey } from "../../../../shared/mcp/lib/vault.ts";
import { type Check } from "../../lib/output.ts";
import { parseSeedEntry, SEED, type SeedEntry, seedFindings } from "../../node/seed.ts";
import { fleet, service } from "../../node/service.ts";
import { checkList } from "../context.ts";

/** The vault's seeds, checked against the machines the service knows (when it answers). */
export async function seedChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  const key = await loadKey().catch(() => null);
  if (!key) return c; // no vault here: the vault's own checks say so
  const metas = (await listSecrets(key).catch(() => ({ entries: [] }))).entries.filter((e) =>
    e.service === SEED.service
  );
  if (!metas.length) return c;
  const entries: { account: string; entry: SeedEntry }[] = [];
  for (const m of metas) {
    const entry = parseSeedEntry(await getSecret(SEED.service, m.account, SEED.field, key).catch(() => null));
    if (entry) entries.push({ account: m.account, entry });
    else add("node.seed", "warn", `seed of ${m.account} is not readable`, `agents node seed --forget ${m.account}`);
  }
  const svc = await service().catch(() => null);
  const known = svc && typeof svc !== "string"
    ? await fleet(svc).then((f) => f.nodes.map((n) => n.name), () => null)
    : null;
  for (const f of seedFindings(entries, known, Date.now())) {
    add(
      "node.seed",
      f.status,
      f.msg,
      f.status === "warn" ? "agents node seed <machine> again, or --forget <repo>" : undefined,
    );
  }
  return c;
}
