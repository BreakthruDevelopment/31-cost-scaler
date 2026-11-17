"use client";

import { useId, type ReactNode } from "react";
import { inputClass } from "@/components/ui";

/**
 * The builder's form controls. Each one owns its label, hint and error wiring: a field with a problem gets
 * `aria-invalid` and names its message through `aria-describedby`, so a screen reader reads the reason with the
 * field rather than only in the summary above the buttons.
 */

type Common = { label: string; hint?: string; error?: string; disabled?: boolean };

type Wiring = { id: string; describedBy: string | undefined; invalid: true | undefined };

function useField(hint?: string, error?: string): { wiring: Wiring; hintId: string; errorId: string } {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return { wiring: { id, describedBy: describedBy === "" ? undefined : describedBy, invalid: error ? true : undefined }, hintId, errorId };
}

function Field({ label, hint, error, wiring, hintId, errorId, children }: Common & { wiring: Wiring; hintId: string; errorId: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={wiring.id} className="block text-sm font-medium wrap-anywhere">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-muted wrap-anywhere">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs font-medium text-danger wrap-anywhere">
          {error}
        </p>
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = "any",
  hint,
  error,
  disabled,
}: Common & { value: string; onChange: (value: string) => void; min: number; max: number; step?: string }) {
  const { wiring, hintId, errorId } = useField(hint, error);
  return (
    <Field label={label} hint={hint} error={error} wiring={wiring} hintId={hintId} errorId={errorId}>
      <input
        id={wiring.id}
        type="number"
        inputMode="decimal"
        className={inputClass}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={wiring.invalid}
        aria-describedby={wiring.describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  disabled,
}: Common & { value: T; onChange: (value: T) => void; options: { value: T; label: string }[] }) {
  const { wiring, hintId, errorId } = useField(hint, error);
  return (
    <Field label={label} hint={hint} error={error} wiring={wiring} hintId={hintId} errorId={errorId}>
      <select
        id={wiring.id}
        className={inputClass}
        value={value}
        disabled={disabled}
        aria-invalid={wiring.invalid}
        aria-describedby={wiring.describedBy}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  hint,
  error,
  disabled,
}: Common & { value: string; onChange: (value: string) => void; maxLength: number; placeholder?: string }) {
  const { wiring, hintId, errorId } = useField(hint, error);
  return (
    <Field label={label} hint={hint} error={error} wiring={wiring} hintId={hintId} errorId={errorId}>
      <input
        id={wiring.id}
        type="text"
        className={inputClass}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={wiring.invalid}
        aria-describedby={wiring.describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** A labelled group of fields inside a panel; one column at 375px, two from 640px up. */
export function FieldGroup({ legend, children, columns = 2 }: { legend: string; children: ReactNode; columns?: 2 | 3 }) {
  return (
    <fieldset className="mb-5 min-w-0 last:mb-0">
      <legend className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{legend}</legend>
      <div className={`grid min-w-0 gap-4 sm:grid-cols-2${columns === 3 ? " lg:grid-cols-3" : ""}`}>{children}</div>
    </fieldset>
  );
}
