import { type PriceOptions, type Work, finishCloud, oldestFetch, priceWork, unlisted } from "./engine";
import { HOURS_PER_MONTH_PPM, type Ppm, countPpm, ppmToText, qmul, toPpm } from "./money";
import type { Redundancy, ScenarioSpec } from "./spec";
import { listedSizes, snapUp } from "./table";
import { CLOUD_LABEL, CLOUD_ORDER, type Cloud, type CloudPrice, type PriceRow, type PriceTable } from "./types";

export const DISCLAIMER = "List price estimate from public price lists at the reference region. Not a quote: no discounts, committed use, tax or support.";

export const ASSUMPTIONS: readonly string[] = [
  "A month is 730 hours. VMs and databases run all month; serverless is billed for the busy fraction of the month.",
  "Serverless requests are users x requests per user a month, charged only where the cloud lists a per-request price.",
  "Sizes snap up to the nearest size the cloud lists; each line says when it did.",
  "Multi-AZ uses the list's high-availability rate where there is one, else twice the instance. Serverless, object storage and identity are already spread over zones, so multi-AZ adds nothing there.",
  "Multi-region doubles compute, containers, database, storage and load balancers, and adds inter-region transfer for the replicated database and object storage at the internet egress rate.",
  "Read replicas are the database instance price times the number of replicas (replica storage is not added).",
  "A load balancer is one capacity unit per hour where the cloud bills capacity units, and its data processed is the egress volume where the cloud bills per GB.",
  "Free-tier allowances are separate credit lines, each with its source. Allowances for new accounts (12 months) are applied only when asked.",
];

export type ScenarioPrice = {
  /** The oldest fetch date among the price rows used. */
  pricesAsOf: string | null;
  clouds: Record<Cloud, CloudPrice>;
  /** Lowest net among clouds with every line listed; when none is complete, the lowest among clouds with any priced line. */
  cheapest: Cloud | null;
  /** False when `cheapest` is picked among incomplete totals. */
  cheapestIsComplete: boolean;
  conditionalCreditsApplied: boolean;
  assumptions: string[];
  disclaimer: string;
};

const SINGLE_FACTOR = 1n;
/** Instance-like components (VMs, serverless, load balancers): a second copy for multi-AZ (VMs only) and multi-region. */
const factorVm = (r: Redundancy) => (r === "single" ? SINGLE_FACTOR : 2n);
const factorRegional = (r: Redundancy) => (r === "multi_region" ? 2n : SINGLE_FACTOR);

const hoursFor = (count: bigint): Ppm => count * HOURS_PER_MONTH_PPM;
const sizeText = (vcpu: Ppm, memGb: Ppm) => `${ppmToText(vcpu)} vCPU / ${ppmToText(memGb)} GB`;
const redText = (r: Redundancy) => (r === "single" ? "" : r === "multi_az" ? ", multi-AZ" : ", multi-region");

type Run = { spec: ScenarioSpec; cloud: Cloud; table: PriceTable };

function serverlessParts(vcpu: Ppm, memGb: Ppm, busy: Ppm, count: bigint) {
  const busyHours = qmul(busy, HOURS_PER_MONTH_PPM);
  return [
    { key: "serverless.vcpu", unit: "vcpu_hour" as const, qty: qmul(vcpu, busyHours) * count },
    { key: "serverless.gb", unit: "gb_hour" as const, qty: qmul(memGb, busyHours) * count },
  ];
}

