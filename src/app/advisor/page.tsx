import type { Metadata } from "next";
import { AdvisorForm, type AppOption, type ScenarioOption } from "@/components/advisor/advisor-form";
import { AnswerCard } from "@/components/advisor/answer-card";
import { PageIntro, Panel } from "@/components/ui";
import { toAdviceView } from "@/lib/advice-view";
import { listAdvice } from "@/lib/advice-store";
import { ADVICE_PER_DAY, ADVICE_PER_HOUR } from "@/lib/advisor";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listFootprint } from "@/lib/footprint/refresh";
import { listScenarios } from "@/lib/scenarios";
import { log } from "@/lib/log";

export const metadata: Metadata = { title: "Advisor" };
export const dynamic = "force-dynamic";

/** A list the page can do without: an empty picker is better than a blank page when one read fails. */
async function orEmpty<T>(work: Promise<T[]>, what: string): Promise<T[]> {
  try {
    return await work;
  } catch (err) {
    log.warn("advisor_page_read_failed", { what, error: err instanceof Error ? err.message : "unknown" });
    return [];
  }
}

export default async function AdvisorPage() {
  const user = await requireUserOrRedirect();
  const [apps, scenarios, history] = await Promise.all([
    orEmpty(listFootprint(), "footprint"),
    orEmpty(listScenarios(user), "scenarios"),
    orEmpty(listAdvice(user), "advice"),
  ]);

  const appOptions: AppOption[] = apps.map((a) => ({ name: a.name, title: a.title }));
  const scenarioOptions: ScenarioOption[] = scenarios.map((s) => ({ id: s.id, name: s.name }));
  const answers = history.map(toAdviceView);

  return (
    <>
      <PageIntro
        section="Advisor"
        title="Ask about moving or scaling an app."
        description="A small team of agents answers from the same price tables this app renders. Every number it shows is checked against the tool result it came from; anything it cannot trace is dropped before you see it."
      />
      <Panel title="Ask">
        <p className="mb-4 text-sm text-muted">
          {ADVICE_PER_HOUR} questions an hour and {ADVICE_PER_DAY} a day, per person. Pick an app or one of your saved
          scenarios to give the agents something concrete to price. Without a model key, or once the day&apos;s
          allowance is used, you get a recorded demo answer built from the real tools, and it is labelled as one.
        </p>
        <AdvisorForm apps={appOptions} scenarios={scenarioOptions} />
      </Panel>

      {/* Up to 50 answers are kept, and each is a tall card, so the history folds once there are a few of them. */}
      <Panel
        title="Your earlier answers"
        count={answers.length}
        collapsible={answers.length > 3}
        defaultOpen={answers.length <= 3}
        openLabel="Hide answers"
        closedLabel="Show answers"
      >
        {answers.length === 0 ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            Nothing yet. Your answers are private to you and appear here once you ask.
          </div>
        ) : (
          <ul aria-label="Your earlier answers" className="grid gap-4">
            {answers.map((a) => (
              <li key={a.id} className="min-w-0">
                <AnswerCard advice={a} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
