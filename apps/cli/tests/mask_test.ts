// Tests for shared/mcp/lib/mask.ts: what an MCP server must not hand back.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { HIDDEN, mask, maskText, maskValues } from "../../../shared/mcp/lib/mask.ts";

Deno.test("mask: secret names hidden, credentials taken out of addresses, the rest as it is", () => {
  assertEquals(mask("DB_PASSWORD", "x"), HIDDEN);
  assertEquals(mask("DATABASE_URL", "postgres://u:p@db:5432/x"), "postgres://‹user›:‹password›@db:5432/x");
  assertEquals(mask("FIVETOOLS_URL", "https://5etools.example.com"), "https://5etools.example.com");
  // every way a secret has been named so far, including the one that once slipped through
  for (
    const k of [
      "BRAIN_PASSPHRASE",
      "BRAIN_TOTP_SECRET",
      "DB_PASS",
      "ADMIN_PWD",
      "WALLET_SEED",
      "PIN",
      "SIM_PIN",
      "HASH_SALT",
      "SIGNING_KEY",
      "OTP",
    ]
  ) {
    assertEquals(mask(k, "x"), HIDDEN, k);
  }
  for (const k of ["BRAIN_URL", "PORT", "BRAIN_EMBED_MODEL", "PASSENGER_COUNT", "SPINNER", "COMPASS"]) {
    assertEquals(mask(k, "x"), "x", k);
  }
});

Deno.test("maskText: pairs in logs and compose files, but not ${VARIABLE} references", () => {
  const log = 'starting\nPOSTGRES_PASSWORD=hunter2 ok\napi_key: "abc def"\nurl redis://default:s3cr3t@redis:6379\n';
  const out = maskText(log);
  assert(!out.includes("hunter2") && !out.includes("abc def") && !out.includes("s3cr3t"));
  assert(out.startsWith("starting\n"));
  assertEquals(maskText("- BRAIN_PASSPHRASE=${BRAIN_PASSPHRASE}"), "- BRAIN_PASSPHRASE=${BRAIN_PASSPHRASE}");
  assertEquals(maskText("- SERVICE_PASSWORD_DB: $SERVICE_PASSWORD_DB"), "- SERVICE_PASSWORD_DB: $SERVICE_PASSWORD_DB");
  assertEquals(maskText("nothing to hide"), "nothing to hide");
  assert(!maskText("BRAIN_PASSPHRASE=lunga-frase-segreta").includes("lunga-frase-segreta"));
});

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

Deno.test("mask: values that look like secrets are covered wherever they are", () => {
  for (
    const v of [
      JWT,
      "ghp_" + "a1B2c3D4e5F6g7H8i9J0",
      "github_pat_11ABCDEFG0abcdefghij_klmnop",
      "sk-proj-abcdefghijklmnop",
      "sk-ant-api03-abcdefghijklmnop",
      "xoxb-123456789012-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "glpat-abcdefghij1234567890",
      "Bearer abc.def-123",
    ]
  ) {
    assertEquals(mask("note", v), HIDDEN, v);
    assert(!String(mask("note", `see ${v} here`)).includes(v.split(" ").pop()!), v);
  }
  assertEquals(maskValues(`curl -H "Authorization: Bearer ${JWT}"`).includes("eyJ"), false);
  assert(!maskText(`header ${JWT} sent with ghp_${"x".repeat(20)}`).match(/eyJ|ghp_/));
});

Deno.test("mask: ordinary hex, UUIDs and words are left alone", () => {
  for (
    const v of [
      "5242d63a1b2c3d4e5f60718293a4b5c6d7e8f901", // a git SHA
      "0123456789abcdef0123456789abcdef",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301", // a UUID
      "task-management-handler",
      "risk-assessment-for-the-project",
      "https://example.com/a?b=1",
    ]
  ) {
    assertEquals(mask("note", v), v, v);
    assertEquals(maskText(v), v, v);
  }
});

Deno.test("mask: auth, dsn, jwt, bearer, session and connection names", () => {
  for (
    const k of [
      "SENTRY_DSN",
      "dsn",
      "CONNECTION_STRING",
      "connectionString",
      "x-auth",
      "AUTH",
      "bearer",
      "JWT",
      "id_jwt",
      "session_id",
      "sessionId",
      "AWS_ACCESS_KEY_ID",
      "accessKeyId",
    ]
  ) {
    assertEquals(mask(k, "x"), HIDDEN, k);
  }
  for (const k of ["author", "authority", "AUTHORS", "dsnote", "session", "idle"]) assertEquals(mask(k, "x"), "x", k);
  assertEquals(maskText("SENTRY_DSN=https://abc@o1.ingest.sentry.io/1"), `SENTRY_DSN=${HIDDEN}`);
  assertEquals(maskText("jwt: some.value"), `jwt: ${HIDDEN}`);
  assertEquals(maskText("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"), `AWS_ACCESS_KEY_ID=${HIDDEN}`);
  assertEquals(maskText("author: Ada Lovelace"), "author: Ada Lovelace");
  assertEquals(maskText("SESSION_ID: ${SESSION_ID}"), "SESSION_ID: ${SESSION_ID}");
});
