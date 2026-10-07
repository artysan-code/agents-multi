// logo.tsx — a service's mark: its path from logos.ts as an <svg>, or its initial when it has none.

import { LOGOS } from "./logos.ts";

/** The services' display names; a service not here shows as it is called. */
export const SVC_NAMES: Record<string, string> = {
  n8n: "n8n",
  google: "Google",
  cloudflare: "Cloudflare",
  supabase: "Supabase",
  lovable: "Lovable",
  railway: "Railway",
  zapier: "Zapier",
  gitea: "Gitea · Forgejo",
  coolify: "Coolify",
  "syncthing-status": "Syncthing",
  brain: "Brain",
};
export const svcName = (s: string): string => SVC_NAMES[s] ?? s;

export function Logo({ service }: { service: string }) {
  const d = LOGOS[service];
  return (
    <span class="svc-logo">
      {d
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>
        : svcName(service).slice(0, 1).toUpperCase()}
    </span>
  );
}