function computeLine({ spec, cloud, table }: Run): Work {
  const c = spec.compute;
  const vcpu = toPpm(c.vcpu);
  const mem = toPpm(c.memoryGb);
  const red = spec.redundancy.compute;
  const requests = BigInt(spec.users.mau) * BigInt(spec.users.requestsPerUser); // millions of requests, in ppm
  if (c.kind === "vm") {
    const base = { id: "compute", component: "compute" as const, label: "Compute (VM)" };
    const snapped = snapUp(listedSizes(table, cloud, "vm"), vcpu, mem);
    if (!snapped) return unlisted(cloud, { ...base, detail: `${c.instances} x ${sizeText(vcpu, mem)}` }, ["vm sizes"]);
    const factor = factorVm(red);
    const count = BigInt(c.instances) * snapped.multiple * factor;
    const exact = snapped.multiple === 1n && snapped.size.vcpu === vcpu && snapped.size.memGb === mem;
    return priceWork(
      table,
      cloud,
      {
        ...base,
        detail: `${c.instances} x ${snapped.size.label}${snapped.multiple > 1n ? ` x ${snapped.multiple}` : ""}${redText(red)} x 730 h`,
        snap: exact ? null : { requested: sizeText(vcpu, mem), listed: `${snapped.size.label}${snapped.multiple > 1n ? ` x ${snapped.multiple}` : ""}`, skuKey: snapped.size.key },
        notes: [
          ...(exact ? [] : [`Snapped up from ${sizeText(vcpu, mem)} to the listed ${snapped.size.label}${snapped.multiple > 1n ? ` (x${snapped.multiple})` : ""}.`]),
          ...(red === "multi_az" ? ["No high-availability rate for VMs: priced as 2x the instance."] : []),
        ],
        instance: { family: "vm", vcpu, memGb: mem, count, hoursPerInstance: HOURS_PER_MONTH_PPM },
      },
      [{ key: snapped.size.key, unit: "hour", qty: hoursFor(count) }],
    );
  }
  const factor = factorRegional(red);
  const notes: string[] = [];
  if (red === "multi_az") notes.push("Serverless already runs across zones: multi-AZ adds nothing.");
  const hasRequestPrice = table.rows(cloud, "serverless.requests").length > 0;
  if (requests > 0n && !hasRequestPrice) notes.push(`No per-request price is listed on ${CLOUD_LABEL[cloud]}: requests are not charged.`);
  const count = BigInt(c.instances) * factor;
  return priceWork(
    table,
    cloud,
    { id: "compute", component: "compute", label: "Compute (serverless)", detail: `${c.instances} x ${sizeText(vcpu, mem)}, busy ${ppmToText(toPpm(c.busyFraction))} of 730 h${redText(red)}`, notes },
    [...serverlessParts(vcpu, mem, toPpm(c.busyFraction), count), { key: "serverless.requests", unit: "million_requests", qty: requests, optional: true }],
  );
}

function containersLine({ spec, cloud, table }: Run): Work | null {
  const c = spec.containers;
  if (c.count === 0) return null;
  const red = spec.redundancy.containers;
  const factor = factorRegional(red);
  return priceWork(
    table,
    cloud,
    {
      id: "containers",
      component: "containers",
      label: "Containers (serverless)",
      detail: `${c.count} x ${sizeText(toPpm(c.vcpu), toPpm(c.memoryGb))}, busy ${ppmToText(toPpm(c.busyFraction))} of 730 h${redText(red)}`,
      notes: red === "multi_az" ? ["Serverless containers already run across zones: multi-AZ adds nothing."] : [],
    },
    serverlessParts(toPpm(c.vcpu), toPpm(c.memoryGb), toPpm(c.busyFraction), BigInt(c.count) * factor),
  );
}

