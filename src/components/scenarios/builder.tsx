"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FieldGroup, NumberField, SelectField, TextField } from "@/components/scenarios/fields";
import { CloudResults } from "@/components/scenarios/cloud-results";
import { Panel, buttonPrimary, buttonSecondary } from "@/components/ui";
import { createScenarioAction, priceScenarioAction, updateScenarioAction } from "@/app/scenarios/actions";
import { type KeyedOp, opFor } from "@/lib/client-op";
import type { ScenarioPrice } from "@/lib/pricing/scenario";
import type { Redundancy } from "@/lib/pricing/spec";
import {
  MAX_NAME,
  REDUNDANCY_OPTIONS,
  REDUNDANCY_PARTS,
  type RedundancyPart,
  type ScenarioDraft,
  checkDraft,
  specInputFromDraft,
} from "@/lib/scenario-draft";
import { useAsyncAction } from "@/lib/use-async-action";

/**
 * Build a scenario and price it on all four clouds.
 *
 * Two rules this screen exists to keep:
 *  - **A retry never makes a second scenario.** One client op id per save intent lives in a ref and is sent with
 *    every attempt; it is dropped only once the server has answered (ok, or a refusal it chose). A thrown action —
 *    a lost connection, a timeout — keeps it, so the retry reuses it and the unique index on (owner, op id) returns
 *    the first row. An edit changes the payload, so `opFor` mints a new id: that is a new intent.
 *  - **A button that starts work always comes back.** Both buttons go through `useAsyncAction`, which resets
 *    pending in `finally` and turns any throw into a message, so a failing action can never leave one disabled.
 */

const COMPUTE_KINDS = [
  { value: "serverless" as const, label: "Serverless (per vCPU-second)" },
  { value: "vm" as const, label: "Virtual machines (per hour)" },
];

type Saved = { id: string; version: number } | null;

