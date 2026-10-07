// picker.ts — «Which Claude?», the profile picker (the page at /#pick, which the desktop app shows in a
// small window of its own): the profiles it lists, from their manifests, and opening one's Claude
// Desktop through claude-launch, which starts it or brings its window forward. The page only names a
// profile; one the manifests do not declare starts nothing.

import { launchers } from "../lib/profiles.ts";
import { reopen } from "./close-claude.ts";

/** GET /api/launch: every declared profile with its launcher, in profile order. */
export async function launchList() {
  return { profiles: (await launchers()).map(({ profile, command }) => ({ profile, command })) };
}

/** POST /api/launch `{ profile }`: opens that profile's Claude Desktop. */
export async function launchOne(
  body: unknown,
  start?: Parameters<typeof reopen>[1],
): Promise<{ ok: boolean; message?: string }> {
  const profile = (body as { profile?: unknown } | null)?.profile;
  if (typeof profile !== "string") return { ok: false, message: "no profile" };
  const started = await reopen([profile], start);
  return started.length ? { ok: true } : { ok: false, message: `unknown profile: ${profile}` };
}
