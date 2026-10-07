// Tests for apps/cli/toolrun.ts: which commands reach the tool with the token, which need a person, the
// profile a command runs in, and the filter that keeps the token out of the output.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { hiding, parseRun, profileFrom, wranglerDestructive } from "../toolrun.ts";
import { HIDDEN } from "../../../shared/mcp/lib/mask.ts";

Deno.test("parseRun: only the service's own tool, never its login", () => {
  const p = parseRun(["cloudflare", "--", "wrangler", "deploy", "--env", "prod"]);
  assertEquals([p.service, p.account, p.runner.tool, p.args], ["cloudflare", undefined, "wrangler", [
    "deploy",
    "--env",
    "prod",
  ]]);
  assertEquals(parseRun(["cloudflare", "main", "--", "wrangler", "tail"]).account, "main");
  assertThrows(() => parseRun(["cloudflare", "--", "env"]), Error, "only to wrangler");
  assertThrows(() => parseRun(["cloudflare", "--", "pnpm", "wrangler", "deploy"]), Error, "only to wrangler");
  assertThrows(() => parseRun(["cloudflare", "--", "wrangler", "login"]), Error, "vault");
  assertThrows(() => parseRun(["github", "--", "gh"]), Error, "no command-line tool");
  assertThrows(() => parseRun(["cloudflare", "wrangler", "deploy"]), Error, "usage");
  assertThrows(() => parseRun(["cloudflare", "a", "b", "--", "wrangler"]), Error, "usage");
});

Deno.test("wranglerDestructive: deletions, rollbacks, remote migrations and destructive SQL need a person", () => {
  const none = () => null;
  const w = (s: string, read: (p: string) => string | null = none) => wranglerDestructive(s.split(" "), read);
  assertEquals(w("deploy"), null);
  assertEquals(w("tail my-worker"), null);
  assertEquals(w("d1 execute db --remote --command select * from t"), null);
  assertEquals(w("d1 execute db --local --command drop table t"), null);
  assertEquals(w("d1 migrations apply db --local"), null);
  assertEquals(typeof w("delete my-worker"), "string");
  assertEquals(typeof w("kv key delete k --namespace-id x"), "string");
  assertEquals(typeof w("r2 object delete b/o"), "string");
  assertEquals(typeof w("secret delete API_KEY"), "string");
  assertEquals(typeof w("rollback"), "string");
  assertEquals(typeof w("versions rollback"), "string");
  assertEquals(typeof w("d1 migrations apply db --remote"), "string");
  assertEquals(
    typeof wranglerDestructive(["d1", "execute", "db", "--remote", "--command", "DELETE FROM t"], none),
    "string",
  );
  assertEquals(
    typeof wranglerDestructive(["d1", "execute", "db", "--remote", "--command=drop table t"], none),
    "string",
  );
  assertEquals(
    typeof wranglerDestructive(["d1", "execute", "db", "--remote", "--file", "x.sql"], () => "ALTER TABLE t ADD c"),
    "string",
  );
  assertEquals(
    wranglerDestructive(["d1", "execute", "db", "--remote", "--file", "x.sql"], () => "insert into t values (1)"),
    null,
  );
});

Deno.test("profileFrom: the server's profile, else the Claude configuration directory under the runtime", () => {
  assertEquals(
    profileFrom({ profile: "work", configDir: "/h/.claude-multi/personal" }, "/h/.claude-multi"),
    "work",
  );
  assertEquals(profileFrom({ configDir: "/h/.claude-multi/personal/" }, "/h/.claude-multi"), "personal");
  assertEquals(profileFrom({ configDir: "/h/.claude" }, "/h/.claude-multi"), undefined);
  assertEquals(profileFrom({}, "/h/.claude-multi"), undefined);
  // the runtime moved: a session started before still names the old folder, and the other way round
  assertEquals(profileFrom({ configDir: "/h/.claude-multi/personal" }, "/h/.agents-multi"), "personal");
  assertEquals(profileFrom({ configDir: "/h/.agents-multi/work" }, "/h/.claude-multi"), "work");
  assertEquals(profileFrom({ configDir: "/h/other/personal" }, "/h/.agents-multi"), undefined);
});

Deno.test("hiding: the token is replaced even when split across chunks", async () => {
  const secret = "tok_ABCDEFGHIJ";
  const enc = new TextEncoder();
  const parts = ["Authorization: Bearer tok_ABC", "DEFGHIJ and again ", "tok_ABCDEFGHIJ", " end"];
  const out = await new Response(ReadableStream.from(parts.map((p) => enc.encode(p))).pipeThrough(hiding(secret)))
    .text();
  assertEquals(out, `Authorization: Bearer ${HIDDEN} and again ${HIDDEN} end`);
  assertEquals(
    await new Response(ReadableStream.from([enc.encode("tok_")]).pipeThrough(hiding(secret))).text(),
    "tok_",
  );
});
