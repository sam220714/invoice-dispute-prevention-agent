# Invoice Dispute Prevention Agent

Entry for the **Razorpay x ISB AI PM Build Challenge**, Track 2 (Recover and Grow with AI).
Submission **Tue 13 Oct 2026, 11:59 PM IST**. Build window ends Mon 12 Oct; the 13th is buffer.

This file is loaded automatically at the start of every session. Read `dataset/README.md`
before touching the data.

---

## What we are building

An AI agent inside **Razorpay Invoices** that learns each buyer's *unwritten* billing rules
from past disputes, and fixes the next invoice **before it is sent**.

The merchant is an Indian staffing agency billing enterprise clients monthly. Today an
invoice goes out, the client objects in some unstructured way — email, marked-up Excel, or
no message at all, just a short payment — and someone senior spends hours untangling it.
Payment slips by weeks. One disputed ₹3,000 line holds a ₹26 lakh invoice hostage.

**Disputes are a symptom.** Every client enforces billing rules nobody wrote down. The
supplier discovers them by getting rejected.

The one-sentence version of the problem: *Pragati pays 500 workers on the 7th whether or not
the client has paid. They finance ₹1 crore of other people's wages on a ₹5.6 lakh margin.
A disputed invoice is not a receivables inconvenience — it is borrowing to make payroll.*

---

## The mechanism

Every claim in a dispute falls into one of two buckets. The taxonomy earns its place
because **each routes to a different fix and autonomy level**:

| | Business rule | Format rule |
|---|---|---|
| Wrong | The amount or eligibility | Document structure |
| Fix | Change / remove / defer a line | Restructure, regroup, re-render |
| **Autonomy** | **Propose → merchant approves** | **Auto-apply** |
| Why | Touches revenue | Deterministic once learned |

**v1 has no evidence bucket.** Requests for documents (challans, signed sheets) are out of
scope: the tool does not suggest attachments, block a send or raise a task. If a message
asks for something the invoice data cannot support, the agent puts it in `unclear` as
"needs a human" and carries on.

**Manual override.** The merchant can know things the ledger does not. A business or
manual-review finding can be overridden for one invoice, with an optional reason: the invoice
goes out with its format fixes and the finding is waived on the record
(`src/lib/engine/overrides.ts`, `state/overrides.json`). A format *finding* cannot be waived as fine, but each auto-applied format fix has a switch: on by
default, and the merchant can turn one off for a single invoice (`format_off` in the invoice record;
on the dispute screen it is saved with the dispute). Switching a fix off leaves the rule untouched and
still lets the invoice go. An
override never edits or disables the rule; the same rule overridden on 2 different invoices is
marked "may be out of date" for the merchant to review. Declining a business proposal in a
dispute works the same way (format fixes stay, nothing is learned from the declined claim).

One agent, two handlers — **not two tools**. The merchant does not know which bucket
their dispute is; a real email mixes them. Classifying is the agent's first act of
intelligence.

```
paste (text / annexure / screenshot)   ·OR·   short payment detected
        ↓
   one LLM call — extract claims, map to line items,
   tag bucket, propose fix, infer rule
        ↓
 ┌──────┴────────┐
business        format
propose         auto-apply
        ↓
  rule ledger (per buyer, tagged by type, merchant can toggle)
        ↓
  next invoice runs the PRE-SEND CHECK against the ledger
```

---

## Non-negotiables

**1. The LLM never emits a number.**
It emits `adjust_line("L7", "days", 24)`. A deterministic arithmetic engine produces the
amount — service charge on the right base, PF 13%, ESI 3.25%, CGST 9% + SGST 9%, rounding,
grand total. If the model computes totals in tokens we will eventually ship a hallucinated
invoice. *No invoice total in this system is ever produced by a language model.*

**2. Nothing in `dataset/qa/` ever enters a prompt.**
That is the answer key. If it leaks, the demo proves nothing — the agent would be reciting,
not inferring. `dataset/qa/verify.py` enforces this and exits non-zero on a leak.

