// owner.ts — whose setup this is: the person the tasks belong to by default, the name the prompts
// use, the language Claude answers in. Read from the person's configuration
// (~/.agents-multi/config/owner.json) on a machine, and from the environment where there is no
// such file (the brain service: CLAUDE_MULTI_OWNER_ID, CLAUDE_MULTI_OWNER_NAME, CLAUDE_MULTI_LANGUAGE),
// which also wins over the file.
//
//   { "id": "alice", "name": "Alice", "language": "English" }
//
// `id` is what a task's `owner` says when it is this person's to do: it is written into the task
// files, so it does not change once tasks exist.

import { amEnv } from "./env.ts";

export interface Owner {
  id: string;
  name: string;
  language: string;
}

const DEFAULT: Owner = { id: "me", name: "the user", language: "English" };

/** Where the person's configuration is: ~/.agents-multi/config, a link to their own folder. */
export function configDir(): string {
  const env = (k: string) => {
    try {
      return Deno.env.get(k);
    } catch {
      return undefined;
    }
  };
  return amEnv("CONFIG") ?? `${env("HOME") ?? ""}/.agents-multi/config`;
}

/** Pure: an owner from what a file or the environment gives, the rest from the defaults. */
export function ownerFrom(o: Partial<Owner> | null | undefined): Owner {
  const pick = (v: unknown, d: string) => typeof v === "string" && v.trim() ? v.trim() : d;
  return {
    id: pick(o?.id, DEFAULT.id).toLowerCase(),
    name: pick(o?.name, DEFAULT.name),
    language: pick(o?.language, DEFAULT.language),
  };
}

/** A process that serves several people (the brain service) says whose request this is: the owner
 *  is then that person, whatever the environment or the file say. */
let current: (() => Owner | null) | null = null;
export function useOwner(fn: () => Owner | null) {
  current = fn;
}

/** This setup's owner: the person of the request when a process serves several, then the
 *  variables (a test), then the file, then the defaults. Read on every call: a small file, and a
 *  change shows without a restart. */
export function owner(): Owner {
  const now = current?.();
  if (now) return now;
  let file: Partial<Owner> | null = null;
  try {
    file = JSON.parse(Deno.readTextFileSync(`${configDir()}/owner.json`));
  } catch { /* no file, or not readable here */ }
  return ownerFrom({
    id: amEnv("OWNER_ID") || file?.id,
    name: amEnv("OWNER_NAME") || file?.name,
    language: amEnv("LANGUAGE") || file?.language,
  });
}
