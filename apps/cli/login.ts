// login.ts — whether a profile's Claude Code login still works.
//
// `claude auth status` reads the local file only: it says "loggedIn" even when the token can no
// longer be refreshed. What tells is a request. Two ways, neither on a timer:
//   passive  the console's requests (ask, debrief) record a login failure of their profile here, and
//            clear it on the next success; the doctor reports what is recorded
//   active   `agents doctor --probe` sends each profile one tiny request (Haiku, no tools)

import { readJson } from "./lib/fs.ts";
import { BIN, HOME, STATE } from "./lib/paths.ts";

const FILE = `${STATE}/claude-login.json`;
interface LoginFailure {
  command: string;
  error: string;
  at: string;
}

/** Pure: whether an error of `claude -p` means its login has to be done again. */
export const isLoginError = (msg: string) =>
  /authenticat|not logged in|please run \/login|oauth|invalid api key|credentials/i.test(msg);

/** The failures recorded by the console's requests, per profile. */
export async function loginFailures(): Promise<Record<string, LoginFailure>> {
  return await readJson<Record<string, LoginFailure>>(FILE) ?? {};
}

/** A request of `profile` ended: a login failure is kept, a success clears it. */
export async function recordLogin(profile: string, command: string, error: string | null) {
  const all = await loginFailures();
  if (error && isLoginError(error)) all[profile] = { command, error, at: new Date().toISOString() };
  else if (!error && all[profile]) delete all[profile];
  else return;
  await Deno.mkdir(STATE, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(FILE, JSON.stringify(all, null, 1) + "\n").catch(() => {});
}

/** Pure: what a `claude -p --output-format json` run says about its login. */
export function probeVerdict(code: number, stdout: string, stderr: string): { ok: boolean; error?: string } {
  try {
    const r = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    if (r.is_error) return { ok: false, error: String(r.result ?? "error") };
    if (r.type === "result") return { ok: true };
  } catch { /* not JSON: look at the exit and stderr */ }
  return code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split("\n").pop() || `exit ${code}` };
}

/** One tiny request through a profile's launcher: does its login work? */
export async function probeLogin(command: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const out = await new Deno.Command(`${BIN}/${command}`, {
      args: ["-p", "ok", "--model", "haiku", "--output-format", "json", "--tools", "", "--max-turns", "1"],
      cwd: HOME,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(90_000),
    }).output();
    const dec = new TextDecoder();
    return probeVerdict(out.code, dec.decode(out.stdout), dec.decode(out.stderr));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
