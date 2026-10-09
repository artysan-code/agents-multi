// today/index.tsx — the Today page, under the ask bar: the day first, a tall card with what is next and
// the agenda; beside it the tasks that matter now, and under them Claude at work (sessions). The
// machine's health is the rail's.
// Nothing on the page scrolls but the agenda and the task list. Each part is its own module; this one loads the day
// and the board, and redraws them on each "tasks" event.

import { useState } from "preact/hooks";
import { get } from "../../api.ts";
import { useTopic } from "../../state.ts";
import { refreshBoard } from "../tasks/model.ts";
import type { Day } from "./api.ts";
import { DayCard } from "./day.tsx";
import { TaskGroups } from "./groups.tsx";
import { SessionsCard } from "./sessions.tsx";
import "./today.css";

export function Today() {
  const [day, setDay] = useState<Day | null>(null);
  useTopic(() => {
    get<Day>("/api/tasks").then(setDay, () => {});
    refreshBoard().catch(() => {});
  }, ["tasks"]);
  return (
    <div class="today2">
      <DayCard day={day} />
      <aside class="side">
        <TaskGroups />
        <SessionsCard />
      </aside>
    </div>
  );
}
