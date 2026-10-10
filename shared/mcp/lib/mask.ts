// mask.ts — what an MCP server must not hand back. Masking is by default, not on request: a secret
// that reaches a tool result lands in the conversation's context, and from there it never leaves.

/** What a hidden value becomes. Tools that write whole objects back refuse any payload carrying
 *  it: a masked read edited and saved would otherwise replace the real secret with this text. */
export const HIDDEN = "‹hidden — look it up in the service's own panel›";

/** Names that almost certainly hold a secret. `auth`, `dsn`, `bearer` and `jwt` count as whole words
 *  (`x-auth`, `SENTRY_DSN`), so that `author` and `authority` do not. */
export const SECRET_NAME =
  /(^|[_-])(pass|passwd|pwd|pin|otp|totp|seed|salt|auth|dsn|bearer|jwt)($|[_-])|password|passphrase|secret|token|apikey|api_key|_key$|^key$|private|credential|authorization|cookie|signing|connection[_-]?string|session[_-]?id|access[_-]?key[_-]?id/i;

/** Secrets recognised by what they look like, wherever they sit: a JWT, a token with a well-known
 *  prefix (GitHub, OpenAI/Anthropic, Slack, AWS access key, GitLab), a `Bearer` credential. There is
 *  deliberately no rule for "a long hex string": git SHAs and UUIDs would all be covered. */
const SECRET_VALUE = new RegExp(
  [
    String.raw`\beyJ[\w-]+\.[\w-]+\.[\w-]+`,
    String.raw`\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-|xox[bp]-|AKIA|glpat-)[\w-]{10,}`,
    String.raw`\bBearer\s+\S+`,
  ].join("|"),
  "gi",
);

/** Pure: a text with every secret-looking value (SECRET_VALUE) replaced. */
export function maskValues(s: string): string {
  return s.replace(SECRET_VALUE, HIDDEN);
}
/** An address carrying credentials: `postgres://user:password@host/db`. */
export const CREDENTIALS_IN_URL = /:\/\/[^/@\s]+:[^/@\s]+@/;

/** One value, given the name it is stored under. The name alone is not enough either way:
 *  `DATABASE_URL` hides a password and `FIVETOOLS_URL` is a public address. Of an address with
 *  credentials only the user/password pair is covered: the rest is what you need to know. */
export function mask(name: string, value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (SECRET_NAME.test(name)) return HIDDEN;
  const text = CREDENTIALS_IN_URL.test(value) ? value.replace(CREDENTIALS_IN_URL, "://‹user›:‹password›@") : value;
  return maskValues(text);
}

/** A whole object, recursively: every field whose name looks secret is covered. */
export function maskDeep(v: unknown, name = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, name));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // name/value pairs (HTTP headers, query parameters): the secret is in `value`, its name in `name`
    if (typeof o.name === "string" && "value" in o && SECRET_NAME.test(o.name)) return { ...o, value: HIDDEN };
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map((
        [k, x],
      ) => [k, typeof x === "object" ? maskDeep(x, k) : mask(k, x)]),
    );
  }
  return mask(name, v);
}

/** Free text (logs, a compose file): `KEY=value` and `key: value` pairs whose name looks secret
 *  lose their value, and addresses lose their credentials. Line by line, the rest untouched. */
export function maskText(s: string): string {
  return s
    .replace(
      /(\b[\w.-]*(?:password|passwd|passphrase|secret|token|apikey|api_key|private_key|credential|totp|_pin)[\w.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      (_, k: string, v: string) => /^\$\{?\w+\}?$/.test(v) ? `${k}${v}` : `${k}${HIDDEN}`,
    ) // a ${VARIABLE} reference is not the secret
    .replace(
      // names that are secret as a whole word, not as a part of one (`author: Ada` stays)
      /(\b(?:[\w.-]*[_-])?(?:dsn|auth|bearer|jwt)(?:[_-][\w.-]*)?["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      (_, k: string, v: string) => /^\$\{?\w+\}?$/.test(v) ? `${k}${v}` : `${k}${HIDDEN}`,
    )
    .replace(
      /(\b[\w.-]*(?:connection_string|session_id|access_key_id)[\w.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      (_, k: string, v: string) => /^\$\{?\w+\}?$/.test(v) ? `${k}${v}` : `${k}${HIDDEN}`,
    )
    .replace(new RegExp(CREDENTIALS_IN_URL.source, "g"), "://‹user›:‹password›@")
    .replace(SECRET_VALUE, HIDDEN);
}
