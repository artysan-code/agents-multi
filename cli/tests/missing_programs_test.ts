// Tests for missingPrograms (cli/mcp.ts): what the Connections page says when an account is added
// for a service whose server runs a program this machine does not have.
import { assertEquals } from "jsr:@std/assert@1";
import { missingPrograms, type Registry } from "../mcp.ts";
import { REPO } from "../lib.ts";

Deno.test("missingPrograms: an absent binary or command of that service's servers, with how to install it", async () => {
  const reg = {
    servers: {
      "gitea": {
        _service: "gitea",
        _install: "bash {repo}/scripts/install-gitea-mcp.sh",
        command: "/nonexistent/gitea-mcp",
      },
      "gitea-other": { _service: "gitea", command: "sh" },
      "railway": { _service: "railway", command: "no-such-command-xyz" },
      "coolify": { _service: "coolify", command: "deno" },
    },
  } as unknown as Registry;
  assertEquals(await missingPrograms("gitea", reg), [
    {
      server: "gitea",
      problem: "missing binary: /nonexistent/gitea-mcp",
      install: `bash ${REPO}/scripts/install-gitea-mcp.sh`,
    },
  ]);
  assertEquals(await missingPrograms("railway", reg), [{
    server: "railway",
    problem: "command not on PATH: no-such-command-xyz",
  }]);
  assertEquals(await missingPrograms("coolify", reg), []);
});
