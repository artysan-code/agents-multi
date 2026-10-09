// system/index.tsx — the System pages: the one on screen under its title. Each is its own module; the
// rail lists them all (shell/rail.tsx), so there is no second bar of tabs.

import { t } from "../../i18n.ts";
import { tab } from "../../router.ts";
import { Health } from "./health.tsx";
import { Overview } from "./overview.tsx";
import { Permissions } from "./permissions.tsx";
import { Plugins } from "./plugins.tsx";
import { Profiles } from "./profiles.tsx";
import { Updates } from "./updates.tsx";

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
      <h1 class="pg-h">{t(`sys.${tab.value}`)}</h1>
      <Pane />
    </>
  );
}
