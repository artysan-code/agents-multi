// Tests for cli/login.ts: what counts as a login to do again, and how a probe's output is read.
import { assertEquals } from "jsr:@std/assert@1";
import { isLoginError, probeVerdict } from "../login.ts";

Deno.test("isLoginError: an expired or missing login, not any error", () => {
  assertEquals(isLoginError("Failed to authenticate: OAuth session expired and could not be refreshed"), true);
  assertEquals(isLoginError("Error: not logged in"), true);
  assertEquals(isLoginError("Invalid API key · Please run /login"), true);
  assertEquals(isLoginError("API Error: 529 Overloaded"), false);
  assertEquals(isLoginError("exit 1"), false);
});

Deno.test("probeVerdict: the result's is_error decides; without JSON, the exit code and stderr", () => {
  assertEquals(probeVerdict(0, JSON.stringify({ type: "result", is_error: false, result: "ok" }), ""), { ok: true });
  assertEquals(probeVerdict(0, JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate" }), ""), { ok: false, error: "Failed to authenticate" });
  assertEquals(probeVerdict(1, "", "warning\nError: not logged in\n"), { ok: false, error: "Error: not logged in" });
  assertEquals(probeVerdict(0, "", ""), { ok: true });
});
