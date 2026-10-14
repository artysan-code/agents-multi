// Tests for the permission lists of the servers this repository writes (shared/mcp/servers.json against
// their code): every tool a server registers is in _allow, _ask or _deny, or decided on purpose
// elsewhere — so a new tool never falls to the permission mode unnoticed — and every listed name is
// one the server still registers, so a list never names a tool that is gone.
import { assertEquals } from "jsr:@std/assert@1";
import { listDrift, versionDrift } from "../mcp/health.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** The servers we write, and the files that register their tools. */
const SOURCES: Record<string, string[]> = {
  coolify: ["shared/mcp/coolify"],
  google: ["shared/mcp/google"],
  agents: [
    "shared/mcp/agents/server.ts",
    "shared/mcp/agents/tools.ts",
    "shared/mcp/agents/routine-tools.ts",
    "shared/mcp/agents/account-tools.ts",
  ],
  "syncthing-status": ["shared/mcp/syncthing-status"],
  tasks: ["shared/mcp/tasks"],
  brain: ["apps/brain/tools.ts"],
};

/** Pure: the tool names a server's source registers (`registerTool("name"`, also across a line break). */
export function registeredTools(source: string): string[] {
  return [...source.matchAll(/registerTool\(\s*["'`]([\w-]+)["'`]/g)].map((m) => m[1]);
}

async function sourceOf(paths: string[]): Promise<string> {
  let out = "";
  for (const p of paths) {
    const full = `${ROOT}${p}`;
    if ((await Deno.stat(full)).isDirectory) {
      for await (const e of Deno.readDir(full)) {
        if (e.isFile && e.name.endsWith(".ts")) out += await Deno.readTextFile(`${full}/${e.name}`);
      }
    } else out += await Deno.readTextFile(full);
  }
  return out;
}

Deno.test("registeredTools: names on the same line and on the next", () => {
  assertEquals(registeredTools(`server.registerTool("a_b", {})\nserver.registerTool(\n  "c",\n {})`), ["a_b", "c"]);
});

Deno.test("servers.json: our servers' tools are each in one list, and every listed tool exists", async () => {
  const reg = JSON.parse(await Deno.readTextFile(`${ROOT}shared/mcp/servers.json`)).servers;
  const settings = JSON.parse(await Deno.readTextFile(`${ROOT}shared/settings.json`)).permissions;
  const rules: string[] = [...settings.allow, ...settings.ask, ...settings.deny];
  for (const [name, paths] of Object.entries(SOURCES)) {
    const tools = new Set(registeredTools(await sourceOf(paths)));
    const cfg = reg[name];
    const listed = [...cfg._allow ?? [], ...cfg._ask ?? [], ...cfg._deny ?? [], ...cfg._auto ?? []];
    const covered = (t: string) =>
      listed.includes(t) || rules.includes(`mcp__${name}`) || rules.includes(`mcp__${name}__${t}`);
    assertEquals([...tools].filter((t) => !covered(t)), [], `${name}: tools in no list`);
    assertEquals(listed.filter((t) => !tools.has(t)), [], `${name}: listed tools it no longer registers`);
  }
});

Deno.test("listDrift: tools in no list, listed tools not offered; a denied tool the server hides is fine", () => {
  const cfg = { _allow: ["a", "gone"], _ask: ["b"], _deny: ["off"], _auto: ["m"], _guard: { tool: ["g"] } };
  assertEquals(listDrift(["a", "b", "g", "m", "new"], cfg), { unlisted: ["new"], stale: ["gone"] });
  assertEquals(listDrift(["a", "gone", "b", "g"], cfg), { unlisted: [], stale: [] });
  assertEquals(listDrift(["a", "gone", "b", "g", "s"], cfg, (t) => t === "s"), { unlisted: [], stale: [] });
});

Deno.test("versionDrift: the version at the end of serverInfo against the expected one", () => {
  assertEquals(versionDrift("5.60.0", "railway 5.66.0"), "5.66.0");
  assertEquals(versionDrift("1.8.0", "Gitea MCP Server 1.8.0"), null);
  assertEquals(versionDrift(undefined, "railway 5.66.0"), null);
  assertEquals(versionDrift("1.0.0", "no version here"), null);
});
