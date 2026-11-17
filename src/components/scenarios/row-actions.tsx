"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui";
import { deleteScenarioAction, duplicateScenarioAction } from "@/app/scenarios/actions";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { useAsyncAction } from "@/lib/use-async-action";

/**
 * Duplicate and delete, for one row of the scenario list.
 *
 * Duplicate is a create, so it carries one client op id per intent (kept in a ref until the server answers): a
 * double tap or a retry after a lost answer returns the first copy instead of making a second. Delete is
 * idempotent on the server — deleting what is already gone answers ok — so a retry shows no false error.
 * Both buttons go through `useAsyncAction`: pending resets in `finally` and a throw becomes a visible message.
 */
export function ScenarioRowActions({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const op = useRef<KeyedOp | null>(null);

  const duplicate = useAsyncAction(async () => {
    setRefused(null);
    op.current = opFor(op.current, { duplicateOf: id });
    const res = await duplicateScenarioAction(id, op.current.id);
    op.current = null; // the server answered; the next press is a new intent
    if (!res.ok) {
      setRefused(res.error);
      return;
    }
    router.refresh();
  }, "Couldn't duplicate this scenario. Check your connection and try again.");

  const remove = useAsyncAction(async () => {
    setRefused(null);
    const res = await deleteScenarioAction(id);
    if (!res.ok) {
      setRefused(res.error);
      return;
    }
    setConfirming(false);
    router.refresh();
  }, "Couldn't delete this scenario. Check your connection and try again.");

  const busy = duplicate.pending || remove.pending;
  const problem = duplicate.error ?? remove.error ?? refused;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonSecondary} disabled={busy} onClick={duplicate.run}>
          {duplicate.pending ? "Duplicating…" : "Duplicate"}
        </button>
        {confirming ? (
          <>
            <button type="button" className={buttonDanger} disabled={busy} onClick={remove.run}>
              {remove.pending ? "Deleting…" : "Yes, delete"}
            </button>
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className={buttonDanger} disabled={busy} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      {confirming && !problem && (
        <p role="status" className="mt-2 text-sm text-muted wrap-anywhere">
          Delete “{name}”? This cannot be undone.
        </p>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-sm font-medium text-danger wrap-anywhere">
          {problem}
        </p>
      )}
    </div>
  );
}
