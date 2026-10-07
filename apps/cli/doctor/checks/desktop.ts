// desktop.ts — Claude Desktop packaging, its per-profile variants and desktop entries.

import { listDir, lstat, readText, stat } from "../../lib/fs.ts";
import { HOME, LIB } from "../../lib/paths.ts";
import { loadManifest } from "../../lib/profiles.ts";
import { has, run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Claude Desktop packaging, its per-profile variants and desktop entries. */
export async function desktopChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m, declared } = ctx;
  // --- Claude Desktop: in user space since 2026-09-30 (bin/claude-desktop-update)
  if (m.desktopSystem) {
    add(
      "desktop.userspace",
      "warn",
      `Claude Desktop ${m.desktopSystem} is still the system package: it cannot update itself`,
      "claude-desktop-migrate (in a terminal, with every Claude Desktop closed)",
    );
  } else if (m.desktopVersion) {
    const shims = await run("pacman", ["-Q", "claude-desktop-shims"]);
    if (shims.code !== 0) {
      add(
        "desktop.shims",
        "warn",
        "claude-desktop-shims is not installed: the VM mode misses virtiofsd/OVMF and the runtime libraries are untracked",
        "claude-desktop-migrate",
      );
    }
  }
  if (m.desktopVersion) {
    // Desktop variants are built per profile; only profiles whose manifest names a dedicated
    // directory get one, so a machine with a single profile is not told anything is missing.
    for (const p of declared) {
      const manifest = await loadManifest(p);
      if (!manifest.desktopDir || manifest.desktopDir.endsWith("/Claude")) continue;
      const variant = `claude-desktop-${p}`;
      const bin = await lstat(`${LIB}/${variant}/${variant}`);
      const asar = await lstat(`${LIB}/${variant}/resources/app.asar`);
      // the variant is built from the version in use; a switch rebuilds it, so older means a failed rebuild
      const srcAsar = await stat(
        m.desktopSystem
          ? "/usr/lib/claude-desktop/resources/app.asar"
          : `${LIB}/claude-desktop/current/resources/app.asar`,
      );
      if (!bin || !asar) {
        add(`desktop.${p}`, "fail", `Claude Desktop variant for ${p} is missing`, `claude-desktop-rebuild ${p}`);
      } else if (srcAsar?.mtime && asar.mtime && srcAsar.mtime > asar.mtime) {
        add(
          `desktop.${p}`,
          "fail",
          `the ${p} variant is older than the Claude Desktop in use`,
          `claude-desktop-rebuild ${p}`,
        );
      } else add(`desktop.${p}`, "ok", `Claude Desktop ${m.desktopVersion} + ${p} variant in step`);
    }
    for (const d of await listDir(`${ctx.installed}/desktop`)) {
      if (!d.endsWith(".desktop")) continue;
      const source = await readText(`${ctx.installed}/desktop/${d}`) ?? "";
      const installed = await readText(`${HOME}/.local/share/applications/${d}`);
      if (!installed) {
        add(`desktop.entry.${d}`, "fail", `${d} is missing`, "agents install");
        continue;
      }
      // Only launchers go through claude-launch; other entries (the update GUI) legitimately do
      // not, so the requirement is read off the repository's own copy rather than assumed.
      if (source.includes("claude-launch") && !installed.includes("claude-launch")) {
        add(`desktop.entry.${d}`, "fail", `${d} does not go through claude-launch`, "agents install");
      }
    }
  }
  return c;
}

/** Claude Desktop update signature key and the url handler. */
export async function desktopPackagingChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  if (m.desktopVersion) {
    if (!(await lstat(`${ctx.installed}/pkg/claude-desktop/anthropic-apt.asc`))) {
      add(
        "desktop.apt-key",
        "warn",
        "the Anthropic apt key is not in the repository: the InRelease signature cannot be verified",
        "fetch the key into pkg/claude-desktop/anthropic-apt.asc",
      );
    } else if (!(await has("gpgv"))) {
      add("desktop.apt-key", "warn", "gpgv is missing: the apt repository signature is not verified", "install gnupg");
    } else {add(
        "desktop.apt-key",
        "ok",
        "Anthropic apt repository: key pinned, every update verified (InRelease → Packages → .deb)",
      );}
    const handler = await readText(`${HOME}/.local/share/applications/claude-code-url-handler.desktop`);
    if (handler && !handler.includes("claude-bin")) {
      add(
        "desktop.urlhandler",
        "fail",
        "the claude-cli:// url handler does not point at claude-bin",
        "agents install",
      );
    }
  }
  return c;
}
