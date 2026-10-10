// locale.ts — The interface language a machine asks for.

/** The console's languages. The page carries one dictionary per entry (apps/ui/src/i18n.ts). */
const UI_LANGUAGES = ["en", "it"] as const;
type UiLanguage = typeof UI_LANGUAGES[number];

/**
 * Pure: the interface language a machine asks for, from its locale variables. The regional format
 * (LC_TIME) outranks LANG on purpose: a common setup is English messages with the country's
 * formats (LANG=en_US, LC_TIME=it_IT), and there the format says where the person is. An explicit
 * LC_ALL or LC_MESSAGES still wins. Unsupported or C/POSIX locales fall through to the next one.
 */
export function uiLanguage(env: Record<string, string | undefined>): UiLanguage {
  for (const k of ["LC_ALL", "LC_MESSAGES", "LC_TIME", "LANG"]) {
    const code = env[k]?.match(/^([a-z]{2})(?:[_.@-]|$)/i)?.[1].toLowerCase();
    if (code && (UI_LANGUAGES as readonly string[]).includes(code)) return code as UiLanguage;
  }
  return "en";
}
