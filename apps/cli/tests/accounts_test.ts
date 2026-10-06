// Tests for shared/mcp/lib/accounts.ts: which accounts a profile sees, and which one a call means.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { type Account, accountHosts, resolveAccount, visibleAccounts } from "../../../shared/mcp/lib/accounts.ts";

const all: Account[] = [
  { service: "google", name: "personal", profiles: ["personal"] },
  { service: "google", name: "work", profiles: ["personal", "agency"] },
  { service: "n8n", name: "ark", url: "https://automate.example" },
];

Deno.test("visibleAccounts: per profile, and an account with no list is everyone's", () => {
  assertEquals(visibleAccounts(all, "google", "personal").map((a) => a.name), ["personal", "work"]);
  assertEquals(visibleAccounts(all, "google", "agency").map((a) => a.name), ["work"]);
  assertEquals(visibleAccounts(all, "n8n", "agency").map((a) => a.name), ["ark"]);
  // a server started by hand, with no profile, sees only what is open to everyone
  assertEquals(visibleAccounts(all, "google", undefined), []);
});

Deno.test("resolveAccount: one is implicit, several must be named, never a silent default", () => {
  const agency = visibleAccounts(all, "google", "agency");
  assertEquals(resolveAccount(agency, undefined, "google").name, "work");
  const personal = visibleAccounts(all, "google", "personal");
  assertThrows(() => resolveAccount(personal, undefined, "google"), Error, "several google accounts");
  assertEquals(resolveAccount(personal, "personal", "google").name, "personal");
  // an account another profile has is not reachable by naming it
  assertThrows(() => resolveAccount(agency, "personal", "google"), Error, 'no google account "personal"');
  assertThrows(() => resolveAccount([], undefined, "coolify"), Error, "no coolify account");
});

Deno.test("accountHosts: host with port, deduplicated, invalid addresses skipped", () => {
  assertEquals(
    accountHosts([
      { service: "s", name: "a", url: "https://h.example:8443/x" },
      { service: "s", name: "b", url: "https://h.example:8443/y" },
      { service: "s", name: "c", url: "not a url" },
      { service: "s", name: "d" },
    ]),
    ["h.example:8443"],
  );
});
