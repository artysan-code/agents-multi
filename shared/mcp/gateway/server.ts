#!/usr/bin/env -S deno run
// gateway — the lazy MCP gateway's entry point (docs/adr/0008; the code is gateway.ts).
//
//   gateway/server.ts <backends.json>
//
// It logs to `gateway.log` next to that file, never to the pipes of whoever started it.
import { openLog } from "./log.ts";
import { startGateway } from "./gateway.ts";

const configPath = Deno.args[0];
if (!configPath) {
  console.error("usage: gateway/server.ts <backends.json>");
  Deno.exit(2);
}
const log = openLog(`${configPath.replace(/\/[^/]*$/, "")}/gateway.log`);
try {
  const gw = await startGateway({ configPath, log, code: Deno.env.get("AGENTS_MULTI_GATEWAY_CODE") ?? "" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    Deno.addSignalListener(sig, () => void gw.shutdown().then(() => Deno.exit(0)));
  }
  await gw.finished;
} catch (e) {
  if (e instanceof Deno.errors.AddrInUse) {
    log("the port is taken: a gateway is already running");
    Deno.exit(0);
  }
  log(`failed to start: ${(e as Error).message}`);
  throw e;
}