**3. The loop must close.**
Dispute resolved → rule written → *next* invoice flagged by that rule. Without this we have
demonstrated dispute **resolution**, which Razorpay already ships, instead of **prevention**,
which is the entire thesis.

**4. Infer with AI, enforce with code.**
The LLM infers a format spec from messy rejection emails (hard, AI-shaped).
`validate_against_spec()` enforces it as a plain linter (boring, deterministic). Knowing
where AI does *not* belong is part of the argument, not a weakness.

---

## Tool surface

The agent calls functions; it does not re-derive logic in tokens.

```
# read
get_invoice(invoice_id) · get_buyer_rules(buyer_id) · get_dispute_history(buyer_id)
get_rate_card(buyer_id, as_of) · get_attendance(buyer_id, period)

# business bucket
adjust_line(line_id, field, value, reason) · remove_line(line_id, reason)
defer_line(line_id, to_period, reason) · split_invoice(invoice_id, disputed_line_ids)
recompute_invoice(invoice_id)          # <- the only thing that produces money figures

# format bucket
validate_against_spec(invoice_id, buyer_id) · set_field(invoice_id, field, value)
regroup_lines(invoice_id, group_by) · apply_template(invoice_id, buyer_id)

# learning
upsert_rule(buyer_id, type, rule_text, source_dispute_id, confidence)
record_outcome(dispute_id, resolution, merchant_accepted)

# output
generate_invoice_pdf(invoice_id)
draft_reply(dispute_id)   # prose from the LLM, numbers injected from recompute_invoice
```

Every tool call is a log line, so the audit trail for "why did this change?" is free.

### Context assembly — deterministic, no retrieval

`build_context(buyer_id, invoice_id, dispute_text)` assembles: buyer profile · active rules
for that buyer (filtered, disabled dropped, confidence-ordered) · invoice lines · **last 5
resolved disputes for that buyer** · the new dispute text · tool definitions.

No embeddings. ~20–50 rules per buyer is under 2k tokens against a 1M window — it is a
database filter, not a retrieval system. The last-5-disputes slice is doing real work: those
are few-shot examples that make proposals match the merchant's house style.

Make the assembled context **inspectable** — snapshot it for debugging, and surface it as a
*"what the agent looked at"* panel. Near-free trust feature.

---

## Screens, in build priority

1. **Pre-send check** ← the money shot. One invoice, flags in two sections:
   *2 business lines to review · 3 format fixes applied automatically.*
   The whole product in one frame. Build this properly even if the rest are rough.
2. **Dispute analysis** — claims extracted, bucketed, mapped to lines, each with
   approve / edit / reject, plus the context panel
3. **Rule ledger** — per buyer: rule text, type, provenance ("learned from dispute 12 Aug"),
   confidence, on/off toggle
4. **Invoice page** — line items, paste box
5. *(static)* Disputes queue — implies scale, no logic needed

---

## Scope — deliberately excluded

State these as decisions, not omissions. "What you chose not to build" is a scoring dimension.

- Email / WhatsApp integration — value is in the reasoning, not the plumbing. Roadmap v1.5 is
  a forwarding address (`disputes@<firm>.razorpay.in`), not inbox OAuth.
- Audio input
- Auth, real database, multi-user, approval routing by value
- Any invoice not raised on Razorpay — the agent needs history to have a ledger at all
- Cross-merchant buyer registry (the moonshot — needs a real retrieval layer)

---

## Real vs mocked

**Real:** live LLM call doing classification / line mapping / rule inference · the
deterministic tool functions · rule ledger persisting between runs (JSON file is fine —
learning must be observable).

