// profiles.ts — Every declared profile (links, manifest, settings, credentials, leftovers) and orphan runtime directories.

import { listDir, mode, stat } from "../../lib/fs.ts";
import { PROFILES, RUNTIME, shortHome } from "../../lib/paths.ts";
import { commandOf, KINDS, ownItems, profileInfo, runtimeProfiles } from "../../lib/profiles.ts";
import { settingsState } from "../../settings.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";
import { userStep, verifyStep } from "../repair.ts";

/** Every declared profile (links, manifest, settings, credentials, leftovers) and orphan runtime directories. */
export async function profileChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m, declared, inv } = ctx;
  // --- profiles: base symlinks, manifest, credentials, leftovers
  // A skill a profile owns must not appear in another profile: that is how client work leaks into a
  // personal session. Derived from the manifests, so it holds for any profile you add.
  const ownedElsewhere = new Map<string, string>();
  for (const p of declared) for (const s of await ownItems(p, "skills")) ownedElsewhere.set(s, p);

  for (const p of declared) {
    const info = await profileInfo(p);
    if (!info.exists) {
      add(`profile.${p}`, "fail", `profile ${p} is not materialised`, "agents-multi install");
      continue;
    }
    if (info.claudeMd !== `${PROFILES}/${p}/CLAUDE.md`) {
      add(
        `profile.${p}.claudemd`,
        "fail",
        `${p}/CLAUDE.md does not point at the configuration`,
        "agents-multi install",
      );
    }
    const set = await settingsState(p);
    const list = (xs: string[]) => xs.slice(0, 4).join(", ") + (xs.length > 4 ? ` +${xs.length - 4}` : "");
    if (set.kind === "symlink" || set.kind === "missing") {
      add(
        `profile.${p}.settings`,
        "fail",
        `${p}/settings.json is ${set.kind === "symlink" ? "still a link to shared/: it is generated now" : "missing"}`,
        "agents-multi install",
      );
    } else if (set.kind === "local-writes") {
      add(
        `profile.${p}.settings`,
        "warn",
        `${p}: Claude changed settings.json (${list(set.changed)}), not yet adopted into profiles/${p}/settings.json`,
        "agents-multi settings (or just launch Claude)",
      );
    } else if (set.kind === "stale") {
      add(
        `profile.${p}.settings`,
        "warn",
        `${p}/settings.json is behind its sources (${list(set.changed)})`,
        "agents-multi settings (or just launch Claude)",
      );
    }
    if (info.hooks !== "../shared/hooks") {
      add(`profile.${p}.hooks`, "fail", `${p}/hooks → ${info.hooks ?? "not a symlink"}`, "agents-multi install");
    }

    for (const k of KINDS) {
      const spec = info.manifest[k];
      const own = await ownItems(p, k);
      // Claude Code writes into these directories (the account skill sync, agents and commands it
      // creates): a symlink to shared/ would hand it the repository. They are real directories now.
      if (info.kindLinks[k]) {
        add(
          `profile.${p}.${k}`,
          "fail",
          `${p}/${k} is a symlink (→ ${info.kindLinks[k]}): it must be a real directory, Claude Code writes here`,
          "agents-multi install",
        );
        continue;
      }
      // "all" means every valid item of the kind: a broken entry in shared/ is not mounted anywhere,
      // so it is not "missing" from a profile either — it is reported once, against shared.
      const expected = new Set([
        ...(spec === "all" ? Object.keys(inv[k]).filter((n) => !inv[k][n].broken) : spec),
        ...own.map((n) => n.replace(/\.md$/, "")),
      ]);
      const actual = new Set(Object.keys(info.mounted[k]));
      const missing = [...expected].filter((n) => !actual.has(n));
      const extra = [...actual].filter((n) => !expected.has(n));
      const broken = Object.entries(info.mounted[k]).filter(([, v]) => v.broken).map(([n]) => n);
      if (missing.length) {
        add(`profile.${p}.${k}.missing`, "fail", `${p}/${k}: missing ${missing.join(", ")}`, "agents-multi install");
      }
      if (extra.length) {
        add(
          `profile.${p}.${k}.extra`,
          "warn",
          `${p}/${k}: mounted outside the manifest: ${extra.join(", ")}`,
          `add them to profiles/${p}/profile.json, or remove the links`,
        );
      }
      if (broken.length) {
        add(
          `profile.${p}.${k}.broken`,
          "fail",
          `${p}/${k}: broken links: ${broken.join(", ")}`,
          "agents-multi install",
        );
      }
    }

    const leak = Object.keys(info.mounted.skills).filter((s) => (ownedElsewhere.get(s) ?? p) !== p);
    if (leak.length) {
      add(
        `profile.${p}.leak`,
        "fail",
        `${p} mounts skills owned by another profile: ${leak.map((s) => `${s} (${ownedElsewhere.get(s)})`).join(", ")}`,
        "agents-multi install",
      );
    }

    if (info.brokenPlugins.length) {
      add(
        `profile.${p}.plugins`,
        "fail",
        `${p}: installed plugins whose files are gone (they fail to load): ${info.brokenPlugins.join(", ")}`,
        "console → Plugins: Remove, then install again (or claude plugin install <id> in that profile)",
      );
    }
    if (info.stalePlugins.length) {
      add(
        `profile.${p}.plugins.stale`,
        "warn",
        `${p}: plugin records for projects that no longer exist (they load nowhere): ${
          info.stalePlugins.map((s) => `${s.id} (${s.scope}, ${shortHome(s.project)})`).join(", ")
        }`,
        `claude plugin uninstall <id> --scope <scope> reaches them only from inside the project: drop those records from ${
          shortHome(info.dir)
        }/plugins/installed_plugins.json (keep a copy)`,
      );
    }
    const cmd = info.manifest.command;
    if (!info.credentials.present) {
      add(`profile.${p}.login`, "warn", `${p}: no stored credentials, sign-in needed`, `${cmd ?? "claude"} → /login`, [
        userStep(`Open a terminal, run ${commandOf(p, info.manifest)}, then type /login and finish the sign-in`),
        verifyStep,
      ]);
    } else if (info.credentials.mode !== "600") {
      add(
        `profile.${p}.creds`,
        "fail",
        `${p}/.credentials.json mode ${info.credentials.mode}`,
        `chmod 600 ${info.dir}/.credentials.json`,
      );
    }
    // .claude.json.backup is Claude Code's own: it rewrites it with every .claude.json, so removing it
    // is pointless. It holds the account, so it must stay private to this user.
    const own = ".claude.json.backup";
    const junk = (await listDir(info.dir)).filter((f) =>
      f !== own && /\.(bak|backup|pre-|tmp\.)/.test(f) && /credentials|claude\.json|settings/.test(f)
    );
    const ownMode = mode(await stat(`${info.dir}/${own}`));
    if (ownMode && ownMode !== "600") {
      add(
        `profile.${p}.backup`,
        "fail",
        `${p}/${own} mode ${ownMode}: Claude Code's copy of the account, readable by others`,
        `chmod 600 ${info.dir}/${own}`,
      );
    }
    if (junk.length) {
      add(
        `profile.${p}.junk`,
        "fail",
        `backups holding tokens or an account in the profile: ${junk.join(", ")}`,
        `rm ${junk.map((f) => `${info.dir}/${f}`).join(" ")}`,
      );
    }
    add(
      `profile.${p}`,
      "ok",
      `${p}: ${info.account ?? "no account"} · ${
        Object.keys(info.mounted.skills).length
      } skills · mcp cli ${info.mcp.length}${
        m.desktopVersion ? ` / desktop ${info.mcpDesktop.length}` : ""
      } · ${info.plugins.length} plugins${
        info.manifest.disableAccountMcp
          ? ` · account MCP off (connectors + ${info.synced.length} synced plugin${
            info.synced.length === 1 ? "" : "s"
          })`
          : ""
      }`,
    );
  }

  // A runtime directory the repository no longer declares keeps its credentials and transcripts
  // around while nothing manages it any more.
  const orphans = (await runtimeProfiles()).filter((p) => !declared.includes(p));
  if (orphans.length) {
    add(
      "profile.orphan",
      "warn",
      `runtime directories with no profile in the repository: ${orphans.join(", ")}`,
      `add profiles/<name>/profile.json, or remove ${orphans.map((p) => `${shortHome(RUNTIME)}/${p}`).join(" ")}`,
    );
  }
  return c;
}
