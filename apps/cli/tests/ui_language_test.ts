// Tests for uiLanguage (lib.ts): which language the console opens in on a given machine.
import { assertEquals } from "jsr:@std/assert@1";
import { uiLanguage } from "../lib/locale.ts";

Deno.test("uiLanguage: the regional format outranks LANG, explicit message locales win", () => {
  // English messages with Italian formats: the format says where the person is
  assertEquals(uiLanguage({ LANG: "en_US.UTF-8", LC_TIME: "it_IT.UTF-8" }), "it");
  assertEquals(uiLanguage({ LANG: "it_IT.UTF-8" }), "it");
  assertEquals(uiLanguage({ LANG: "it_IT.UTF-8", LC_MESSAGES: "en_GB.UTF-8" }), "en");
  assertEquals(uiLanguage({ LC_ALL: "en_US.UTF-8", LC_TIME: "it_IT.UTF-8" }), "en");
});

Deno.test("uiLanguage: unsupported and C locales fall through, nothing at all is English", () => {
  assertEquals(uiLanguage({ LC_TIME: "de_DE.UTF-8", LANG: "it_IT.UTF-8" }), "it");
  assertEquals(uiLanguage({ LC_ALL: "C", LANG: "it_IT" }), "it");
  assertEquals(uiLanguage({ LANG: "C.UTF-8" }), "en");
  assertEquals(uiLanguage({}), "en");
});
