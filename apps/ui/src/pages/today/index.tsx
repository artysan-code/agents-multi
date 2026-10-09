// today/index.tsx — the Today page, a board in three bands under the ask bar: plan (what is next and the
// line of the day), then the tasks that matter now, and beside them Claude at work (sessions). The
// machine's health is the rail's.
// Nothing on the page scrolls but the task list. Each part is its own module; this one loads the day
// and the board, and redraws them on each "tasks" event.

import { useState } from "preact/hooks";
import { get } from "../../api.ts";
import { useTopic } from "../../state.ts";
import { refreshBoard } from "../tasks/model.ts";
import type { Day } from "./api.ts";
import { DayCard, NextCard } from "./day.tsx";
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
      <section class="dayband">
        <NextCard day={day} />
        <DayCard day={day} />
      </section>
      <section class="lower">
        <TaskGroups />
        <aside class="side">
          <SessionsCard />
        </aside>
      </section>
    </div>
  );
}
