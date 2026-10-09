#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
// site.ts — agents-multi's site on its own, without the brain: the same files and privacy notice the
// brain serves on the site's address (public.ts), from a process that holds no account and no
// database. It runs from the brain's image with another command, so the site (and the update
// manifests in it) can be redeployed without restarting the brain, and the brain without the site.
//
//   BRAIN_SITE_URL   the site's address (required)
//   BRAIN_URL        the brain's address, for the links to it and the notice (required)
//   BRAIN_UPDATES_URL where the update manifests are read at a request (manifests.ts), the folder of
//                    stable.json and beta.json on `release`; unset, the copy built into the image
//   BRAIN_OPERATOR, BRAIN_CONTACT, BRAIN_HOSTING, PORT, HOST: as for the brain

import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { loadSite, type Site, siteAnswer, siteSize } from "./public.ts";
import { log, logRequest } from "./log.ts";
import { liveManifests } from "./manifests.ts";
import { hardened } from "./guard.ts";
import { owner } from "../../shared/mcp/lib/owner.ts";

const env = (k: string, d?: string) => Deno.env.get(k) || d;
const trim = (s: string) => s.replace(/\/+$/, "");
const SITE: Site = {
  url: trim(env("BRAIN_URL", "")!),
  siteUrl: trim(env("BRAIN_SITE_URL", "")!),
  operator: env("BRAIN_OPERATOR", owner().name)!,
  contact: env("BRAIN_CONTACT", "")!,
  hosting: env("BRAIN_HOSTING", "un server privato")!,
};
for (const [k, v] of [["BRAIN_URL", SITE.url], ["BRAIN_SITE_URL", SITE.siteUrl]]) {
  if (!v) {
    log.error(`${k} is required`);
    Deno.exit(1);
  }
}
const HTTPS = SITE.siteUrl.startsWith("https:");
const FILES = await loadSite(env("BRAIN_SITE", fromFileUrl(new URL("../site/dist", import.meta.url)))!, SITE);
log.info("site loaded", { files: FILES.size, bytes: siteSize(FILES) });
const UPDATES = env("BRAIN_UPDATES_URL");
const live = UPDATES ? liveManifests(UPDATES) : null;

const server = Deno.serve(
  { port: Number(env("PORT", "8080")), hostname: env("HOST", "0.0.0.0") },
  async (req) => {
    const t0 = performance.now();
    const p = new URL(req.url).pathname;
    // the files are in memory from the start: answering is being ready
    const r = p === "/health" || p === "/ready"
      ? Response.json({ ok: true })
      : (await live?.(p, req.method)) ?? siteAnswer(FILES, SITE, req);
    logRequest(log, req, r.status, performance.now() - t0, "-");
    return hardened(r, HTTPS);
  },
);
for (const s of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(s, async () => {
    await server.shutdown();
    Deno.exit(0);
  });
}
log.info("listening", { site: SITE.siteUrl, brain: SITE.url });
