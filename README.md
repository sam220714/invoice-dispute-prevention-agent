# Invoice Dispute Prevention Agent

An AI agent inside Razorpay Invoices that learns each buyer's *unwritten* billing rules from past
disputes, and fixes the next invoice **before it is sent**.

Entry for the **Razorpay x ISB AI PM Build Challenge**, Track 2 (Recover and Grow with AI).
The product name is still open; this is the working title.

> **Prototype, synthetic data.** There is no auth, no database, no real Razorpay API and no email
> sending. See [What is real and what is mocked](#what-is-real-and-what-is-mocked).

---

## The problem

Pragati Facility & Manpower Services (Hyderabad, 500 workers deployed, 20 clients, about ₹1.1 crore
billed a month) pays its workers on the 7th whether or not the client has paid. It finances
roughly ₹1 crore of other people's wages on a ₹5.6 lakh margin. A disputed invoice is not a
receivables inconvenience. It is borrowing to make payroll.

Every client enforces billing rules nobody wrote down: a PO number on every line, lines grouped by
site, a portal that only accepts invoices from the 1st to the 5th. The supplier finds them out by
being rejected, usually after two weeks of silence, and then someone senior spends hours untangling
it. One disputed ₹3,000 line can hold a ₹26 lakh invoice hostage.

Disputes are the symptom. The unwritten rules are the cause. This agent writes the rules down, one
dispute at a time, and then checks the next invoice against them.

## How it works

Every claim in a dispute falls into one of two buckets, and each bucket gets a different fix and a
different level of autonomy:

| | Business rule | Format rule |
|---|---|---|
| What is wrong | The amount or eligibility | The document's structure |
| Fix | Change, remove or defer a line | Fill a field, regroup, re-render |
| Autonomy | **Proposed, the merchant approves** | **Applied automatically** (the merchant can switch a fix off for one invoice) |
| Why | It touches revenue | It is deterministic once learned |

It is one agent with two handlers, not two tools. A real email mixes both buckets, and the merchant
should not have to know which is which.

```
  paste a message
        |
        v
  one LLM call: extract claims, map them to invoice lines,
  tag the bucket, propose a fix, infer the rule
        |
   +----+-----------------+
   |                      |
 business               format
 propose                auto-apply
   |                      |
   +----------+-----------+
              v
   rule ledger (per buyer, merchant can switch rules on and off)
              |
              v
   the next invoice runs the PRE-SEND CHECK against the ledger
```

**The loop is the point.** A dispute is resolved, a rule is written, and the *next* invoice is
flagged by that rule. Resolving disputes is something Razorpay already does. Preventing them is the
product.

## The demo (about 90 seconds)

1. Open **INV-2026-0847** (Meridian, September, ₹24.89 L), which has already been sent.
2. Paste Meridian's email (`dataset/demo_dispute.txt`). It contains five objections: both buckets in
   one message.
3. The agent extracts the five claims, maps them to lines and buckets them. Four of the five are
   already covered by rules in the ledger, and it says so.
4. Approve. ₹33,310 comes off wages and ₹48,444 off the invoice, so **₹24.40 L is collectable now**
   instead of the whole ₹24.89 L waiting on a ₹48k argument.
5. Two new rules are written to the ledger: site-wise grouping, and the 1st to 5th portal window.
6. Open **October's draft (INV-2026-0863)**. The pre-send check fires on the same defects, before
   anything is sent. The PO and SAC are filled in and the lines are regrouped by site, and the two
   business problems wait for a decision.

## The screens

| Screen | What it is |
|---|---|
| **Pre-send check** | One draft invoice. Business findings that need a decision, and the format fixes the agent already made. |
| **Dispute analysis** | The pasted message with its claims extracted, bucketed and mapped to lines. Each business claim can be approved, edited or declined. New rules are listed apart from what happens to this invoice. |
| **Invoice panel** | Shown on both screens. Format fixes appear as a before/after: PO and SAC per line, site grouping, and the portal-window chip. A switch flips between "as drafted" and "fixed", and picking a fix lights exactly what it changed. |
| **Buyer rules** | The ledger, per buyer: rule text, type, which dispute taught it, confidence, and an on/off switch. |
| **Disputes** | The history of past disputes. |

Format fixes are applied by default, and each one can be turned off for a single invoice. Switching
a fix off never edits or disables the rule. A business or manual-review finding can also be waived
for one invoice with a reason. If the same rule is waived on two different invoices, the ledger
marks it "may be out of date" for the merchant to review.

## Principles the build holds to

1. **The model never emits a number.** It emits `adjust_line("L7", "qty", 24)`, and a deterministic
   arithmetic engine produces every amount: service charge on the right base, PF 13%, ESI 3.25%,
   CGST 9% and SGST 9%, rounding and the grand total. No invoice total in this system is produced
   by a language model. Where the annexure fixes a quantity, the engine's figure replaces the
   model's, and the disagreement is shown rather than hidden.
2. **Nothing in `dataset/qa/` ever enters a prompt.** That folder is the answer key. If it leaked,
   the demo would prove nothing, because the agent would be reciting instead of inferring.
   `dataset/qa/verify.py` and a test both enforce it.
3. **The loop must close.** Dispute, then rule, then the next invoice is flagged.
4. **Infer with AI, enforce with code.** The model infers a rule from a messy email. A plain linter
   (`runChecks`) enforces it. Knowing where AI does *not* belong is part of the design.

## How it is built

```
src/lib/engine/    the deterministic core
  arithmetic.ts      every money figure
  tools.ts           the tool surface: adjust_line, remove_line, defer_line, split_invoice,
                     set_field, regroup_lines, apply_template, recompute_invoice, ...
  checks.ts          the linter that enforces a rule against an invoice
  context.ts         builds what the agent sees (no retrieval, just a database filter)
  analyze.ts         context -> model -> verify every quantity -> execute by bucket -> recompute
  learn.ts           turns approved proposals into ledger rules, corroborates existing ones
  presend.ts         runs the ledger against a draft
  overrides.ts       waiving one finding on one invoice, and the "may be out of date" signal
src/lib/llm/       one provider (Gemini), plus record/replay so a good run can be kept
src/lib/app/       the screens as data (computed on the server)
src/app/           the Next.js UI
prompts/analyze.md the one system prompt, versioned as a file so changes can be diffed
dataset/           synthetic data and the answer key (dataset/qa/)
eval/              harnesses: classifier accuracy, tool calls, oracle checks (not runtime)
state/             runtime JSON: the live ledger, saved analyses, decisions (gitignored)
```

**Context is assembled, not retrieved.** The agent sees the buyer profile, that buyer's active
rules (disabled ones dropped, ordered by confidence), the invoice lines, the last five resolved
disputes for that buyer as few-shot examples, the new message and the tool definitions. About 5k
tokens in all. Every run saves a snapshot of exactly what the agent looked at, and the screens can
show it.

**The model is Gemini.** The default is `gemini-3.6-flash` with fallbacks, and a low thinking level,
chosen by probing the free tier rather than by model number. All of this is overridable with
environment variables (see `.env.example`).

**The ledger.** The 15 rules in `dataset/rule_ledger.json` are a pool. A seeded split puts 12 into the
agent's ledger and holds the rest out, so there is always something genuinely new to learn. The same
seed always gives the same split, and the demo seed (469) holds out the two rules Meridian's email
teaches.

## What is real and what is mocked

**Real**
- A live LLM call that classifies claims, maps them to lines and infers new rules.
- The deterministic tool functions, arithmetic and linter.
- A rule ledger that persists between runs (a JSON file), so learning is observable.

**Mocked, on purpose**
- No auth, no multi-user and no approval routing by value.
- No database. State is plain JSON files in `state/`.
- No real Razorpay API. The invoice object is shaped like Razorpay's Invoices schema.
- No email or WhatsApp. "Send invoice" records the decision and stops there.
- All data is synthetic.

## What we chose not to build

These are decisions, not omissions.

- **Email and WhatsApp integration.** The value is in the reasoning, not the plumbing. The v1.5
  idea is a forwarding address (`disputes@<firm>.razorpay.in`), not inbox OAuth.
- **An evidence bucket.** Requests for documents (challans, signed sheets) are out of scope. If a
  message asks for something the invoice data cannot support, the agent lists it as "needs a
  person" and carries on.
- **Automatic short-payment detection.** The data includes a short-paid invoice (Teamlease), but
  today you paste what you know. Detecting the shortfall from the bank credit is the next step.
- **Audio input and screenshots.**
- **Any invoice not raised on Razorpay.** The agent needs the history to have a ledger at all.
- **A cross-merchant buyer registry.** This is the moonshot, and it needs a real retrieval layer.

## Run it

You need Node 20 or later and a Gemini API key.

```bash
npm install
cp .env.example .env.local        # then put your key in GEMINI_API_KEY
```

Add this line to `.env.local`. Without it the app starts from all 15 rules, and the demo has nothing
new to teach:

```
LEDGER_RULES=12
```

Then start the app:

```bash
npm run dev                       # http://localhost:3000
```

Use **Reset demo data** in the sidebar to start a run from the seeded ledger again.

**Running the demo without the network.** A recorded model reply can stand in for the live call, so
a busy API on the day cannot sink the demo. Record one once (this makes a live call):

```bash
npm run analyze -- --reset --record demo-0847
```

Then run the app against it. The received date is part of the prompt, so pin it, otherwise the
recording only matches on the day it was made:

```bash
# bash
ANALYZE_REPLAY=demo-0847 ANALYZE_RECEIVED_ON=2026-10-06 npm run dev
# PowerShell
$env:ANALYZE_REPLAY="demo-0847"; $env:ANALYZE_RECEIVED_ON="2026-10-06"; npm run dev
```

A recording only replays against the exact prompt that produced it, and the app refuses a stale one
rather than answering an old question with an old answer. It also only matches a fresh ledger,
because the last five resolved disputes are part of the prompt. Recordings live in `fixtures/`,
which is not committed, so record your own.

**Command line.** The engine works without the UI:

```bash
npm run analyze -- --approve all --save --next INV-2026-0863   # the whole loop, in a terminal
npm run presend -- INV-2026-0863                               # the pre-send check
npm run try                                                    # prompt sandbox: one live call, printed
```

## Deploying to Vercel

Import the GitHub repo in Vercel (framework preset: Next.js, no build settings to change), then set these
environment variables in Project Settings:

| Variable | Value | Why |
|---|---|---|
| `GEMINI_API_KEY` | your key | the live classification call |
| `LEDGER_RULES` | `12` | start from 12 of 15 rules, so the demo has something new to learn |
| `ANALYZE_RECEIVED_ON` | `2026-10-06` | the day the demo email counts as received |

What changes on Vercel, and why:

- **State is ephemeral.** A deployment is read-only, so on Vercel the ledger and the screens' records are
  written to the instance's temp directory instead of `state/` (`defaultStateDir()` in `src/lib/data/load.ts`).
  It survives across requests on a warm instance, which covers a demo run. A cold start, or a request landing
  on a different instance, reseeds the ledger from the dataset: a clean demo, not a crash. Use **Reset demo
  data** between runs. A durable store (Redis, Blob) is the production answer and is outside v1's scope.
- **One shared state.** There is no auth or per-visitor session, so everyone who opens the URL sees the same
  ledger.
- **The answer key never ships.** `next.config.mjs` lists what the deployment bundles: `dataset/*.json`,
  `dataset/*.txt` and `prompts/*.md`, and excludes `dataset/qa/`.
- **Analysis can take a while.** The analysis is a live model call, so the app asks for the 60-second ceiling
  (`maxDuration` in `src/app/layout.tsx`) rather than the platform default.

## Tests

```bash
npm test                          # 429 tests, offline
npm run typecheck
python3 -I dataset/qa/verify.py   # the data and the answer-key leak check; must pass
```

Two harnesses spend Gemini quota and run only when asked:

```bash
npm run eval                      # classifier accuracy: 18 live calls (existing rules, held-out rules)
npm run eval:tools                # does it call the right tool on the right line, and does the money come out right
```

`dataset/qa/expected_analysis.json` is the test oracle for the demo: five claims, the exact tool call
for each, the rupee impact and the totals. If a live run disagrees with it, work out which one is
wrong.

## Data

Everything lives in `dataset/`. Read [`dataset/README.md`](dataset/README.md) before touching it. Edit
the data in `dataset/generate.py`, never the JSON, because regenerating discards manual edits:

```bash
python3 dataset/generate.py
python3 -I dataset/qa/verify.py
```

## Known limits and open questions

- Three buyers and fifteen rules. The approach is the claim, not the coverage.
- A rule the model infers can be wrong. Every new rule is a checkbox the merchant can leave off, and
  a learned rule can be switched off in the ledger, but there is no automatic unlearning yet.
- Rule conflicts, an under-billing floor, and a confidence threshold for staying silent are not
  handled.
- Whether v1 should issue credit notes or only propose them, and the GST implications of splitting
  an invoice mid-dispute, are open.
- Gemini's free tier can be slow or busy. The record and replay path exists for that reason.
