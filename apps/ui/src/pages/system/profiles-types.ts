// profiles-types.ts — the part of a profile's report the Overview and Profiles tabs read beyond what
// api.ts declares: its manifest and what is mounted from the shared set.

import type { ProfileView, StatusView } from "../../api.ts";

export interface Manifest {
  description?: string;
  command?: string;
  alias?: string;
  desktopDir?: string;
  disableAccountMcp?: boolean;
}

export interface ProfileFull extends ProfileView {
  manifest: Manifest;
  mounted: {
    skills: Record<string, unknown>;
    agents: Record<string, unknown>;
    commands: Record<string, unknown>;
  };
}

export const profilesOf = (s: StatusView): [string, ProfileFull][] =>
  Object.entries(s.profiles) as [string, ProfileFull][];

/** The MCP servers the shared registry offers, by name. */
export const registryOf = (s: StatusView): string[] =>
  Object.keys((s.shared.mcpRegistry ?? {}) as Record<string, unknown>);
