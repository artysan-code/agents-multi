// Tests for shared/mcp/lib/mask.ts: what an MCP server must not hand back.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { HIDDEN, mask, maskText } from "../../../shared/mcp/lib/mask.ts";

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
