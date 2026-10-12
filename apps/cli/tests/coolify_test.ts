// Tests for shared/mcp/coolify/api.ts: resource matching, optional routes, base64, secret checks.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertNoSecretInText,
  isOptionalRoute,
  matchResource,
  toBase64,
  unavailable,
} from "../../../shared/mcp/coolify/api.ts";

const apps = [
  { uuid: "u1", name: "api" },
  { uuid: "u2", name: "api-staging" },
  { uuid: "u3", name: "Web" },
  { uuid: "u4", name: "web-admin" },
  { uuid: "u5", name: "worker-queue" },
];

Deno.test("matchResource: uuid and exact name win over substrings", () => {
  assertEquals(matchResource(apps, "application", "u2").name, "api-staging");
  assertEquals(matchResource(apps, "application", "API").uuid, "u1");
  assertEquals(matchResource(apps, "application", "web").uuid, "u3");
});

Deno.test("matchResource: a single substring candidate is accepted, several are refused with the list", () => {
  assertEquals(matchResource(apps, "application", "queue").uuid, "u5");
  const e = assertThrows(() => matchResource(apps, "application", "ap"), Error);
  assert(e.message.includes("api (u1)") && e.message.includes("api-staging (u2)"));
  assertThrows(() => matchResource(apps, "application", "nothing"), Error, "no application matches");
});

Deno.test("isOptionalRoute: only the routes that may be missing on older Coolify", () => {
  for (
    const r of [
      "/servers/x/docker-cleanup",
      "/servers/x/docker-cleanup/executions",
      "/scheduled-tasks",
      "/s3-storages",
      "/databases/x/envs",
      "/databases/x/logs",
      "/services/x/logs",
    ]
  ) {
    assert(isOptionalRoute(r), r);
  }
  for (const r of ["/applications/x", "/applications/x/envs", "/applications/x/logs", "/databases/x"]) {
    assert(!isOptionalRoute(r), r);
  }
});

Deno.test("toBase64: UTF-8 safe and handles files far above the argument limit", () => {
  assertEquals(toBase64("héllo ✓"), btoa(String.fromCharCode(...new TextEncoder().encode("héllo ✓"))));
  const big = "services: é\n".repeat(200_000);
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0)));
  assertEquals(decoded, big);
});

Deno.test("assertNoSecretInText: refuses a secret in a command, accepts a variable reference", () => {
  assertThrows(
    () => assertNoSecretInText("post_deployment_command", "curl -H 'Authorization: Bearer abc123def'"),
    Error,
    "environment variable",
  );
  assertThrows(() => assertNoSecretInText("pre_deployment_command", "migrate --password=hunter2"), Error);
  assertNoSecretInText("post_deployment_command", "npm run migrate");
  assertNoSecretInText("pre_deployment_command", "migrate --password=$DB_PASSWORD");
});

Deno.test("unavailable: says why, never looks like an empty list", () => {
  assertEquals(unavailable(new Error("/x → HTTP 404: no")), "unavailable: /x → HTTP 404: no");
});