**Mocked, and said openly in the README:** no auth, no DB, no real Razorpay API (but shape
the invoice object like Razorpay's actual Invoices schema), no email sending, synthetic data.

API key in an env var, never committed.

---

## Data

Everything lives in `dataset/` — see `dataset/README.md` for the full guide.

- Merchant: **Pragati Facility & Manpower Services**, Hyderabad. 500 deployed, 20 clients,
  ₹1.1 cr billed monthly, ₹5.6 L gross margin. Users: Sunita Reddy (billing executive) and
  Ravi Shetty (founder).
- Buyers: **Meridian** (rigid portal, silent rejections, format-heavy) · **Yogita**
  (line-by-line reconciliation, business-heavy) · **Teamlease** (never disputes, just
  short-pays).
- 15 historical disputes, business and format.
- `dataset/rule_ledger.json` is a **pool of 15 rules**. A seeded split (`src/lib/data/split.ts`)
  puts 12 into the agent's context and holds the rest out, so there is always something
  genuinely new to learn. The same seed gives the same split. `DEMO_SEED` (469) is the one
  the demo runs on; `LEDGER_SEED=N` or `--seed N` tries another.
- **v1 data is deliberately simple:** no cost centres, employee codes, supervisor roles or
  attachments, and every line is complete. Overtime has one line per site.

Edit data in `dataset/generate.py`, never the JSON directly — regeneration discards manual
edits. Run `python3 -I dataset/qa/verify.py` after any change; it must pass.

---

## The demo (90 seconds)

1. **INV-2026-0847**, Meridian, September, ₹24.89 L — already sent.
2. Paste Prashant's 6 Oct email (`dataset/demo_dispute.txt`). One message, both buckets.
3. Agent extracts 5 claims, maps them to lines, buckets them, proposes fixes.
   **Four of five match rules already in the ledger** — the agent says so. That is the
   indictment: entirely foreseeable, and nothing checked.
4. Merchant approves. ₹33,310 off wages, ₹48,444 off the invoice,
   **₹24.40 L collectable today** instead of the whole ₹24.89 L waiting on a ₹48k argument.
5. Two new rules written to the ledger (site-wise grouping, 1st–5th portal window).
6. **Open October's draft (INV-2026-0863) → pre-send check fires.** Same defects, caught
   before sending. That is the payoff.

Expected output for step 3 is in `dataset/qa/expected_analysis.json`. Use it as a test
oracle — if a live run disagrees, find out which is wrong before a judge does.

---

## QA runner (sub-agent)

`.claude/agents/qa-runner.md` runs the suites and reports what they printed, so long test
output stays out of the main context. It runs and reports; it does not judge, diagnose or
edit. Offline suites (`npm test`, typecheck, `verify.py`, presend) run by default. Live
evals (`npm run eval`, `eval:tools`) spend Gemini quota and run only when named. Use it
for routine "is everything still green?" checks; read failures in the main session.

---

## Build order

**Do not start screens until the engine returns correct JSON in a terminal.** The classic
failure is a beautiful UI over a broken classifier, discovered with no time left.

1. Core engine — context assembly, LLM call, tools, arithmetic
2. Pre-send check screen
2b. Prompt sandbox (`npm run try`) — tune `prompts/analyze.md` against the live model
3. Dispute analysis screen
4. Close the loop (dispute → rule → next invoice flagged)
5. Rule ledger, invoice page
6. README, AI build log, deploy

**If behind, cut in this order:** rule-ledger toggles → short-payment trigger → drop to a
single buyer.
**Never cut:** the pre-send check, or the loop closing.

---

## Project docs

| Doc | What's in it |
|---|---|
| `claude/architecture-dispute-prevention-agent.md` | Full design, rule taxonomy with staffing examples, positioning, open questions |
| `claude/build-plan.md` | Day-by-day buckets, risks, cut order |
| `claude/b2b-invoice-dispute-sizing-research.md` | Market sizing with sources |
| `claude/ai-build-log.md` | Running log for the submission — append each session |
| `dataset/README.md` | Every data file explained |

---

## Still open

- Product name
- Per-merchant problem economics for the product note (dispute %, days added, ₹ cost)
- Failure cases: under-billing floor, unlearning a bad rule, rule conflicts, confidence
  threshold for staying silent
- Does v1 issue credit notes or only propose them? GST implications of splitting mid-dispute
- Whether the submission form wants a GitHub link
