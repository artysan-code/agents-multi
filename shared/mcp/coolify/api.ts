// coolify — the HTTP layer and the resolvers shared by every group of tools (see server.ts).
import { z } from "npm:zod@4.6.5";
import { CREDENTIALS_IN_URL, maskText, SECRET_NAME } from "../lib/mask.ts";
import { service } from "../lib/service.ts";

export const coolify = service("coolify");

/**
 * Calls the Coolify REST API (`/api/v1` + `path`) with the account's token.
 * Returns the parsed JSON body, or the raw text when the body is not JSON.
 * Throws on a non-2xx status, with the path (query stripped) and the masked start of the body.
 */
export async function api(account: string | undefined, path: string, init?: RequestInit): Promise<unknown> {
  // a `..` built from a tool argument would reach another endpoint: fetch normalises it away
  if (/(^|\/)\.\.?(\/|\?|$)/.test(path)) throw new Error(`refused path ${path.split("?")[0]}`);
  const { account: a, secret } = await coolify.use(account);
  const r = await fetch(`${a.url}/api/v1${path}`, {
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await r.text();
  if (!r.ok) {
    const route = path.split("?")[0];
    if (r.status === 404 && isOptionalRoute(route)) {
      throw new Error(`${route} → this endpoint is not available on this Coolify (older version? see coolify_version)`);
    }
    throw new Error(`${route} → HTTP ${r.status}: ${maskText(body.slice(0, 400))}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
/** Pure: routes that only exist on recent Coolify versions, where a 404 means "not there", not "no such resource". */
export function isOptionalRoute(route: string): boolean {
  return /\/(docker-cleanup|scheduled-tasks|s3-storages)(\/|$)/.test(route) ||
    /^\/databases\/[^/]+\/(envs|logs)(\/|$)/.test(route) || /^\/services\/[^/]+\/logs(\/|$)/.test(route);
}

/** Pure: the section of an overview for a list that failed to load, so an error never reads as "empty". */
export const unavailable = (e: unknown) => `unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;

/** Pure: base64 of a text's UTF-8 bytes, in chunks (a spread of a large file overflows the stack). */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const post = (account: string | undefined, path: string, body?: unknown) =>
  api(account, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const patch = (account: string | undefined, path: string, body: unknown) =>
  api(account, path, { method: "PATCH", body: JSON.stringify(body) });

/** A deployment's identifier, as coolify_deploy returns it: one path segment, nothing else. */
export const deploymentId = z.string().regex(/^[\w-]+$/, "a deployment identifier");

// deno-lint-ignore no-explicit-any -- Coolify responses have no schema that is stable across versions
export type Loose = any;
export type Kind = "application" | "service" | "database";
export const API_PATH: Record<Kind, string> = {
  application: "/applications",
  service: "/services",
  database: "/databases",
};

/**
 * Pure: picks the resource that `ref` names among `all`: by uuid, then exact name (case-insensitive),
 * then name substring only when exactly one candidate has it. Several candidates throw, listing them.
 */
export function matchResource(all: Loose[], what: string, ref: string): Loose {
  const lower = ref.toLowerCase();
  const exact = all.find((a) => a.uuid === ref) ?? all.find((a) => String(a.name ?? "").toLowerCase() === lower);
  if (exact) return exact;
  const partial = all.filter((a) => String(a.name ?? "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const list = (xs: Loose[]) => xs.map((a) => `${a.name} (${a.uuid})`).join(", ");
  if (partial.length > 1) {
    throw new Error(`"${ref}" is ambiguous among ${what}s: ${list(partial)}. Use the uuid or the exact name`);
  }
  throw new Error(`no ${what} matches "${ref}". Available: ${list(all) || "none"}`);
}

/** Resolves a resource in the list at `listPath` (see matchResource). `what` names the resource type in errors. */
export async function find(account: string | undefined, listPath: string, what: string, ref: string): Promise<Loose> {
  return matchResource(await api(account, listPath) as Loose[], what, ref);
}
export const findApp = (account: string | undefined, ref: string) => find(account, "/applications", "application", ref);
export const findOfKind = (account: string | undefined, kind: Kind, ref: string) =>
  find(account, API_PATH[kind], kind, ref);

/** The server to create resources on: the instance's only one. Throws when there is not exactly one. */
export async function soleServer(account: string | undefined): Promise<Loose> {
  const servers = await api(account, "/servers") as Loose[];
  if (servers.length !== 1) throw new Error(`the server must be chosen: the instance has ${servers.length}`);
  return servers[0];
}

/**
 * Resolves a project and one of its environments (by name or uuid) to the identifiers that the
 * create endpoints require.
 */
export async function locate(account: string | undefined, project: string, environment = "production") {
  const p = await find(account, "/projects", "project", project);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Loose[];
  const e = envs.find((x) => x.uuid === environment || String(x.name).toLowerCase() === environment.toLowerCase());
  if (!e) {
    throw new Error(`no environment "${environment}" in ${p.name}. Available: ${envs.map((x) => x.name).join(", ")}`);
  }
  return { project_uuid: p.uuid, environment_name: e.name, environment_uuid: e.uuid, project: p.name };
}

/** Throws when a key/value pair to be written looks like a secret (reserved name or credentials in a URL). */
export function assertNotSecret(key: string, value: string) {
  if (SECRET_NAME.test(key) || CREDENTIALS_IN_URL.test(value)) {
    throw new Error(
      `"${key}" looks like a secret: set it from the Coolify panel. A secret passed through here ends up in the conversation context.`,
    );
  }
}

/** Throws when a free-text value (a command, labels) carries a secret: those belong in an environment variable. */
export function assertNoSecretInText(key: string, value: string) {
  if (maskText(value) !== value) {
    throw new Error(`"${key}" contains what looks like a secret: put it in an environment variable and reference that`);
  }
}

export const account = coolify.accountArg;
export const kindArg = z.enum(["application", "service", "database"]);
export const READS = { readOnlyHint: true, openWorldHint: true };
export const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
