// update-now.tsx — the button that starts the update screen: «Update now», or «Close Claude and update».
// Apart from updates-close.tsx so the rail can draw it without loading that screen.

import type { ComponentChildren } from "preact";
import { t } from "../../i18n.ts";
import { request } from "../../router.ts";
import { sys } from "../../shell/sysstate.ts";

/** «Update now», or «Close Claude and update» when all that is left is the install waiting for every
 *  Claude to be closed: the update is already here, and the wizard would only say so. With `icon`, the
 *  label is its own span (`label` its class), as the rail draws it. */
export function UpdateNow({ cls, auto, icon, label }: {
  cls: string;
  auto?: boolean;
  icon?: ComponentChildren;
  label?: string;
}) {
  const settle = sys.value.upWord === "pill.settle";
  // the install left waiting is a step of the update screen, as the rest of the update
  const go = () =>
    request(
      "update.wizard",
      undefined,
      settle ? "settle" : auto ? "auto" : undefined,
    );
  const text = t(settle ? "cc.btn" : "up.now");
  return (
    <button
      type="button"
      class={cls}
      title={icon ? text : undefined}
      onClick={go}
    >
      {icon}
      {icon ? <span class={label}>{text}</span> : text}
    </button>
  );
}