function databaseLines({ spec, cloud, table }: Run): Work[] {
  const d = spec.database;
  const red = spec.redundancy.database;
  const vcpu = toPpm(d.vcpu);
  const mem = toPpm(d.memoryGb);
  const base = { id: "database", component: "database" as const, label: "Database (PostgreSQL)" };
  const snapped = snapUp(listedSizes(table, cloud, "postgres"), vcpu, mem);
  if (!snapped) {
    const out = [unlisted(cloud, { ...base, detail: `${sizeText(vcpu, mem)}, ${d.storageGb} GB` }, ["postgres sizes"])];
    if (d.readReplicas > 0) out.push(unlisted(cloud, { id: "read_replicas", component: "read_replicas", label: "Read replicas", detail: `${d.readReplicas} x ${sizeText(vcpu, mem)}` }, ["postgres sizes"]));
    return out;
  }
  const { size, multiple } = snapped;
  const exact = multiple === 1n && size.vcpu === vcpu && size.memGb === mem;
  const snap = exact ? null : { requested: sizeText(vcpu, mem), listed: `${size.label}${multiple > 1n ? ` x ${multiple}` : ""}`, skuKey: size.key };
  const notes = exact ? [] : [`Snapped up from ${sizeText(vcpu, mem)} to the listed ${size.label}${multiple > 1n ? ` (x${multiple})` : ""}.`];
  const haKey = `${size.key}.ha`;
  const haStorage = "postgres.storage.ha";
  const hasHa = table.rows(cloud, haKey).length > 0;
  const hasHaStorage = table.rows(cloud, haStorage).length > 0;
  const storage = toPpm(d.storageGb);
  const hours = hoursFor(multiple);
  let parts;
  if (red === "multi_az") {
    parts = [
      hasHa ? { key: haKey, unit: "hour" as const, qty: hours } : { key: size.key, unit: "hour" as const, qty: hours * 2n },
      hasHaStorage ? { key: haStorage, unit: "gb_month" as const, qty: storage } : { key: "postgres.storage", unit: "gb_month" as const, qty: storage * 2n },
    ];
    if (!hasHa) notes.push("No high-availability instance rate is listed: priced as 2x the instance.");
    if (!hasHaStorage) notes.push("No high-availability storage rate is listed: priced as 2x the storage.");
  } else {
    const k = red === "multi_region" ? 2n : 1n;
    parts = [
      { key: size.key, unit: "hour" as const, qty: hours * k },
      { key: "postgres.storage", unit: "gb_month" as const, qty: storage * k },
    ];
  }
  const lines = [
    priceWork(
      table,
      cloud,
      {
        ...base,
        detail: `${size.label}${multiple > 1n ? ` x ${multiple}` : ""}${redText(red)}, ${d.storageGb} GB, 730 h`,
        snap,
        notes,
        instance: { family: "postgres", vcpu, memGb: mem, count: multiple * (red === "single" ? 1n : 2n), hoursPerInstance: HOURS_PER_MONTH_PPM },
      },
      parts,
    ),
  ];
  if (d.readReplicas > 0) {
    lines.push(
      priceWork(
        table,
        cloud,
        { id: "read_replicas", component: "read_replicas", label: "Read replicas", detail: `${d.readReplicas} x ${size.label}${multiple > 1n ? ` x ${multiple}` : ""}, 730 h`, snap, notes: ["Replica storage is not added."] },
        [{ key: size.key, unit: "hour", qty: hoursFor(BigInt(d.readReplicas) * multiple) }],
      ),
    );
  }
  return lines;
}

function storageLines({ spec, cloud, table }: Run): Work[] {
  const out: Work[] = [];
  const { objectGb, egressGb } = spec.storage;
  const red = spec.redundancy.storage;
  if (objectGb > 0) {
    const k = factorRegional(red);
    out.push(
      priceWork(
        table,
        cloud,
        {
          id: "object_storage",
          component: "object_storage",
          label: "Object storage",
          detail: `${objectGb} GB${redText(red)}`,
          notes: red === "multi_az" ? ["Object storage is already spread over zones: multi-AZ adds nothing."] : [],
        },
        [{ key: "object_storage.gb", unit: "gb_month", qty: toPpm(objectGb) * k }],
      ),
    );
  }
  if (egressGb > 0) {
    out.push(priceWork(table, cloud, { id: "egress", component: "egress", label: "Internet egress", detail: `${egressGb} GB` }, [{ key: "egress.gb", unit: "gb", qty: toPpm(egressGb) }]));
  }
  const replicated = (spec.redundancy.database === "multi_region" ? toPpm(spec.database.storageGb) : 0n) + (red === "multi_region" ? toPpm(objectGb) : 0n);
  if (replicated > 0n) {
    out.push(
      priceWork(
        table,
        cloud,
        {
          id: "inter_region_transfer",
          component: "inter_region_transfer",
          label: "Inter-region transfer",
          detail: `${ppmToText(replicated)} GB replicated once a month, at the internet egress rate`,
        },
        [{ key: "egress.gb", unit: "gb", qty: replicated }],
      ),
    );
  }
  return out;
}

