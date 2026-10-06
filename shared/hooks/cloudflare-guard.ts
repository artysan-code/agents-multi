#!/usr/bin/env -S deno run --quiet --no-lock
// cloudflare-guard.ts — PreToolUse hook on Cloudflare's official MCP (`execute`).
//
// That server has one tool for everything: `execute` runs JavaScript that calls
// `cloudflare.request({ method, path, body })`, so a permission rule on the tool name cannot tell a
// read from a deletion. This hook reads the code instead:
//   only reads (GET/HEAD, or no method: GET is the default)  → allow, no question
//   any DELETE                                               → deny: deletions are done by hand
//   anything else (POST/PUT/PATCH, a method it cannot read)  → ask
// It reads text, not a parsed program: it stops mistakes, not code written to slip past it, which
// is why anything it is not sure about is a question. The token's scope stays the hard boundary.
// Registered by the registry (`_guard` on the cloudflare entry), generated into each profile's
// settings for that profile's cloudflare-<account> servers (cli/settings.ts).

export type Decision = { decision: "allow" | "ask" | "deny"; reason: string };

const READS = new Set(["GET", "HEAD"]);

/** Pure: what to do with one `execute` call, from its code. */
export function classify(code: string): Decision {
  if (/\bDELETE\b/i.test(code) || /\bdeletes?\s*:/i.test(code)) {
    return { decision: "deny", reason: "Cloudflare: deletions are done by hand, in the dashboard (cloudflare-guard)." };
  }
  // a read is let through only when every call can be read: request({ … }) with an object written
  // out, no spread, no computed key, no way around request() — anything else is a question
  const calls = (code.match(/\brequest\s*\(/g) ?? []).length;
  const readable = (code.match(/\brequest\s*\(\s*\{/g) ?? []).length;
  if (
    calls > readable ||
    /\.\.\.|\]\s*:|\bfetch\s*\(|Object\.assign|Reflect\.|\beval\s*\(|\bFunction\s*\(|globalThis/.test(code)
  ) {
    return {
      decision: "ask",
      reason: "Cloudflare: this call is built in a way the guard cannot read: check it before it runs.",
    };
  }
  const literal = [...code.matchAll(/\bmethod\s*:\s*(["'`])([A-Za-z]+)\1/g)].map((m) => m[2].toUpperCase());
  const mentions = (code.match(/\bmethod\b/g) ?? []).length;
  if (mentions > literal.length) {
    return {
      decision: "ask",
      reason: "Cloudflare: the HTTP method is computed, not written out: check what this call does.",
    };
  }
  const writes = [...new Set(literal.filter((m) => !READS.has(m)))];
  if (writes.length) {
    return { decision: "ask", reason: `Cloudflare: this call writes (${writes.join(", ")}): check it before it runs.` };
  }
  return { decision: "allow", reason: "Cloudflare: reads only." };
}

if (import.meta.main) {
  let d: Decision;
  try {
    const input = JSON.parse(await new Response(Deno.stdin.readable).text());
    const code = input?.tool_input?.code;
    d = typeof code === "string"
      ? classify(code)
      : { decision: "ask", reason: "Cloudflare: no code to read in this call." };
  } catch {
    d = { decision: "ask", reason: "Cloudflare: the guard could not read this call." };
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.decision,
        permissionDecisionReason: d.reason,
      },
    }),
  );
}
