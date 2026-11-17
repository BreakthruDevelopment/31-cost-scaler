"use client";

import { useEffect, useRef, useState } from "react";
import { askAdviceAction } from "@/app/advisor/actions";
import type { AdviceView } from "@/lib/advice-view";
import { type KeyedOp, opFor, runAsyncAction } from "@/lib/client-op";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui";
import { AnswerCard } from "./answer-card";

/**
 * Ask the advisor. Three things this form has to get right:
 *
 *  1. **One question, one answer.** The `clientOpId` is minted by `opFor` and held in a ref until the SERVER has
 *     answered (ok, or a validation/limit answer). A double tap, or a retry after a lost response, sends the same
 *     id, and the server returns the first answer instead of running the team again. A thrown request keeps the id,
 *     so the retry is still the same question.
 *  2. **The button always comes back.** `runAsyncAction` resets `pending` in `finally` and turns any throw into a
 *     message, so a 500 leaves an enabled button and a visible error, never a spinner forever.
 *  3. **An honest wait.** The team can take most of a minute, so the waiting line says so and counts the seconds.
 */

export type AppOption = { name: string; title: string };
export type ScenarioOption = { id: string; name: string };

const WORKING_MESSAGE = "Working: the pricing and migration agents usually take 20–45 seconds.";
const FAILED_MESSAGE = "Couldn't ask the advisor. Try again in a moment.";
export const QUESTION_MAX = 500;

export function AdvisorForm({ apps, scenarios }: { apps: AppOption[]; scenarios: ScenarioOption[] }) {
  const [question, setQuestion] = useState("");
  const [app, setApp] = useState("");
  const [scenarioId, setScenarioId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AdviceView | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const busy = useRef(false); // a ref, not state: two clicks in one tick both see the same stale `pending`
  const op = useRef<KeyedOp | null>(null);

  // Only the interval sets state here: `elapsed` is reset in the submit handler, before the request starts.
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [pending]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const trimmed = question.trim();
    if (!trimmed) {
      setError("Ask a question.");
      return;
    }
    busy.current = true;
    setElapsed(0);
    const payload = {
      question: trimmed,
      ...(app ? { app } : {}),
      ...(scenarioId ? { scenarioId } : {}),
    };
    // A new id only when the question, app or scenario changed: the same intent keeps its id across retries.
    op.current = opFor(op.current, payload);
    const clientOpId = op.current.id;
    try {
      await runAsyncAction(
        async () => {
          const result = await askAdviceAction({ ...payload, clientOpId });
          // The server answered, so this op id is spent either way; only a thrown request keeps it for the retry.
          op.current = null;
          if (result.ok) {
            setAnswer(result.advice);
            setError(null);
          } else {
            setError(result.error);
          }
        },
        { setPending, setError },
        FAILED_MESSAGE,
      );
    } finally {
      busy.current = false;
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="mb-6 space-y-4">
        <label className={labelClass}>
          <span>Your question</span>
          <textarea
            name="question"
            rows={3}
            maxLength={QUESTION_MAX}
            value={question}
            disabled={pending}
            onChange={(e) => setQuestion(e.target.value)}
            aria-describedby="advisor-question-help"
            placeholder="Should helpdesk move if it reaches 5,000 users?"
            className={`${inputClass} min-h-24 wrap-anywhere disabled:opacity-60`}
          />
        </label>
        <p id="advisor-question-help" className="text-sm text-muted">
          {QUESTION_MAX - question.length} characters left. The advisor answers from the price tables only; it never
          estimates a number.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            <span>App (optional)</span>
            <select value={app} disabled={pending} onChange={(e) => setApp(e.target.value)} className={inputClass}>
              <option value="">No particular app</option>
              {apps.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            <span>Your scenario (optional)</span>
            <select
              value={scenarioId}
              disabled={pending || scenarios.length === 0}
              onChange={(e) => setScenarioId(e.target.value)}
              className={inputClass}
            >
              <option value="">{scenarios.length === 0 ? "No saved scenarios yet" : "No scenario"}</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={buttonPrimary}>
            {pending ? "Asking…" : "Ask the advisor"}
          </button>
          {pending && (
            <p role="status" className="min-w-0 text-sm text-muted wrap-anywhere">
              {WORKING_MESSAGE} <span aria-hidden>{elapsed}s so far.</span>
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked wrap-anywhere">
            {error}
          </p>
        )}
      </form>

      {answer && (
        <section aria-label="The advisor's answer" className="mb-6">
          <AnswerCard advice={answer} heading="h2" />
        </section>
      )}
    </>
  );
}
