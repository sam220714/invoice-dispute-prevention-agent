# Seed dataset — Invoice Dispute Prevention Agent

Synthetic data for the Razorpay x ISB AI PM Build Challenge prototype.
Nothing here is real. Regenerate everything with `python3 generate.py`.

**Project context:** `claude/architecture-dispute-prevention-agent.md` (the design),
`claude/build-plan.md` (what gets built when).

---

## The one rule that matters

```
dataset/        RUNTIME  — the app and the agent may read these
dataset/qa/     ANSWER KEY — test harness only. NEVER load into a prompt.
```

If anything in `qa/` reaches the model's context, the demo proves nothing: the agent
would be reciting answers rather than inferring them. `qa/verify.py` checks for this
and fails the build if a withheld rule leaks into a runtime file.

---

## Runtime files

### `agency.json`
The merchant. Pragati Facility & Manpower Services, Hyderabad — 500 workers deployed
across 20 clients, ~₹1.1 cr billed monthly. Two-person accounts function: Sunita Reddy
(billing executive, the primary user) and Ravi Shetty (founder, approves anything
contentious).

The field worth reading is `note_revenue`. Pragati keeps only the service charge,
about ₹5.6 lakh a month; the other ₹1 crore is pass-through wages, PF/ESI and GST.
Payroll runs on the 7th whether or not clients have paid. **That is the problem this
product exists for** — a delayed invoice is not a receivables inconvenience, it is
borrowing to make payroll.

### `buyers.json`
Three client companies, each a distinct dispute archetype:

| Buyer | Archetype | Dominant bucket |
|---|---|---|
| **Meridian Logistics** | Rigid SAP Ariba portal, *silent* rejections — the invoice vanishes and nobody tells you for two weeks | format |
| **Yogita Precision** | Lakshmi reconciles line-by-line against the plant biometric register and is almost always right | business |
| **Teamlease Retail** | Never disputes. Just pays less. Found at bank reconciliation, weeks later, usually written off | business / silent |

Each record carries identity (GSTIN, sites), commercial terms
(service-charge rate and **base** — wages-only vs wages+statutory, which is itself a
recurring dispute), and a `behaviour` paragraph describing how they actually act.

**No rules here.** The buyers' unwritten rules live in `qa/ground_truth_rules.json`.

### `rate_cards.json`
Contracted per-man-day and per-hour rates by buyer, with version and effective date.
Rate-card *version* disputes are a real category, so the versioning is load-bearing.

### `invoices.json`
Five invoices. Lines are **role × site summaries**, not one line per person — that is
how staffing invoices are actually cut, and it keeps the demo to ~10 lines instead of 83.

| Invoice | Buyer | Status | Role in the demo |
|---|---|---|---|
| INV-2026-0831 | Meridian | `paid_late` | Background: silently rejected, paid 26 days late |
| **INV-2026-0847** | Meridian | `disputed` | **The demo invoice.** ₹26.33L, September |
| **INV-2026-0863** | Meridian | `draft` | **Pre-send check target.** October |
| INV-2026-0849 | Yogita | `disputed` | Open dispute, shows a second archetype |
| INV-2026-0852 | Teamlease | `short_paid` | Silent short payment, no message at all |

Every line is complete: one role at one site, with `po_number` and `sac` as nullable line
fields (the Meridian invoices leave both empty, which is the defect). Overtime has one line
per site. There are no supervisor roles, cost centres, employee codes or attachments in
v1; all of them were cut on purpose.

Meridian's lines are cut **role by role**, the way Pragati's template does it, so the
site-wise-grouping rule has something to fix.

`INV-2026-0863` is **deliberately seeded with the same defects** September's dispute
teaches: no PO number or SAC on the lines, lines grouped role-wise, 171 unreferenced OT
hours, and two more exited workers billed the full month. Running the pre-send check
against it is the payoff of the whole demo.

