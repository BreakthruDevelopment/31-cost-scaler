import { STACK_PROFILES, type CloudId, type StackProfile } from "@/lib/footprint/stack-profiles";
import { type PriceOptions, type Work, finishCloud, oldestFetch, priceWork, shareWork, unlisted } from "./engine";
import { HOURS_PER_MONTH_PPM, type Ppm, PPM, countPpm, decimalToPpm, mulDivRound, ppmToText, toPpm } from "./money";
import { listedSizes, snapUp } from "./table";
import { CLOUD_ORDER, type Cloud, type CloudPrice, type PriceTable } from "./types";

/**
 * What an app costs on each cloud today: the stack profile's sizes (`src/lib/footprint/stack-profiles.ts`) priced
 * from the table. The shared database or VM is split evenly across the apps on that cloud, and so is each per-unit
 * free allowance (an account's allowance is one pool). The portfolio's own sizes are listed (db.t4g.micro, B1ms,
 * e2-micro and the Ampere A1 per-OCPU and per-GB rates), so they price at their real size. A size the table does not
 * list is priced at the smallest listed size that holds it, and the line says so: that cost is then an upper bound.
 */
export type FootprintApp = { name: string; title?: string; clouds: readonly string[]; storage: boolean; secretCount: number };

/** What we assume an app does in a month, since the footprint has no traffic data. */
export type FootprintUsage = { mau: number; requestsPerUser: number };
export const DEFAULT_FOOTPRINT_USAGE: FootprintUsage = { mau: 500, requestsPerUser: 200 };

/** Busy time per request when a serverless runtime bills only while handling requests. */
export const SECONDS_PER_REQUEST = "0.25";

/** Sizes of the shared instances named in the stack profiles (a vCPU count and GB, as the vendors publish them). */
const SHARED_INSTANCE: Record<string, { vcpu: number; memoryGb: number }> = {
  "db.t4g.micro": { vcpu: 2, memoryGb: 1 },
  B_Standard_B1ms: { vcpu: 1, memoryGb: 2 },
  "e2-micro": { vcpu: 2, memoryGb: 1 },
};

export type AppCost = CloudPrice & {
  app: string;
  /** The apps this cloud's shared parts and allowances are split across. */
  appsOnCloud: number;
  assumptions: string[];
};

/** How many apps share a cloud's database or VM when `app` runs there (counting it even if it isn't listed there yet). */
export function appsOnCloud(apps: readonly FootprintApp[], app: FootprintApp, cloud: Cloud): number {
  const n = apps.filter((a) => a.clouds.includes(cloud)).length;
  return atLeastOne(app.clouds.includes(cloud) ? n : n + 1);
}
const atLeastOne = (n: number) => (n < 1 ? 1 : n);

const busyHours = (requests: bigint): Ppm => mulDivRound(requests * decimalToPpm(SECONDS_PER_REQUEST), 1n, 3600n);

function sharedWorks(cloud: Cloud, profile: StackProfile, table: PriceTable, n: bigint): Work[] {
  const s = profile.shared;
  const base = { id: "shared", component: "shared" as const, label: s.label };
  const size = s.vcpu !== undefined && s.memoryGb !== undefined ? { vcpu: s.vcpu, memoryGb: s.memoryGb } : SHARED_INSTANCE[s.instance];
  if (!size) return [unlisted(cloud, { ...base, detail: s.instance }, [`the size of ${s.instance}`])];
  const vcpu = toPpm(size.vcpu);
  const mem = toPpm(size.memoryGb);
  const family = cloud === "aws" || cloud === "azure" ? "postgres" : "vm";
  const what = `${s.label} (${s.instance}, ${size.vcpu} vCPU / ${size.memoryGb} GB)`;
  if (cloud === "oci" && table.rows(cloud, "vm.a1.ocpu").length > 0 && table.rows(cloud, "vm.a1.gb").length > 0) {
    // The portfolio's Oracle VM is an Ampere A1 Flex: billed per OCPU-hour and per GB-hour, not as an E4 size.
    const work = priceWork(
      table,
      cloud,
      {
        ...base,
        detail: `A1 Flex ${ppmToText(vcpu)} OCPU / ${ppmToText(mem)} GB x 730 h`,
        notes: [`The ${s.storageGb} GB boot volume is not priced: the table has no block-volume price.`],
        instance: { family: "vm", vcpu, memGb: mem, count: 1n, hoursPerInstance: HOURS_PER_MONTH_PPM, copies: 1n },
      },
      [
        { key: "vm.a1.ocpu", unit: "vcpu_hour", qty: mulDivRound(vcpu, HOURS_PER_MONTH_PPM, PPM) },
        { key: "vm.a1.gb", unit: "gb_hour", qty: mulDivRound(mem, HOURS_PER_MONTH_PPM, PPM) },
      ],
    );
    return [shareWork(work, n, what)];
  }
  const snapped = snapUp(listedSizes(table, cloud, family), vcpu, mem);
  if (!snapped) return [unlisted(cloud, { ...base, detail: s.instance }, [`${family} sizes`])];
  const exact = snapped.multiple === 1n && snapped.size.vcpu === vcpu && snapped.size.memGb === mem;
  const notes = [
    ...(exact ? [] : [`${s.instance} is not a listed size: priced at the smallest listed size that holds it (${snapped.size.label}), so this list cost is an upper bound.`]),
    ...(cloud === "oci" ? [`The ${s.storageGb} GB boot volume is not priced: the table has no block-volume price.`] : []),
  ];
  const count = snapped.multiple;
  const work = priceWork(
    table,
    cloud,
    {
      ...base,
      detail: `${snapped.size.label} x 730 h${s.storageGb > 0 && family === "postgres" ? `, ${s.storageGb} GB` : ""}`,
      snap: exact ? null : { requested: `${ppmToText(vcpu)} vCPU / ${ppmToText(mem)} GB`, listed: snapped.size.label, skuKey: snapped.size.key },
      notes,
      // One single-AZ instance, even when it takes `multiple` copies of the largest listed size to hold it.
      instance: { family, vcpu, memGb: mem, count, hoursPerInstance: HOURS_PER_MONTH_PPM, copies: 1n },
    },
    [
      { key: snapped.size.key, unit: "hour", qty: HOURS_PER_MONTH_PPM * count },
      ...(family === "postgres" ? [{ key: "postgres.storage", unit: "gb_month" as const, qty: countPpm(s.storageGb) }] : []),
    ],
  );
  return [shareWork(work, n, what)];
}

