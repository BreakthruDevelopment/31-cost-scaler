"use client";

import { useId, useState, type ReactNode } from "react";
import { PanelHeader } from "./PanelHeader";
import { buttonSecondary } from "./styles";

/**
 * A panel whose body folds. The body stays in the HTML (so the server response and `curl | grep` have it), but
 * `hidden` is `display: none`, so the browser's find-in-page does **not** look inside a folded panel. Don't claim
 * it does. Making it searchable means `hidden="until-found"` plus a `beforematch` listener that sets `open`, so the
 * toggle's label doesn't contradict what is on screen — worth doing only with a real browser to verify it in.
 */
export function CollapsiblePanel({
  headingId,
  action,
  title,
  count,
  defaultOpen,
  openLabel,
  closedLabel,
  children,
}: {
  headingId: string;
  action?: ReactNode;
  title: string;
  count?: number;
  defaultOpen: boolean;
  openLabel: string;
  closedLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section aria-labelledby={headingId} className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PanelHeader
        id={headingId}
        title={title}
        count={count}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {action}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            className={buttonSecondary}
          >
            {open ? openLabel : closedLabel}
            <span aria-hidden>{open ? "⌃" : "⌄"}</span>
          </button>
          </div>
        }
      />
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
