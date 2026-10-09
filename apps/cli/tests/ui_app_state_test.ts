// Tests for the Updates tab's line about the desktop app (apps/ui/src/pages/system/app-state.ts): each
// state of the app's update says the right thing, and a package manager's name comes through.
import { assertEquals } from "jsr:@std/assert@1";
import { type AppLine, appState, unreachable } from "../../ui/src/pages/system/app-state.ts";

const base: AppLine = { state: "idle", available: null };
const next = { version: "1.0.1", notes: "", date: null };

Deno.test("appState: what the Updates tab says for each state of the app's update", () => {
  assertEquals(appState(base), { key: "up.uptodate" });
  assertEquals(appState({ ...base, state: "checking" }), {
    key: "up.app.checking",
  });
  assertEquals(
    appState({
      ...base,
      state: "downloading",
      available: next,
      progress: 0.426,
    }),
    { key: "up.app.downloading", vars: { v: "1.0.1", p: 43 } },
  );
  assertEquals(appState({ ...base, state: "ready", available: next }), {
    key: "up.app.ready",
    vars: { v: "1.0.1" },
  });
  assertEquals(
    appState({ ...base, state: "restarting", available: next }).key,
    "up.app.installing",
  );
  assertEquals(appState({ ...base, state: "error", error: "offline" }), {
    key: "up.app.error",
    vars: { e: "offline" },
  });
  assertEquals(appState({ ...base, off: "package-manager:pacman" }), {
    key: "up.app.pm",
    vars: { m: "pacman" },
  });
  assertEquals(appState({ ...base, off: "not-packaged", state: "error" }), {
    key: "up.app.off",
  });
});

Deno.test("appState: the update site not answering is said plainly, any other error as it is", () => {
  const err = (e: string) => appState({ ...base, state: "error", error: e });
  assertEquals(err("Could not fetch a valid release JSON from the remote"), { key: "up.app.unreachable" });
  assertEquals(
    err("error sending request for url (https://agents-multi.artysan.me/updates/beta.json)").key,
    "up.app.unreachable",
  );
  assertEquals(err("the signature is invalid"), { key: "up.app.error", vars: { e: "the signature is invalid" } });
  assertEquals(unreachable("server returned 503"), true);
  assertEquals(unreachable("version 1.5030 not found"), false);
});