function appWorks(cloud: Cloud, profile: StackProfile, usage: FootprintUsage, table: PriceTable): Work[] {
  if (cloud === "oci") return []; // the apps run on the shared VM
  const requests = BigInt(usage.mau) * BigInt(usage.requestsPerUser);
  const hours = busyHours(requests);
  const mem = toPpm(profile.app.memoryGb);
  const notes = [`Busy time assumed ${SECONDS_PER_REQUEST} s per request.`];
  if (cloud === "aws") {
    return [
      priceWork(
        table,
        cloud,
        { id: "app", component: "compute", label: `${profile.app.runtime}, ${profile.app.memoryGb} GB`, detail: `${usage.mau} users x ${usage.requestsPerUser} requests, ${ppmToText(hours)} busy hours`, notes },
        [
          { key: "serverless.lambda.gb.arm64", unit: "gb_hour", qty: mulDivRound(mem, hours, PPM) },
          { key: "serverless.lambda.requests", unit: "million_requests", qty: requests },
        ],
      ),
    ];
  }
  const vcpu = toPpm(profile.app.vcpu ?? 0);
  return [
    priceWork(
      table,
      cloud,
      { id: "app", component: "compute", label: `${profile.app.runtime}, ${profile.app.vcpu} vCPU / ${profile.app.memoryGb} GB`, detail: `${usage.mau} users x ${usage.requestsPerUser} requests, ${ppmToText(hours)} busy hours`, notes },
      [
        { key: "serverless.vcpu", unit: "vcpu_hour", qty: mulDivRound(vcpu, hours, PPM) },
        { key: "serverless.gb", unit: "gb_hour", qty: mulDivRound(mem, hours, PPM) },
        { key: "serverless.requests", unit: "million_requests", qty: requests },
      ],
    ),
  ];
}

/** One app's cost on one cloud, with `n` apps sharing that cloud's shared parts and allowances. */
export function priceFootprintApp(args: { app: FootprintApp; cloud: Cloud; n: number; usage?: FootprintUsage; table: PriceTable; opts?: PriceOptions }): AppCost & { pricesAsOf: string | null } {
  const { app, cloud, table } = args;
  const usage = args.usage ?? DEFAULT_FOOTPRINT_USAGE;
  const n = BigInt(atLeastOne(args.n));
  const profile = STACK_PROFILES[cloud as CloudId];
  const works = [...appWorks(cloud, profile, usage, table), ...sharedWorks(cloud, profile, table, n)];
  const { price, rows } = finishCloud(cloud, works, table, args.opts, n);
  const notes = [...price.notes];
  if (app.storage) notes.push("This app's object-storage bucket (storage: true) is not sized, so it is not priced.");
  return {
    ...price,
    notes,
    app: app.name,
    appsOnCloud: Number(n),
    assumptions: [`${usage.mau} users x ${usage.requestsPerUser} requests a month; ${SECONDS_PER_REQUEST} s of busy time per request; shared parts and per-unit allowances split evenly across ${n} apps.`],
    pricesAsOf: oldestFetch(rows),
  };
}

/** The app priced on all four clouds (as it runs there, with the apps already on each). */
export function priceFootprintAppEverywhere(args: { app: FootprintApp; apps: readonly FootprintApp[]; usage?: FootprintUsage; table: PriceTable; opts?: PriceOptions }): Record<Cloud, AppCost> {
  const out = {} as Record<Cloud, AppCost>;
  for (const cloud of CLOUD_ORDER) out[cloud] = priceFootprintApp({ ...args, cloud, n: appsOnCloud(args.apps, args.app, cloud) });
  return out;
}

export type OutgrowsFreeTier =
  | { status: "free_through_max"; mau: null }
  | { status: "already_paying"; mau: 0 }
  | { status: "at"; mau: number };

export const MAX_MAU = 10_000_000;

/**
 * The monthly active users at which the app's net cost first turns positive on a cloud, at `requestsPerUser`.
 * Net never falls as usage rises, so a binary search over whole MAU finds the first positive value.
 * `already_paying`: net is positive with no users (a shared part has no allowance); `free_through_max`: still free at 10M MAU.
 */
export function outgrowsFreeTier(args: { app: FootprintApp; cloud: Cloud; n: number; requestsPerUser: number; table: PriceTable; opts?: PriceOptions }): OutgrowsFreeTier {
  const net = (mau: number) => priceFootprintApp({ ...args, usage: { mau, requestsPerUser: args.requestsPerUser } }).netMicros;
  if (net(0) > 0) return { status: "already_paying", mau: 0 };
  if (net(MAX_MAU) <= 0) return { status: "free_through_max", mau: null };
  let lo = 0; // net(lo) <= 0
  let hi = MAX_MAU; // net(hi) > 0
  while (hi - lo > 1) {
    const mid = lo + (hi - lo - ((hi - lo) % 2)) / 2;
    if (net(mid) > 0) hi = mid;
    else lo = mid;
  }
  return { status: "at", mau: hi };
}

