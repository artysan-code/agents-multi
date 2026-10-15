// system/index.tsx — the System pages: the one on screen under its title. Each is its own module; the
// rail's «More» lists them all (shell/rail.tsx), so there is no second bar of tabs.

import { t } from "../../i18n.ts";
import { tab } from "../../router.ts";
import { Health } from "./health.tsx";
import { Permissions } from "./permissions.tsx";
import { Profiles } from "./profiles.tsx";
import { Updates } from "./updates.tsx";

const PANES = {
  profiles: Profiles,
  permissions: Permissions,
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