`totals` carries the full computation chain: wages → PF (13%) → ESI (3.25%) →
service charge (on the buyer's own base) → taxable → CGST 9% + SGST 9% → grand total.

### `annexure_INV-2026-0847.json`, `annexure_INV-2026-0863.json`
Person-level detail behind the two Meridian invoices — only the workers the dispute
touches. Each row has the worker's name, role, site, days billed, last working day where
someone exited, and OT hours with the authorisation reference if one exists.

`ot_summary` is the authoritative overtime ledger, **per site** (`by_site`: billed hours
against authorised hours). It is how the engine checks a model's overtime quantity.

This is where line-level claims get resolved. "Two loaders billed full month" is only
checkable because `last_working_day` is here.

### `disputes.json`
18 historical disputes, roughly June–October 2026 — a 22% dispute rate across 20
invoices a month. Each record has:

- `raw_text` — the message **exactly as it arrived**. Indian business-English register,
  not cleaned up. Teamlease's entries have no message at all, just a parenthetical noting
  the bank credit was short, because that is the honest representation of a silent deduction.
- `buckets` — business / format (a dispute can hit both)
- `detected_how` — often "chased after 14 days of silence", which is the point
- `resolution` — what Pragati actually did, including the ones they simply absorbed
- `days_delayed`, `amount_disputed`

**No `rule_learned` field.** Inferring the rule is the agent's job; the expected
inference sits in `qa/expected_rules_per_dispute.json`.

Two uses at runtime: the last ~5 disputes per buyer go into the prompt as few-shot
history, and every rule in the ledger points back to the dispute that taught it.

### `rule_ledger.json`
The pool of every rule the three buyers enforce: 15 rules, business and format only. Each
entry has `rule_id`, `type`, `rule`, `confidence` (high when two or more disputes
corroborate it), `learned_from`, `status`, `times_corroborated`.

**The app never feeds the pool to the model.** It splits it with a random seed
(`src/lib/data/split.ts`): 12 rules go into the context as the live ledger, and the rest
are held out as things the agent has yet to learn. The same seed always gives the same
split. `DEMO_SEED` (469) holds out MER-R5 (site-wise grouping), MER-R6 (the 1st–5th portal
window) and YOG-R6, so the demo dispute teaches two new Meridian rules. Any other seed
(`LEDGER_SEED=7`, `--seed 7`) gives a different, equally repeatable test.

The live copy is `state/rule_ledger.json`, which the app mutates. The pool itself is
never written.

### `demo_dispute.txt`
Prashant Dubey's email of 6 Oct against INV-2026-0847. This is what gets pasted in the
demo. One message, **both buckets**:

1. Unauthorised overtime at Shamshabad and Patancheru → business
2. Two exited loaders billed full month → business
3. PO number only in the reference field, not against the lines → format
4. SAC only in the header → format
5. Lines grouped role-wise, not site-wise → format, and a *new* rule
6. (closing note) portal accepts invoices only 1st–5th → format, and a *new* rule

On the demo seed, four of the five claims match rules **already in the ledger**. The agent
should say so — that is the entire prevention argument: this dispute was foreseeable
before the invoice went out, and it happened because nothing checked.

---

## QA files---

## QA files — never put these in a prompt

### `qa/ground_truth_rules.json`
All 15 unwritten rules the three buyers actually enforce. Per rule: `rule_id`,
`type`, the rule text, `recoverable_from` (which disputes contain the evidence), and
`expected_confidence`.

This is the answer key for measuring rule-inference precision and recall — which means
the accuracy claim in the product note can be a number rather than an assertion.

### `qa/expected_rules_per_dispute.json`
For each of the 15 disputes: which rules a correct agent should infer from it
(`maps_to_rule_ids`). One dispute maps to nothing — it is open. That is deliberate; an
agent that invents a new rule for every dispute is over-fitting.

### `qa/expected_analysis.json`
The expected output for the demo dispute, on the demo seed. Five claims, each with bucket,
affected lines, the **exact tool call** that fixes it, rupee impact, autonomy level, and
the rule it matches. Plus recomputed totals:

```
wage reduction          ₹   33,310
invoice reduction       ₹   48,444.40
revised total           ₹ 24,40,108.44   (from ₹24,88,552.84)
collectable immediately ₹ 24,40,108.44
```

Use it as a test oracle. If a live run disagrees with this file, one of them is wrong —
find out which before a judge does.

### `qa/verify.py`
Run it: `python3 -I dataset/qa/verify.py`. Six checks:

1. **Arithmetic** — recomputes every invoice from line items; checks the service-charge
   base matches each buyer's contract
2. **Leak detection** — the rule pool is the only runtime file that may hold rule text,
   and it must equal the ground truth; `ground_truth_rules` / `rule_learned` must be gone
   from the runtime tier
3. **Recoverability** — every rule must have evidence in dispute history, otherwise the
   demo asks the agent to infer something unknowable
4. **V1 scope** — only `business` and `format` buckets; no cost centres, employee codes,
   supervisor roles or attachments anywhere
5. **Demo maths** — OT and exit impacts, revised total against `expected_analysis.json`
6. **History shape** — dispute rate in the intended band

Exits non-zero on failure. Run it after any change to `generate.py`.

---

## Conventions

- All parties in Telangana (state code 36) — GST is CGST 9% + SGST 9%, never IGST
- SAC `998519` for manpower supply
- PF employer 13% (12% + 1% admin/EDLI), ESI employer 3.25%, both on wages
- Service-charge **base differs by buyer** and is a live dispute category
- Currency is INR throughout; `_inr` suffix on money fields
- Rule IDs: `MER-Rn`, `YOG-Rn`, `TEA-Rn`
- Dispute IDs: `DSP-001`..`DSP-018`, with gaps (DSP-003, 005 and 016 were cut with the evidence bucket and employee codes)

## Regenerating

```bash
cd dataset
python3 generate.py        # rewrites runtime/ and qa/
python3 -I qa/verify.py    # must pass
```

`generate.py` holds all data as Python literals — edit there, never the JSON directly,
or the next regeneration silently discards your change.
