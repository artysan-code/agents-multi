// ui.tsx — the small pieces every view of the web app uses.

import type { ComponentChildren } from "preact";
import { t } from "./t.ts";

/** The top of a view: a title, a way back when it is below another, one action. */
export function Header({ title, back, action }: { title: string; back?: string; action?: ComponentChildren }) {
  return (
    <header class="head">
      {back && <a class="back" href={back} aria-label={t("back")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></a>}
      <h1>{title}</h1>
      {action}
    </header>
  );
}

export const Empty = ({ text }: { text: string }) => <p class="empty">{text}</p>;

export function Failure({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div class="err bar" role="alert">
      <span>{text}</span>
      {retry && <button type="button" class="btn ghost" onClick={retry}>{t("retry")}</button>}
    </div>
  );
}
