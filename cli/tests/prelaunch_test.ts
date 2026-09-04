// Test di integrazione di bin/lib/prelaunch.sh su repo git veri in una dir temporanea:
// bare remote + clone "altra macchina" (che pusha) + clone "questa macchina" (che il wrapper allinea).
import { assert, assertEquals } from "jsr:@std/assert@1";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const PRELAUNCH = `${REPO}/bin/lib/prelaunch.sh`;

async function sh(cmd: string, cwd?: string, env: Record<string, string> = {}) {
  const r = await new Deno.Command("bash", { args: ["-c", cmd], cwd, env: { ...Deno.env.toObject(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env }, stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).trim() };
}

Deno.test("prelaunch: fetch + pull ff-only quando indietro e pulito; niente pull se sporco; sync.json valido", async () => {
  const tmp = await Deno.makeTempDir();
  const bare = `${tmp}/remote.git`, other = `${tmp}/other`, mine = `${tmp}/mine`, cache = `${tmp}/cache`;
  await sh(`git init -q --bare -b release "${bare}" && git clone -q "${bare}" "${other}" && cd "${other}" && git checkout -q -b release && echo a > a && git add a && git commit -qm one && git push -q -u origin release`);
  await sh(`git clone -q "${bare}" "${mine}"`);
  const env = { CLAUDE_MULTI_REPO: mine, XDG_CACHE_HOME: cache, CLAUDE_MULTI_FETCH_TTL: "0", CLAUDE_MULTI_FETCH_TIMEOUT: "10" };

  // 1. allineato: nessun pull, stato tutto a zero
  let r = await sh(`bash "${PRELAUNCH}"`, undefined, env);
  assertEquals(r.code, 0);
  let st = JSON.parse(await Deno.readTextFile(`${cache}/claude-multi/sync.json`));
  assertEquals([st.behind, st.ahead, st.dirty, st.pulled, st.upstream, st.fetch_ok], [0, 0, 0, 0, true, true]);

  // 2. l'altra macchina pusha 2 commit → qui: behind 2, tree pulito → pull ff-only, pulled=2, behind=0
  await sh(`cd "${other}" && echo b > b && git add b && git commit -qm two && echo c > c && git add c && git commit -qm three && git push -q`);
  r = await sh(`bash "${PRELAUNCH}"`, undefined, env);
  assertEquals(r.code, 0);
  assert(r.err.includes("config aggiornata (+2 commit)"), `stderr: ${r.err}`);
  st = JSON.parse(await Deno.readTextFile(`${cache}/claude-multi/sync.json`));
  assertEquals([st.behind, st.pulled], [0, 2]);
  assertEquals((await sh(`git -C "${mine}" log --oneline | wc -l`)).out, "3");

  // 3. tree sporco + remote avanti → nessun pull, behind resta 1, dirty 1
  await sh(`cd "${other}" && echo d > d && git add d && git commit -qm four && git push -q`);
  await Deno.writeTextFile(`${mine}/a`, "modifica locale");
  r = await sh(`bash "${PRELAUNCH}"`, undefined, env);
  assertEquals(r.code, 0);
  st = JSON.parse(await Deno.readTextFile(`${cache}/claude-multi/sync.json`));
  assertEquals([st.behind, st.dirty, st.pulled], [1, 1, 0]);
  assertEquals((await sh(`git -C "${mine}" log --oneline | wc -l`)).out, "3");

  // 4. fetch fallito (remote irraggiungibile) → parte comunque, fetch_ok=false
  await sh(`git -C "${mine}" remote set-url origin /nonexistent/remote.git`);
  r = await sh(`bash "${PRELAUNCH}"`, undefined, env);
  assertEquals(r.code, 0);
  st = JSON.parse(await Deno.readTextFile(`${cache}/claude-multi/sync.json`));
  assertEquals(st.fetch_ok, false);
  await Deno.remove(tmp, { recursive: true });
});
