// login-link.tsx — the consent or sign-in link, shown when the console could not open the system browser
// itself (no opener on this machine): to open or copy, never a message saying a tab opened (#14).

import { useState } from "preact/hooks";
import { t } from "../i18n.ts";

/** The consent link, when the browser could not be opened from here. */
export function ManualLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="login-manual">
      <p>{t("login.manual.p")}</p>
      <p>
        <a href={url} target="_blank" rel="noopener noreferrer" class="mono">{url}</a>
      </p>
      <button
        type="button"
        class="btn sm"
        onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true), () => {})}
      >
        {t(copied ? "login.manual.copied" : "login.manual.copy")}
      </button>
    </div>
  );
}
