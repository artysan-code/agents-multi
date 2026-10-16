// api.ts — the console's routes for Connections › Add a server (apps/cli/console/servers.ts): the code's preview,
// the owner's yes for the fingerprint they compared, and the server's row once paired.

import { get, post } from "../../api.ts";

export type Op<T> = ({ ok: true } & T) | { ok: false; message: string };

export interface ServerPreview {
  node: string;
  platform: string;
  asked: string;
  fingerprint: string;
}

export interface ServerState {
  known: boolean;
  online?: boolean;
  seen?: string;
  server?: boolean;
  gitKey?: string | null;
  waits?: string[];
  accounts?: string[];
  sandbox?: boolean | null;
}

export const claimServer = (code: string) => post<Op<ServerPreview>>("/api/servers/claim", { code });
export const confirmServer = (code: string, fingerprint: string) =>
  post<Op<{ node: string; sealed: boolean }>>("/api/servers/confirm", { code, fingerprint });
export const serverState = (name: string) =>
  get<Op<ServerState>>(`/api/servers/state?name=${encodeURIComponent(name)}`);