function identityLine({ spec, cloud, table }: Run): Work | null {
  if (spec.identity.mau === 0) return null;
  const red = spec.redundancy.identity;
  return priceWork(
    table,
    cloud,
    { id: "identity", component: "identity", label: "Identity", detail: `${spec.identity.mau} monthly active users`, notes: red === "single" ? [] : ["Managed identity is already multi-zone and global: redundancy adds nothing."] },
    [{ key: "identity.mau", unit: "mau", qty: countPpm(spec.identity.mau) }],
  );
}

function loadBalancerLine({ spec, cloud, table }: Run): Work | null {
  const n = spec.loadBalancers;
  if (n === 0) return null;
  const red = spec.redundancy.loadBalancers;
  const k = BigInt(n) * factorRegional(red);
  return priceWork(
    table,
    cloud,
    {
      id: "load_balancer",
      component: "load_balancer",
      label: "Load balancer",
      detail: `${n} x 730 h${redText(red)}`,
      notes: red === "multi_az" ? ["Load balancers already span zones: multi-AZ adds nothing."] : [],
    },
    [
      { key: "load_balancer.hour", unit: "hour", qty: hoursFor(k) },
      { key: "load_balancer.capacity", unit: "hour", qty: hoursFor(k), optional: true },
      { key: "load_balancer.data", unit: "gb", qty: toPpm(spec.storage.egressGb), optional: true },
    ],
  );
}

/** Price one cloud's lines for a scenario. Exposed for the tests; callers use `priceScenario`. */
export function priceScenarioCloud(spec: ScenarioSpec, cloud: Cloud, table: PriceTable, opts: PriceOptions = {}): { price: CloudPrice; rows: PriceRow[] } {
  const run: Run = { spec, cloud, table };
  const works: Work[] = [computeLine(run), containersLine(run), ...databaseLines(run), ...storageLines(run), identityLine(run), loadBalancerLine(run)].filter((w): w is Work => w !== null);
  return finishCloud(cloud, works, table, opts);
}

/** Pick the cheapest cloud by net, then list total, then the fixed cloud order. */
export function pickCheapest(clouds: Record<Cloud, CloudPrice>): { cheapest: Cloud | null; complete: boolean } {
  const rank = (pool: CloudPrice[]) =>
    [...pool].sort((a, b) => a.netMicros - b.netMicros || a.totalMicros - b.totalMicros || CLOUD_ORDER.indexOf(a.cloud) - CLOUD_ORDER.indexOf(b.cloud))[0];
  const complete = CLOUD_ORDER.map((c) => clouds[c]).filter((c) => c.complete);
  if (complete.length > 0) return { cheapest: rank(complete).cloud, complete: true };
  const partial = CLOUD_ORDER.map((c) => clouds[c]).filter((c) => c.lines.some((l) => l.status === "priced"));
  return partial.length > 0 ? { cheapest: rank(partial).cloud, complete: false } : { cheapest: null, complete: false };
}

/** Price a scenario on all four clouds. Pure: the same spec and table always give the same result. */
export function priceScenario(spec: ScenarioSpec, table: PriceTable, opts: PriceOptions = {}): ScenarioPrice {
  const done = CLOUD_ORDER.map((cloud) => priceScenarioCloud(spec, cloud, table, opts));
  const clouds = Object.fromEntries(done.map((d) => [d.price.cloud, d.price])) as Record<Cloud, CloudPrice>;
  const { cheapest, complete } = pickCheapest(clouds);
  return {
    pricesAsOf: oldestFetch(done.flatMap((d) => d.rows)),
    clouds,
    cheapest,
    cheapestIsComplete: complete,
    conditionalCreditsApplied: opts.conditionalCredits === true,
    assumptions: [...ASSUMPTIONS],
    disclaimer: DISCLAIMER,
  };
}

