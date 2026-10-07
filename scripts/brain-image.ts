// brain-image.ts — the brain image holds every local file its entry points import.
// The Dockerfile copies shared/ files one by one; a new import there builds nowhere but in the
// image, where `deno cache` fails ("Module not found") and Coolify keeps the old container.
// Run by scripts/ci.sh.

const ENTRIES = ["apps/brain/main.ts", "apps/brain/admin.ts"];
const DOCKERFILE = "apps/brain/Dockerfile";

const root = Deno.cwd();

// the sources of the runtime stage's COPY lines (never --from=…), as repository-relative paths
const copied: string[] = [];
for (const line of Deno.readTextFileSync(DOCKERFILE).split("\n")) {
  const words = line.trim().split(/\s+/);
  if (words[0] !== "COPY" || words.some((w) => w.startsWith("--from="))) continue;
  copied.push(...words.slice(1, -1).filter((w) => !w.startsWith("--")));
}

const inImage = (file: string) => copied.some((c) => file === c || (c.endsWith("/") && file.startsWith(c)));

const missing = new Set<string>();
for (const entry of ENTRIES) {
  const out = await new Deno.Command("deno", { args: ["info", "--json", entry], stdout: "piped", stderr: "inherit" })
    .output();
  if (!out.success) Deno.exit(1);
  for (const m of JSON.parse(new TextDecoder().decode(out.stdout)).modules) {
    if (typeof m.specifier !== "string" || !m.specifier.startsWith("file://")) continue;
    const file = m.specifier.slice("file://".length).replace(`${root}/`, "");
    if (!inImage(file)) missing.add(file);
  }
}

if (missing.size) {
  console.error(`brain-image: imported by the brain but not copied by ${DOCKERFILE}:`);
  for (const f of [...missing].sort()) console.error(`  ${f}`);
  Deno.exit(1);
}
console.log("brain-image ok");
