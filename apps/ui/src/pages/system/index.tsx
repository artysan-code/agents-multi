// system/index.tsx — the System page: its tabs, and the tab on screen. Each tab is its own module.

import { t } from "../../i18n.ts";
import { tab, TABS } from "../../router.ts";
import { Health } from "./health.tsx";
import { Overview } from "./overview.tsx";
import { Permissions } from "./permissions.tsx";
import { Plugins } from "./plugins.tsx";
import { Profiles } from "./profiles.tsx";
import { Updates } from "./updates.tsx";
import { UpdateNow } from "./updates-close.tsx";

const PANES = {
  overview: Overview,
  profiles: Profiles,
  permissions: Permissions,
  plugins: Plugins,
  updates: Updates,
  health: Health,
};

export function System() {
  const Pane = PANES[tab.value];
  return (
    <>
      <div class="tabs" role="tablist">
        {TABS.map((x) => (
          <a key={x} href={`#system/${x}`} role="tab" aria-selected={x === tab.value}>{t(`sys.${x}`)}</a>
        ))}
        <UpdateNow cls="btn sm tabs-r" />
      </div>
      <Pane />
    </>
  );
}