export function ScenarioBuilder({
  scenario,
  initialDraft,
  initialResult,
  apps,
}: {
  scenario: Saved;
  initialDraft: ScenarioDraft;
  initialResult: ScenarioPrice;
  apps: { name: string; title: string }[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [version, setVersion] = useState(scenario?.version ?? 0);
  const [result, setResult] = useState(initialResult);
  const [conditionalCredits, setConditionalCredits] = useState(false);
  const [savedKey, setSavedKey] = useState(() => JSON.stringify(initialDraft));
  const [pricedKey, setPricedKey] = useState(() => JSON.stringify({ spec: specInputFromDraft(initialDraft), conditionalCredits: false }));
  const [refused, setRefused] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const op = useRef<KeyedOp | null>(null);

  const check = checkDraft(draft);
  const issues = check.ok ? [] : check.issues;
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const draftKey = JSON.stringify(draft);
  const priceKey = JSON.stringify({ spec: specInputFromDraft(draft), conditionalCredits });
  const unsaved = draftKey !== savedKey;
  const stalePrice = priceKey !== pricedKey;

  const set = (patch: Partial<ScenarioDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setNotice(null);
  };

  const setRedundancy = (key: RedundancyPart, value: Redundancy) => {
    setDraft((d) => {
      const redundancy = { ...d.redundancy };
      redundancy[key] = value;
      return { ...d, redundancy };
    });
    setNotice(null);
  };

  const save = useAsyncAction(async () => {
    setRefused(null);
    setNotice(null);
    if (!check.ok) {
      setRefused("Fix the fields marked below, then save again.");
      return;
    }
    const payload = { name: check.name, spec: check.spec };
    if (scenario) {
      const res = await updateScenarioAction(scenario.id, { version, ...payload });
      if (!res.ok) {
        setRefused(res.error);
        return;
      }
      if (res.scenario) setVersion(res.scenario.version);
      setSavedKey(draftKey);
      setNotice("Saved.");
      router.refresh();
      return;
    }
    // One op id per intent, kept across retries until the server answers.
    op.current = opFor(op.current, payload);
    const res = await createScenarioAction({ ...payload, clientOpId: op.current.id });
    op.current = null; // the server answered: a later save is a new intent
    if (!res.ok) {
      setRefused(res.error);
      return;
    }
    setSavedKey(draftKey);
    router.push(res.scenario ? `/scenarios/${res.scenario.id}` : "/scenarios");
    router.refresh();
  }, "Couldn't save the scenario. Check your connection and try again.");

  const price = useAsyncAction(async () => {
    setRefused(null);
    setNotice(null);
    if (!check.ok) {
      setRefused("Fix the fields marked below, then price it again.");
      return;
    }
    const res = await priceScenarioAction({ spec: check.spec, conditionalCredits });
    if (!res.ok) {
      setRefused(res.error);
      return;
    }
    setResult(res.result);
    setPricedKey(priceKey);
  }, "Couldn't price this scenario. Check your connection and try again.");

  const busy = save.pending || price.pending;
  const problem = save.error ?? price.error ?? refused;

  return (
    <div className="min-w-0">
      <Panel
        title={scenario ? "Scenario" : "New scenario"}
        action={unsaved ? <span className="rounded-md bg-building-soft px-2 py-0.5 text-sm font-medium text-building">Unsaved changes</span> : undefined}
      >
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={draft.name}
            maxLength={MAX_NAME}
            placeholder="Launch at 10x users"
            hint={`Up to ${MAX_NAME} characters. Only you can see it.`}
            error={issueFor("name")}
            disabled={busy}
            onChange={(name) => set({ name })}
          />
          <SelectField
            label="Based on an app"
            value={draft.baseApp}
            options={[{ value: "", label: "Not based on an app" }, ...apps.map((a) => ({ value: a.name, label: a.title }))]}
            hint="Optional. It records which app in the footprint this scenario is about."
            error={issueFor("baseApp")}
            disabled={busy}
            onChange={(baseApp) => set({ baseApp })}
          />
        </div>
      </Panel>

      <Panel title="What it runs">
        <FieldGroup legend="Users">
          <NumberField
            label="Monthly active users"
            value={draft.users.mau}
            min={0}
            max={10_000_000}
            step="1"
            error={issueFor("users.mau")}
            disabled={busy}
            onChange={(mau) => set({ users: { ...draft.users, mau } })}
          />
          <NumberField
            label="Requests per user a month"
            value={draft.users.requestsPerUser}
            min={1}
            max={10_000}
            step="1"
            error={issueFor("users.requestsPerUser")}
            disabled={busy}
            onChange={(requestsPerUser) => set({ users: { ...draft.users, requestsPerUser } })}
          />
        </FieldGroup>

        <FieldGroup legend="Compute" columns={3}>
          <SelectField
            label="Kind"
            value={draft.compute.kind}
            options={COMPUTE_KINDS}
            error={issueFor("compute.kind")}
            disabled={busy}
            onChange={(kind) => set({ compute: { ...draft.compute, kind } })}
          />
          <NumberField
            label="Instances"
            value={draft.compute.instances}
            min={1}
            max={50}
            step="1"
            error={issueFor("compute.instances")}
            disabled={busy}
            onChange={(instances) => set({ compute: { ...draft.compute, instances } })}
          />
          <NumberField
            label="vCPU each"
            value={draft.compute.vcpu}
            min={0.25}
            max={32}
            error={issueFor("compute.vcpu")}
            disabled={busy}
            onChange={(vcpu) => set({ compute: { ...draft.compute, vcpu } })}
          />
          <NumberField
            label="Memory (GB) each"
            value={draft.compute.memoryGb}
            min={0.5}
            max={128}
            error={issueFor("compute.memoryGb")}
            disabled={busy}
            onChange={(memoryGb) => set({ compute: { ...draft.compute, memoryGb } })}
          />
          <NumberField
            label="Busy fraction"
            value={draft.compute.busyFraction}
            min={0}
            max={1}
            hint="0 to 1. Serverless is billed for this share of the 730-hour month; VMs run all month."
            error={issueFor("compute.busyFraction")}
            disabled={busy}
            onChange={(busyFraction) => set({ compute: { ...draft.compute, busyFraction } })}
          />
        </FieldGroup>

        <FieldGroup legend="Containers" columns={3}>
          <NumberField
            label="Containers"
            value={draft.containers.count}
            min={0}
            max={50}
            step="1"
            hint="0 leaves containers out of the scenario."
            error={issueFor("containers.count")}
            disabled={busy}
            onChange={(count) => set({ containers: { ...draft.containers, count } })}
          />
          <NumberField
            label="vCPU each"
            value={draft.containers.vcpu}
            min={0.25}
            max={32}
            error={issueFor("containers.vcpu")}
            disabled={busy}
            onChange={(vcpu) => set({ containers: { ...draft.containers, vcpu } })}
          />
          <NumberField
            label="Memory (GB) each"
            value={draft.containers.memoryGb}
            min={0.5}
            max={128}
            error={issueFor("containers.memoryGb")}
            disabled={busy}
            onChange={(memoryGb) => set({ containers: { ...draft.containers, memoryGb } })}
          />
          <NumberField
            label="Busy fraction"
            value={draft.containers.busyFraction}
            min={0}
            max={1}
            error={issueFor("containers.busyFraction")}
            disabled={busy}
            onChange={(busyFraction) => set({ containers: { ...draft.containers, busyFraction } })}
          />
        </FieldGroup>

        <FieldGroup legend="Database" columns={3}>
          <NumberField
            label="vCPU"
            value={draft.database.vcpu}
            min={0.25}
            max={32}
            error={issueFor("database.vcpu")}
            disabled={busy}
            onChange={(vcpu) => set({ database: { ...draft.database, vcpu } })}
          />
          <NumberField
            label="Memory (GB)"
            value={draft.database.memoryGb}
            min={0.5}
            max={128}
            error={issueFor("database.memoryGb")}
            disabled={busy}
            onChange={(memoryGb) => set({ database: { ...draft.database, memoryGb } })}
          />
          <NumberField
            label="Storage (GB)"
            value={draft.database.storageGb}
            min={1}
            max={10_000}
            error={issueFor("database.storageGb")}
            disabled={busy}
            onChange={(storageGb) => set({ database: { ...draft.database, storageGb } })}
          />
          <NumberField
            label="Read replicas"
            value={draft.database.readReplicas}
            min={0}
            max={5}
            step="1"
            error={issueFor("database.readReplicas")}
            disabled={busy}
            onChange={(readReplicas) => set({ database: { ...draft.database, readReplicas } })}
          />
        </FieldGroup>

        <FieldGroup legend="Storage, identity and load balancers" columns={3}>
          <NumberField
            label="Object storage (GB)"
            value={draft.storage.objectGb}
            min={0}
            max={100_000}
            error={issueFor("storage.objectGb")}
            disabled={busy}
            onChange={(objectGb) => set({ storage: { ...draft.storage, objectGb } })}
          />
          <NumberField
            label="Internet egress (GB a month)"
            value={draft.storage.egressGb}
            min={0}
            max={100_000}
            error={issueFor("storage.egressGb")}
            disabled={busy}
            onChange={(egressGb) => set({ storage: { ...draft.storage, egressGb } })}
          />
          <NumberField
            label="Identity: monthly active users"
            value={draft.identity.mau}
            min={0}
            max={10_000_000}
            step="1"
            hint="0 leaves managed identity out."
            error={issueFor("identity.mau")}
            disabled={busy}
            onChange={(mau) => set({ identity: { mau } })}
          />
          <NumberField
            label="Load balancers"
            value={draft.loadBalancers}
            min={0}
            max={5}
            step="1"
            error={issueFor("loadBalancers")}
            disabled={busy}
            onChange={(loadBalancers) => set({ loadBalancers })}
          />
        </FieldGroup>
      </Panel>

      <Panel title="Redundancy">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {REDUNDANCY_PARTS.map((part) => (
            <SelectField
              key={part.key}
              label={part.label}
              value={draft.redundancy[part.key]}
              options={REDUNDANCY_OPTIONS}
              error={issueFor(`redundancy.${part.key}`)}
              disabled={busy}
              onChange={(value) => setRedundancy(part.key, value)}
            />
          ))}
        </div>
        <p className="mt-3 text-sm text-muted wrap-anywhere">
          Multi-AZ uses each list&apos;s high-availability rate where there is one, else twice the instance. Serverless, object storage and identity are
          already spread over zones, so multi-AZ adds nothing there.
        </p>
      </Panel>

      <div className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
        <label className="mb-3 flex min-w-0 items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0"
            checked={conditionalCredits}
            disabled={busy}
            onChange={(e) => setConditionalCredits(e.target.checked)}
          />
          <span className="min-w-0 wrap-anywhere">
            Also apply new-account allowances (the 12-month ones). Off by default, so an estimate never understates a bill.
          </span>
        </label>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonPrimary} disabled={busy} onClick={save.run}>
            {save.pending ? "Saving…" : scenario ? "Save changes" : "Save scenario"}
          </button>
          <button type="button" className={buttonSecondary} disabled={busy} onClick={price.run}>
            {price.pending ? "Pricing…" : "Price on all four clouds"}
          </button>
          <Link href="/scenarios" className={buttonSecondary}>
            Back to scenarios
          </Link>
        </div>
        {problem && (
          <p role="alert" className="mt-3 text-sm font-medium text-danger wrap-anywhere">
            {problem}
          </p>
        )}
        {notice && !problem && (
          <p role="status" className="mt-3 text-sm font-medium text-live wrap-anywhere">
            {notice}
          </p>
        )}
        {!check.ok && (
          <p className="mt-3 text-sm text-muted wrap-anywhere">
            {issues.length} field{issues.length === 1 ? "" : "s"} need{issues.length === 1 ? "s" : ""} attention before this scenario can be saved or priced.
          </p>
        )}
      </div>

      <Panel id="results-heading" title="Cost on all four clouds">
        {stalePrice && (
          <p role="status" className="mb-3 rounded-card border border-border bg-building-soft px-3 py-2 text-sm text-building wrap-anywhere">
            These figures are for the inputs as they were. Press &quot;Price on all four clouds&quot; to price what is in the form now.
          </p>
        )}
        <CloudResults result={result} headingId="results-heading" />
      </Panel>
    </div>
  );
}
