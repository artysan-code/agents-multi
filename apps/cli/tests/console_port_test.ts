// console_port_test.ts — which console is the machine's own (apps/cli/lib/paths.ts): only it runs the
// schedules and keeps the MCP gateway up; another on a second port serves its pages and nothing else.
import { assert } from "jsr:@std/assert@1";
import { DEFAULT_PORT, machineConsole } from "../lib/paths.ts";

Deno.test("machineConsole: the default port is the machine's console, any other only serves pages", () => {
  assert(machineConsole(DEFAULT_PORT));
  assert(!machineConsole(7399));
  assert(!machineConsole(DEFAULT_PORT + 1));
});
