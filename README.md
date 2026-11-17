# Cloud Cost Scaler

> What will this cost next year, and on which cloud — answered from published price lists, with every figure
> traceable to its source.

**URL:** https://app31.breakthruventures.ai (**not live yet**: the first deploy goes out on the Cloud Run default
URL, and the custom domain is added in a second step — spec 31.9 then 31.10) · **Runs on:** Google Cloud ·
Part of [30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What this app does

Anyone who runs software in the cloud eventually has to answer a question a billing console cannot answer: *what
will this cost when it is ten times bigger, and would it be cheaper somewhere else?* The cloud consoles show what
you already spent. Vendor calculators price one cloud at a time, in that vendor's own units, and a total rarely
says which parts of the stack it could not price. The result is a number nobody can defend in a meeting.

The **Cloud Cost Scaler** prices a stack against the public list prices of AWS, Azure, Google Cloud and Oracle
Cloud, normalized onto the same components and units, and shows the arithmetic. It does three things:

- **The portfolio footprint.** It imports `apps.yaml` from the portfolio's infrastructure repo and prices every app
  on all four clouds as it runs today, with each cloud's always-free allowances shown as their own negative lines
  (`/`, `/footprint`, `/footprint/<app>`).
- **Scenarios.** A signed-in user describes the users, compute, containers, database, storage, identity and
  redundancy they expect, prices it on all four clouds, saves it, and compares saved scenarios side by side
  (`/scenarios`, `/scenarios/new`, `/scenarios/compare`).
- **A verdict on moving.** For each app and each other cloud, it computes the monthly saving, the one-time cost of
  migrating from a checked-in effort table, the months to pay that back, any blockers, and a verdict — move,
  consider, stay, blocked, or not enough data.

The AI feature is an **advisor** that answers questions in words about those tables. It cannot produce a number of
its own; see "The AI feature" below.

## The four things that make this app honest

### 1. "This costs nothing" and "we have no price for this" are different sentences

This is the claim the app is built around, so it comes first. A missing price is never a zero. When a component's
price is not in the table, the line reads `not listed` and is **left out of the total**; the cloud's total is then
marked `Incomplete` rather than shown, and that cloud is left out of the ranking (`CloudPrice.complete` and
`unlistedCount` in `src/lib/pricing/types.ts`; the page copy in `src/app/footprint/[app]/page.tsx`). Where no app
has a complete price at all, the landing page says so in as many words and adds: *"This is a gap in the price
table, not a free deployment: an amount appears only once every component it needs is listed, and a missing price
is never counted as $0.00."* (`NoTotals` in `src/app/page.tsx`).

Two smaller rules back it up:

- A cloud with **no price rows loaded** gets its own banner ("prices unavailable… never counted as $0") and no
  figure at all (`PriceBanners` in `src/components/footprint/notices.tsx`).
- A real amount **below a cent** prints as `<$0.01`, not `$0.00` (`usd()` in `src/components/footprint/format.ts`).
  So `$0.00` on a screen means exactly one thing: a complete total that genuinely came to zero.

### 2. The engine's contract: a list estimate never understates a bill

Every pricing function takes the same options object, whose first line states the rule: *a list estimate never
understates a bill* (`PriceOptions` in `src/lib/pricing/engine.ts`). Two consequences are visible in the product:

- **The 12-month new-account allowances are off by default.** They are marked `period: "12_months"` in
  `src/lib/pricing/free-tiers.ts` and applied only when asked for; when they are skipped the result carries the
  note "New-account allowances (12 months) are not applied." Net figures are labelled *after always-free
  allowances* so nobody mistakes them for a steady-state bill.
- **A pooled allowance is spent on the cheapest units first.** Some allowances are shared rather than per-SKU: AWS
  publishes one 400,000 GB-second Lambda pool that both the x86 and the arm64 meter draw from (`pool:
  "aws.lambda.gb"` in `free-tiers.ts`), and one instance-hour allowance can cover more than one eligible line.
  Whoever draws first keeps the credit, so the draw order decides the bill — and the vendor documents the quantity
  without documenting which meter a credit comes off. There is no ground truth to be accurate against. The engine
  therefore credits the **cheapest** units first, which is the smallest credit the allowance can defensibly
  produce; a vendor that turns out to be more generous can only make the real bill smaller than this estimate.
  Ordering comes from the price table and is broken by SKU key or line id, never by file order, so every
  permutation of the inputs gives the same answer (`poolDraws` and `instanceClaims` in `engine.ts`, asserted over
  permuted tier lists in `src/lib/pricing/pricing.test.ts`).

The same conservatism runs through the rest: a size the table does not list is priced at the **smallest listed size
that holds it**, and the line says so and calls itself an upper bound; rankings and savings use the **list** total,
never the allowance-adjusted one, because allowances belong to an account and change with whatever else that
account runs; and amounts are integer micro-dollars throughout, so nothing is lost to floating point.

### 3. What this app does not do

- It **estimates from published list prices**, in one reference region per cloud (`us-east-2`, `eastus`,
  `us-central1`, and Oracle's global list — `REGIONS` in `src/lib/price-ingest/types.ts`). No discounts, committed
  use, reservations, spot, tax or support.
- It is **not connected to anyone's billing account** and holds no cloud credentials. It reads public price lists
  and one public YAML file. It **cannot see real usage**: where traffic is unknown it assumes a figure and prints
  the assumption (500 users × 200 requests a month, 0.25 s of busy time per request, a 730-hour month —
  `DEFAULT_FOOTPRINT_USAGE` and `SECONDS_PER_REQUEST` in `src/lib/pricing/footprint.ts`).
- It is **not a quote and not advice about where to host**. Every page says so once, near the top
  (`ListPriceNote`); the engine's own one-liner is *"List price estimate from public price lists at the reference
  region. Not a quote: no discounts, committed use, tax or support."* (`DISCLAIMER` in
  `src/lib/pricing/scenario.ts`).
- The verdict thresholds are **a policy, not a fact**: $100 an hour of migration effort, move at a six-month
  break-even, consider at eighteen. They are written down in one place and shown on the page that uses them.

### 4. The AI feature cannot invent a number

The advisor writes sentences. Every figure it shows is re-read from a recorded tool result on the server, and the
verdict comes from code. That is a section of its own, below.

## Who sees what

| Audience | Can see | Notes |
| --- | --- | --- |
| **Anyone, signed out** | The landing page, the price table (`/prices`), the portfolio footprint and each app's page, and the move analysis at the 10× preset | Public reads only. Every public page counts one request against a per-IP limit of 60 a minute (`PUBLIC_LIMIT_PER_MINUTE` in `src/lib/ip-limit.ts`); over it, the page itself says to wait a minute |
| **Signed-in user** | Everything above, plus their own scenarios, comparisons and advisor answers | Private to the owner. An admin cannot read them either: another user's id answers 404, never "forbidden" (`ACCESS_RULES` in `src/lib/access.ts`) |
| **Admin** | `/admin`: counts, the price-refresh log, quarantined prices and stack-profile drift, and a "Refresh now" button | Counts only. No scenario, saved result or advice content is readable by an admin |
| **Scheduler** | `POST /api/prices/refresh` with a bearer token | One source per run; unset token means the route is closed |

## The price table

`/prices` is the whole table, public: one row per normalized price, with its SKU key, component, list price and
unit, tier range, region, the **source link** and the date it was fetched. Filter by cloud and component; the
filters are a GET form, so a filtered view can be linked.

Two notes on reading it:

- A cloud with more than **40 rows** starts **folded** (`ROWS_OPEN_BY_DEFAULT` in `src/app/prices/page.tsx`); the
  whole table is thousands of rows, which at 375px is a page nobody can scroll. The rows stay in the HTML, so the
  server response and `curl | grep` find them — but the browser's **find-in-page does not**: a folded panel is
  `hidden`, which is `display: none`, and Ctrl+F skips that subtree (`src/components/ui/CollapsiblePanel.tsx`). Use
  the cloud and component filters to narrow the table instead.
- One request returns at most **2,000 rows** (`MAX_PRICE_ROWS` in `src/lib/prices.ts`); the page says when it
  trimmed and tells you to filter.

### Where the prices come from, and how they are kept honest

| Cloud | Source |
| --- | --- |
| AWS | The public offer files (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/us-east-2/index.csv`), streamed and filtered line by line |
| Azure | The Retail Prices API, narrowed in the query itself to the reference sizes and products that are read |
| Google Cloud | The Cloud Billing Catalog API — needs `COST_SCALER_GCP_PRICING_API_KEY`; without it Google Cloud is recorded as **prices unavailable** rather than guessed |
| Oracle Cloud | The public price-list API, filtered to the part numbers the app prices |

Refresh rules (`src/lib/price-ingest/refresh.ts`, `src/lib/price-ingest/upsert.ts`):

- **One source per run.** The scheduler fires five times a night; each run takes the stalest source whose last
  success is more than **20 hours** old, ordered by last *attempt*, so a source that keeps failing rotates to the
  back instead of starving the others. A Postgres advisory lock on its own connection keeps two runs from
  overlapping. An admin's "Refresh now" does one run and is allowed once every **10 minutes**
  (`ADMIN_REFRESH_WINDOW_SECONDS`).
- **Groups fail alone.** A failed service file is recorded with a fixed error code and leaves its existing rows
  untouched; the other groups still land. Errors are stored as codes, never as vendor text or URLs.
- **Quarantine.** A fetched price outside its sanity bounds for the unit, or more than **3×** away from the stored
  one in either direction (`JUMP_FACTOR`), does not replace it: the previous value stays active and the row is
  marked `quarantined`. The public table hides quarantined rows; `/admin` lists them with **both** numbers — what
  was refused and what the estimates still use — so the two can be compared before anyone widens the bounds.
- **Staleness is shown, not hidden.** When the newest fetch on any cloud is more than **72 hours** old
  (`STALE_AFTER_HOURS` in `src/lib/footprint-calc.ts`), every page carrying figures shows a banner with the newest
  fetch date per cloud.

## The portfolio footprint

The footprint is imported from `apps.yaml` in
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) over a fixed URL
(`src/lib/footprint/refresh.ts`), through `safeFetch`: no redirects, a byte cap, public addresses only. Everything
in the file is treated as data — titles have control characters replaced and are length-capped before they reach
the database (`src/lib/footprint/apps-yaml.ts`). Each import records `footprint_app.source_commit`, which is a short
**content hash of the YAML that was fetched**, not a git commit: `raw.githubusercontent.com` does not expose one.

For each app, each cloud shows the component lines with their arithmetic in words, the free-tier credits as their
own negative lines with the vendor page that states them, the net, and **"outgrows free tier at"** — the monthly
active users at which net cost first turns positive, found by binary search up to 10,000,000 users
(`outgrowsFreeTier` in `src/lib/pricing/footprint.ts`). Shared parts (one database, one VM) and per-unit allowances
are split evenly across the apps on that cloud, and the page says across how many.

### "Should this app move?"

Per target cloud (`src/lib/pricing/move.ts`), priced at the 10× users preset:

- **Monthly saving** on list totals, on both sides.
- **One-time cost**: a checked-in effort table — 2 h to add the cloud in `apps.yaml`, 4 h plus 0.05 h per GB to move
  the database, 0.5 h per per-app secret, 2 h for object storage — at **$100 an hour** by default, plus the one-time
  egress of the data leaving the source cloud at its list rate.
- **Break-even**, and the verdict: **move** when it pays back in **6 months** or less *and* saves at least **$10 a
  month**; **consider** within **18 months**; otherwise **stay**. Blockers win over arithmetic (object storage runs
  only on Google Cloud here; Oracle Cloud does not read per-app secrets), and anything with an incomplete price on
  either side is **not enough data** — with, where it helps, a clearly-labelled like-for-like figure over only the
  components both clouds list, and a list of what was left out.

All comparisons are exact integer arithmetic, and every threshold in the page's prose comes from the constant the
engine uses, so the two cannot drift.

## Scenarios

Signed in: `/scenarios/new` builds a spec — users and requests each, compute (serverless or VMs, with size and busy
fraction), containers, database (size, storage, read replicas), object storage and egress, identity MAU, load
balancers, and a redundancy choice per part. "Price" prices it on all four clouds without saving. Bounds are in
`src/lib/pricing/spec.ts`; there is no free text in a spec except a base-app name, so a spec cannot carry a prompt.

- **50 scenarios per user** (`MAX_SCENARIOS_PER_USER`), **120 pricing runs per user per hour**
  (`PRICE_RUNS_PER_HOUR` in `src/lib/pricing/data.ts`).
- **Retries never duplicate.** A save carries a client op id held in a ref until the server answers; a unique index
  on (owner, op id) means a retried save returns the first row. Edits use a version number, and a stale one is a
  409.
- **Compare 2 to 3** of your own scenarios (`MIN_COMPARE`/`MAX_COMPARE` in `src/lib/scenario-compare.ts`). The
  selection travels in the URL, so a comparison can be bookmarked, and the page warns when the scenarios were
  priced from price lists fetched on different dates.

## The AI feature: the advisor

`/advisor`, signed-in only. You ask a question in words ("should the helpdesk app move to Oracle Cloud?"), optionally
pointing at an app or one of your own scenarios, and get back a headline, a recommendation, an explanation, caveats
and a list of figures — each figure labelled with the tool call it came from.

**It runs as an ADK team, with fallbacks — both of the engines the branch history argued about shipped, in a
chain.** `runAgent()` (`src/lib/ai/agent.ts`) is the single entry point, and `@google/adk` 2.5.0 is a real
dependency in `package.json`:

1. **Team** — an ADK coordinator with two specialists wrapped as `AgentTool`s: `pricing` (footprint, price lookups,
   scenario pricing) and `migration` (the break-even analysis). The coordinator has **no price tools** and writes the
   answer; a specialist receives a structured request, never the user's raw words. Up to 3 delegations
   (`TEAM_MAX_DELEGATIONS`).
2. **Single ADK agent** with all four tools, if the team fails.
3. **`generate({ tools })`** over the same tools, if ADK fails to import or the provider errors.
4. **A recorded demo script over the real tools** — used when there is no model key, when the day's budget is spent,
   or after a quota error, and always labelled as a demo answer on screen.

Which engine answered is stored with the answer (`checks.engine`: `team`, `adk`, `generate` or `demo`), along with
every attempt and why each fell through, so the history is auditable rather than reassuring.

**Model:** Gemini (`gemini-flash-lite-latest` by default, `AI_MODEL` overrides) on a key whose project has no
billing linked.

**How it is kept safe:**

- **Numbers come from tools, not from the model.** The answer's zod schema makes every figure cite a recorded call
  id and a JSON pointer into that call's result. The server re-reads the number at that pointer, requires it to
  match to the cent, requires the path to be one with a known meaning, and **writes the label and unit itself**.
  Anything that fails is dropped and listed on the card in plain words ("it cited a tool call that never ran").
  (`checkAdvice` in `src/lib/advice-checks.ts`.)
- **Digits are stripped from prose.** Numbers and number words in the headline, explanation and caveats that are not
  a surviving figure are removed, and the count is shown. A verdict's reasons, written by code, are kept verbatim.
- **The verdict comes from code.** If `migrationBreakEven` ran, its verdict *is* the recommendation; if it never
  ran, the answer cannot recommend a move — it becomes `not_enough_data` with a caveat saying why. Blockers from
  the code are added as caveats.
- **A specialist is not trusted either.** Its reply is parsed by the server, findings it did not earn are dropped,
  and each surviving number is re-read from the recorded tool result before the coordinator ever sees it. After the
  coordinator answers, any figure no specialist reported is dropped too. (`src/lib/ai/agent-team.ts`.)
- **User content is data.** Both the coordinator's and the specialists' system text say the question, scenario names
  and app titles are data and never instructions, and the question is sent JSON-quoted. Tools are read-only and
  closed over the acting user, so the model supplies arguments, never who is asking: someone else's scenario id is
  the same "not found" as a made-up one.
- **Caps and budgets.** A question is at most 500 characters (`ADVICE_QUESTION_MAX`); 4 questions per user per hour
  and 12 per 24 hours (`ADVICE_PER_HOUR`, `ADVICE_PER_DAY`); at most 9 tool calls per question
  (`AGENT_MAX_TOOL_CALLS`), 10 model calls for the team and 14 for the whole chain (`TEAM_MAX_LLM_CALLS`,
  `QUESTION_MAX_LLM_CALLS`); 20 s per model call, 50 s for the team and 90 s for the question. The app's daily
  budget is `floor(GEMINI_DAILY_REQUESTS × ADVISOR_GEMINI_SHARE)` — 50 with the defaults in `.env.example` — and is
  reserved up front and settled on the requests actually sent, so a crash cannot lose the allowance.
- **Idempotent.** A question carries a client op id; retrying returns the stored answer and is not charged, and a
  double tap waits for the first run instead of starting a second.
- **Logs carry codes, never content.** Task, engine, tool names, outcomes and timings — never the question,
  arguments or results.

Answers are private to the asker (50 are kept) and are never readable by an admin.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Google Cloud Run ──► Next.js container (App Router)
       │              auth + roles, zod at every boundary, per-IP and per-user limits, JSON logs
       ├──► Postgres (Drizzle; migrations run at startup)
       ├──► Public price lists: AWS offer files, Azure Retail Prices, Google Cloud Billing Catalog, Oracle list
       ├──► raw.githubusercontent.com/BreakthruDevelopment/30-apps-infra: apps.yaml + the Terraform stacks
       └──► Gemini (via Google ADK), or the recorded demo script
            ▲
   Cloud Scheduler ──► POST /api/prices/refresh (bearer token), five times a night, one source per run
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Access rules (one row per table) | `src/lib/access.ts`, called by every data function |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth) |
| Pricing engine (pure) | `src/lib/pricing/` — `engine.ts`, `free-tiers.ts`, `footprint.ts`, `scenario.ts`, `move.ts` |
| Price ingestion | `src/lib/price-ingest/` — fetch, parse, normalize, quarantine, upsert |
| Footprint import and drift check | `src/lib/footprint/` |
| The advisor | `src/lib/advisor.ts`, `advisor-team.ts`, `advice-tools.ts`, `advice-checks.ts`, `advice-store.ts` |
| Agent runtime and guardrails | `src/lib/ai/` — `agent.ts` (ADK), `agent-team.ts`, `index.ts` (`generate()`), `demo.ts` |
| Per-IP and per-user limits | `src/lib/ip-limit.ts`, `src/lib/usage.ts` |
| Health check | `GET /api/health` |

### API

| Path | Who | What |
| --- | --- | --- |
| `GET /api/prices` | public | Active price rows, filtered by cloud and component |
| `GET /api/footprint` | public | The imported footprint rows (apps, clouds, storage flag, secret count) |
| `GET /api/move` | public; signed-in for `?scenario=` | The move analysis; a scenario basis only for its owner |
| `POST /api/price` | signed-in, same-origin | Price an unsaved spec on all four clouds (16 KB, 120/hour) |
| `GET`/`POST /api/scenarios`, `GET`/`PATCH`/`DELETE /api/scenarios/:id` | owner only | Scenarios; a foreign id is 404 |
| `POST`/`GET /api/advice` | signed-in | Ask the advisor; list your own answers |
| `POST /api/prices/refresh` | scheduler bearer token, or an admin | One refresh run |
| `GET /api/admin/stats` | admin | Counts and price health |
| `GET /api/health` | public | Liveness and database check |

## Security

- **Authorize on the server, every time.** Pages call `requireUserOrRedirect()` / `requireRoleOrRedirect()`; route
  handlers and server actions call `requireUser()` / `requireRole()`; every data function takes the acting user and
  calls `assertCan()` before touching a table. The integration tests walk `ACCESS_RULES`, so a new rule cannot ship
  without a test (`test/*.integration.test.ts`).
- **Private means private.** Scenarios, saved results and advice belong to `owner_id`. Queries add an owner filter
  in SQL as well as the check in code, and a row that is not yours answers **404**, so ids cannot be probed. Admins
  see counts only.
- **Writes to public tables** (prices, footprint) are only made by the refresh job — the `SYSTEM` subject or an
  admin pressing the button — never by a request.
- **Input.** zod at every boundary, free text through `text()` (trimmed, capped, NUL bytes rejected), `jsonHasNul`
  for JSON payloads, bounded numbers in every spec, and same-origin checks on the mutating routes.
- **Outbound fetches** go to fixed hosts through `safeFetch`: no redirects, byte caps, public addresses only, so a
  price source cannot become an SSRF.
- **Secrets** come from the cloud's secret manager; `.env.local` is git-ignored. Error messages to clients are our
  own wording with fixed codes — never vendor text, URLs or stack traces (`errorResponse`).

## Environment variables

Names only; never commit values.

| Variable | Description |
| --- | --- |
| `APP_NAME`, `APP_URL` | Display name; public base URL for cookies and auth redirects |
| `DATABASE_URL` | Postgres connection string |
| `BETTER_AUTH_SECRET` | 32+ characters, session encryption |
| `AI_PROVIDER`, `AI_MODEL` | `demo`, `gemini` or `anthropic`; optional model override |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model keys. Without one, the advisor answers from the recorded demo |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS` | Fall back to the demo on quota or provider failure; per-call timeout |
| `GEMINI_DAILY_REQUESTS`, `ADVISOR_GEMINI_SHARE` | The key's free daily allowance and the advisor's share of it |
| `COST_SCALER_REFRESH_TOKEN` | Bearer token for the scheduled price refresh; unset closes the route |
| `COST_SCALER_GCP_PRICING_API_KEY` | Google Cloud Billing Catalog API key; unset shows Google Cloud as "prices unavailable" |
| `MIGRATE_ON_START`, `LOG_LEVEL` | Run migrations at startup; log level |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` | Optional, for `pnpm db:seed` |

## Run locally

```bash
cp .env.example .env.local          # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm seed:prices                    # synthetic price fixtures (test/fixtures/prices), no network
pnpm seed:footprint                 # the checked-in apps.yaml fixture, no network
pnpm dev                            # http://localhost:3000
```

To make yourself an admin, sign up first, then, while the app is running:

```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=your-secure-password pnpm db:seed
```

With no model key the advisor answers from the recorded demo script over the real tools, which is what CI uses.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests and types
TEST_DATABASE_URL=postgres://... pnpm test # adds the Postgres integration tests
pnpm build && pnpm smoke                   # build, then the end-to-end smoke test against a running app
```

`pnpm eval:advice` runs the advisor's eval cases against a **live** model key. It is not part of CI, it bypasses
the app's own per-user and daily counters, and it spends about 40 model requests of the key's shared free daily
allowance — run it deliberately, not on a demo day.

The local prices and footprint are fixtures (`pnpm seed:prices`, `pnpm seed:footprint`), so a local total is a
plausible shape, not a real bill. The deployed app fetches the real lists.

## Deploy it yourself

The same image runs on all four clouds; app 31 runs on **Google Cloud Run** with Postgres on a private VM. This
repo publishes a container image on every push to `main` (`.github/workflows/publish.yml`); deployment is Terraform
in [BreakthruDevelopment/30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra), which also holds the
secrets and the Cloud Scheduler job that calls `POST /api/prices/refresh`. See `infra/README.md` for what runs where.

## 2-minute demo script

Signed out for the first three steps; everything shown is on screen.

1. **The landing page (`/`).** Read the four tiles — apps in the footprint, list price estimate, free-tier credit,
   net — and the per-cloud cards under them. Where some placements have no complete price, the line below the tiles
   says how many of the app-on-cloud figures the totals cover and that a missing price is never counted as $0.00;
   where none does, the panel says that outright instead of showing zeros. **Proves** the headline claim: the app
   counts what it can price and says what it cannot.
2. **`/prices`, filtered.** Pick a cloud and a component in the filter bar. Open the source link on one row and
   point at the fetch date beside it. **Proves** every number traces to a page the vendor publishes, with the day it
   was read. (Mention that big clouds start folded and that filtering — not Ctrl+F — is how you find a row.)
3. **`/footprint`, then one app.** On the app page, show the four cloud cards side by side: the component lines with
   their arithmetic, the credits as their own negative lines, "outgrows free tier at", and a line reading **not
   listed** where a price is missing — with the cloud's total shown as *Incomplete* rather than a number. Scroll to
   **"Should this app move?"**: the verdict badge, the reasons, the monthly saving, the one-time cost at $100 an
   hour, and the break-even. **Proves** points 1 and 2 together: missing prices never become zeros, and the verdict
   is arithmetic you can read.
4. **Sign in, then `/scenarios/new`.** Set users to ten times what the app has now, press **Price**, and show the
   four clouds re-priced. Save it. **Proves** the forward-looking question the billing console cannot answer.
5. **`/scenarios`, tick two, Compare.** Show the cloud-by-cloud table, the lowest list cost called out, and a cell
   reading *Incomplete* where a cloud is missing a price. **Proves** that comparison keeps the same rules as
   pricing.
6. **`/advisor`.** Ask "should this app move to Oracle Cloud, and what would it cost?" On the answer card, point at
   each figure's tag — the tool call and the specialist it came from — and at the "Consulted" line listing the
   delegations. If a figure was dropped, read the reason aloud. **Proves** the AI writes words, not numbers.
7. **`/admin`** (admin account, if there is time). The price-refresh log with per-source outcomes, the quarantined
   rows showing **both** the refused price and the one still in use, and the stack-profile drift check. **Proves**
   there is a maintenance story behind the numbers, not just a pretty page.
</content>
</invoke>
