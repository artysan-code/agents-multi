// Test del parser del changelog in bin/claude-update (changelog_for): estrae la sezione "## X.Y.Z" e la cachea.
import { assert, assertEquals } from "jsr:@std/assert@1";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("changelog_for: the version section, the cache, and a missing version", async () => {
  const tmp = await Deno.makeTempDir();
  const md = `# Changelog\n\n## 2.1.300\n\n- Nuova cosa\n- Altra cosa\n\n## 2.1.299\n\n- Vecchia cosa\n`;
  await Deno.writeTextFile(`${tmp}/CHANGELOG.md`, md);
  const run = (ver: string) => new Deno.Command("bash", {
    args: ["-c", `set -u; NET_TIMEOUT=5; CACHE_DIR="${tmp}/cache"; CHANGELOG_URL="file://${tmp}/CHANGELOG.md"; eval "$(sed -n '/^changelog_for()/,/^}/p' "${REPO}/bin/claude-update")"; changelog_for "${ver}"`],
    stdout: "piped", stderr: "piped",
  }).output();
  let r = await run("2.1.300");
  assertEquals(r.code, 0);
  const file = new TextDecoder().decode(r.stdout).trim();
  const body = await Deno.readTextFile(file);
  assert(body.startsWith("## 2.1.300"), body);
  assert(body.includes("- Altra cosa") && !body.includes("Vecchia cosa"), body);
  // seconda chiamata: dalla cache (stesso path), senza rete
  await Deno.writeTextFile(`${tmp}/CHANGELOG.md`, "# vuoto");
  r = await run("2.1.300");
  assertEquals(new TextDecoder().decode(r.stdout).trim(), file);
  // versione assente → exit 1, nessun file
  r = await run("9.9.9");
  assertEquals(r.code, 1);
  await Deno.remove(tmp, { recursive: true });
});
