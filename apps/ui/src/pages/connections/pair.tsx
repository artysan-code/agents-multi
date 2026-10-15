// pair.tsx — «Pair with a code» (ADR 0014, G4): this machine becomes a node of the brain account without a browser
// sign-in on it. The console runs `agents node pair` as a job and shows the code it prints; the person types it in the
// web app's Machines page (on the phone, say), and the job ends with this machine paired.

import { useRef, useState } from "preact/hooks";
import { api } from "../../api.ts";
import { t } from "../../i18n.ts";
import { runJob, toast } from "../../lib/ui.tsx";
import { pairFailure, pairView } from "./pair-lib.ts";

export function PairCard({ reload }: { reload: () => void }) {
  const [out, setOut] = useState<string | null>(null);
  const job = useRef<string | null>(null);
  const text = useRef("");
  const view = pairView(out ?? "");

  const start = async () => {
    text.current = "";
    setOut("");
    const end = await runJob("node-pair", undefined, (o) => setOut(text.current += o), (id) => (job.current = id));
    job.current = null;
    const v = pairView(text.current);
    setOut(null);
    if ("error" in end) return toast(end.error, true);
    if (end.code === 0 && v.paired) {
      toast(t("pair.done", { n: v.paired }));
      reload();
    } else if (!end.cancelled) toast(pairFailure(text.current) || t("pair.failed"), true);
  };
  const cancel = () => job.current && void api.jobCancel(job.current);

  return (
    <div class="status-card update" style={{ marginTop: "12px" }}>
      <i />
      <div>
        <b>{t("pair.title")}</b>
        <div class="sub">{t("pair.how")}</div>
        {out !== null && (
          <div role="status" aria-live="polite">
            {view.code
              ? (
                <>
                  <p style={{ fontSize: "2rem", letterSpacing: ".18em", margin: "10px 0 4px" }}><code>{view.code}</code></p>
                  <div class="sub">
                    {t("pair.type")} <code>{view.url}</code>
                  </div>
                </>
              )
              : <div class="sub">{t("pair.asking")}</div>}
          </div>
        )}
      </div>
      {out === null
        ? <button type="button" class="btn" onClick={() => void start()}>{t("pair.go")}</button>
        : <button type="button" class="btn ghost" onClick={cancel}>{t("pair.cancel")}</button>}
    </div>
  );
}
