import { DemoBadge, StatusBadge, type Status } from "@/components/ui";
import { CLOUD_LABEL } from "@/lib/pricing/types";
import { AGENT_LABEL, type AdviceView, figureSource } from "@/lib/advice-view";

/**
 * One advisor answer. Every number on this card is a figure the server already matched, to the cent, against a
 * recorded tool result; the card formats it and never derives a new one. The tag beside a figure names the tool
 * call it came from, so a reader can follow it to the same price rows the /prices table renders.
 */

const VERDICT: Record<string, { status: Status; label: string }> = {
  move: { status: "live", label: "Move" },
  consider: { status: "building", label: "Consider" },
  stay: { status: "not-started", label: "Stay" },
  blocked: { status: "blocked", label: "Blocked" },
  not_enough_data: { status: "not-started", label: "Not enough data" },
};

/** Dollars from the checked figure. Integer cents, so the browser and the server print the same string. */
function usdFromDollars(value: number): string {
  const negative = value < 0;
  const cents = Math.round(Math.abs(value) * 100);
  const dollars = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

function figureValue(f: AdviceView["output"]["figures"][number]): string {
  if (f.unit === "months") {
    const months = Math.round(f.valueUsd * 10) / 10;
    return `${months} ${months === 1 ? "month" : "months"}`;
  }
  return `${usdFromDollars(f.valueUsd)}${f.unit === "per_month" ? "/mo" : " one time"}`;
}

export function AnswerCard({ advice, heading = "h3" }: { advice: AdviceView; heading?: "h2" | "h3" }) {
  const { output, checks } = advice;
  const verdict = VERDICT[output.recommendation] ?? VERDICT.not_enough_data;
  const Heading = heading;
  const consulted = checks.delegations.map((d) => AGENT_LABEL[d.agent] ?? d.agent);

  return (
    <article className="min-w-0 rounded-card border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={verdict.status} label={verdict.label} />
        {output.targetCloud && <StatusBadge status="healthy" label={`Target: ${CLOUD_LABEL[output.targetCloud]}`} />}
        {advice.demo && <DemoBadge label="Recorded demo answer" />}
      </div>
      <Heading className="mt-3 font-display text-2xl font-semibold wrap-anywhere">{output.headline}</Heading>
      <p className="mt-1 text-sm text-muted wrap-anywhere">
        Asked {advice.createdAt.slice(0, 10)}: “{advice.question}”
        {advice.appName ? ` · about ${advice.appName}` : ""}
      </p>

      {consulted.length > 0 && (
        <p className="mt-3 text-sm text-muted wrap-anywhere">
          Consulted: {consulted.join(", ")}.
        </p>
      )}

      {output.figures.length > 0 ? (
        <>
          <h4 className="mt-4 text-sm font-semibold">Figures</h4>
          <ul aria-label="Figures, each from a recorded tool call" className="mt-1 divide-y divide-border">
            {output.figures.map((f) => (
              <li key={`${f.call}${f.path}`} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium">{f.label}</span>
                  <span className="block text-muted wrap-anywhere">{figureSource(f.call, checks.figureAgents)}</span>
                </span>
                <span className="shrink-0 text-right font-semibold tabular-nums">{figureValue(f)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 rounded-card bg-background px-3 py-2 text-sm text-muted wrap-anywhere">
          No figure in this answer could be traced to a tool result, so none is shown. The computed tables on the
          footprint and price pages have the numbers.
        </p>
      )}

      {output.explanation && <p className="mt-4 text-sm wrap-anywhere">{output.explanation}</p>}

      {output.caveats.length > 0 && (
        <>
          <h4 className="mt-4 text-sm font-semibold">Caveats</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {output.caveats.map((c) => (
              <li key={c} className="wrap-anywhere">
                {c}
              </li>
            ))}
          </ul>
        </>
      )}

      {checks.droppedFigures.length > 0 && (
        <div role="status" className="mt-4 rounded-card border border-border bg-building-soft px-3 py-2 text-sm text-building">
          <p className="font-semibold">
            {checks.droppedFigures.length} figure{checks.droppedFigures.length === 1 ? " was" : "s were"} dropped
            before you saw {checks.droppedFigures.length === 1 ? "it" : "them"}.
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {checks.droppedFigures.map((d, i) => (
              <li key={`${d.call}${d.path}${i}`} className="wrap-anywhere">
                “{d.label || "unlabelled"}” ({d.call || "no call"} {d.path || "no path"}): {d.why}.
              </li>
            ))}
          </ul>
        </div>
      )}

      {checks.strippedNumbers > 0 && (
        <p className="mt-2 text-sm text-muted wrap-anywhere">
          {checks.strippedNumbers} number{checks.strippedNumbers === 1 ? "" : "s"} written into the wording could not
          be traced to a tool result and {checks.strippedNumbers === 1 ? "was" : "were"} removed.
        </p>
      )}

      <p className="mt-4 text-sm text-muted wrap-anywhere">
        List prices only, not a quote. Every figure above comes from the same price table as the{" "}
        <a href="/prices" className="text-accent hover:underline">
          prices page
        </a>
        .
      </p>
    </article>
  );
}
