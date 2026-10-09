"""
QA checks for the seed dataset. Run from anywhere:  python3 -I dataset/qa/verify.py

What it proves:
  1. Invoice arithmetic ties, and scale is internally plausible.
  2. The runtime tier does NOT leak the answer key. The pool of rules lives in
     rule_ledger.json (the app splits it by seed: 12 into context, the rest held
     out). Nowhere else at runtime may a rule's text appear, and the dispute
     history must not carry the rule to infer.
  3. Every rule is still recoverable from dispute history, otherwise the demo
     asks the agent to infer something it has no evidence for.
  4. v1 scope holds: two buckets only (business, format), and no cost centres,
     employee codes, supervisor roles or attachments anywhere in the data.
  5. The demo dispute's expected answer ties to the invoice.
"""
import json, re
from pathlib import Path

QA = Path(__file__).parent
RT = QA.parent
load = lambda p: json.load(open(p, encoding="utf-8"))

agency = load(RT / "agency.json")
buyers = load(RT / "buyers.json")
invoices = load(RT / "invoices.json")
disputes = load(RT / "disputes.json")
pool = load(RT / "rule_ledger.json")
annex = load(RT / "annexure_INV-2026-0847.json")
truth = load(QA / "ground_truth_rules.json")
expected = load(QA / "expected_analysis.json")
per_dispute = load(QA / "expected_rules_per_dispute.json")

PF, ESI, CG, SG = 0.13, 0.0325, 0.09, 0.09
by_id = {b["id"]: b for b in buyers}
fails = []
chk = lambda c, m: None if c else fails.append(m)

# ------------------------------------------------------------------ 1. maths
print("=" * 78)
print("1. INVOICE ARITHMETIC")
print("=" * 78)
for inv in invoices:
    t, b = inv["totals"], by_id[inv["buyer_id"]]
    for ln in inv["lines"]:
        chk(abs(ln["amount"] - ln["qty"] * ln["rate"]) < 0.01,
            f"{inv['invoice_id']} {ln['line_id']}: amount != qty*rate")
    w = round(sum(l["amount"] for l in inv["lines"]), 2)
    pf, esi = round(w * PF, 2), round(w * ESI, 2)
    basis = w if t["service_charge_base"] == "wages_only" else w + pf + esi
    sc = round(basis * b["service_charge_pct"], 2)
    tax = round(w + pf + esi + sc, 2)
    tot = round(tax + round(tax * CG, 2) + round(tax * SG, 2), 2)
    for lbl, mine, theirs in [("wages", w, t["wages"]), ("pf", pf, t["pf_employer"]),
                              ("esi", esi, t["esi_employer"]), ("sc", sc, t["service_charge"]),
                              ("taxable", tax, t["taxable_value"]), ("total", tot, t["grand_total"])]:
        chk(abs(mine - theirs) < 0.02, f"{inv['invoice_id']} {lbl}: {mine} vs {theirs}")
    chk(t["service_charge_base"] == b["service_charge_base"],
        f"{inv['invoice_id']}: SC base disagrees with buyer profile")
    print(f"  {inv['invoice_id']}  {b['short_name']:9s} {inv['period_label']:22s} "
          f"Rs {tot:>13,.2f}  [{inv['status']}]")

sept = [i for i in invoices if i["invoice_id"] in
        ("INV-2026-0847", "INV-2026-0849", "INV-2026-0852")]
top3 = sum(i["totals"]["grand_total"] for i in sept)
top3_heads = sum(by_id[i["buyer_id"]]["headcount"] for i in sept)
tail_heads = agency["headcount_deployed"] - top3_heads
tail_value = agency["monthly_billing_inr"] - top3
per_head = tail_value / tail_heads
svc = sum(i["totals"]["service_charge"] for i in sept)
print(f"\n  top-3 concentration {top3/agency['monthly_billing_inr']:.0%}   "
      f"tail billing Rs {per_head:,.0f}/head/month")
print(f"  service charge on top 3: Rs {svc:,.0f}  ({svc/top3:.1%} of billed value)")
chk(5000 < per_head < 30000, f"implausible tail billing per head: {per_head:,.0f}")
chk(top3 / agency["monthly_billing_inr"] < 0.65, "top-3 concentration too high")

# ------------------------------------------------------------------ 2. leak
print()
print("=" * 78)
print("2. ANSWER-KEY LEAK CHECK")
print("=" * 78)

runtime_files = ["agency.json", "buyers.json", "rate_cards.json", "invoices.json",
                 "annexure_INV-2026-0847.json", "annexure_INV-2026-0863.json", "disputes.json",
                 "rule_ledger.json", "demo_dispute.txt"]
blobs = {f: (RT / f).read_text(encoding="utf-8") for f in runtime_files}

norm = lambda s: re.sub(r"[^a-z0-9 ]", " ", s.lower())
norm = lambda s, _n=norm: re.sub(r"\s+", " ", _n(s)).strip()

chk("ground_truth_rules" not in blobs["buyers.json"],
    "buyers.json still carries ground_truth_rules")
chk("rule_learned" not in blobs["disputes.json"],
    "disputes.json still carries rule_learned")

# The pool is the one runtime file allowed to hold rule text, and it must be the
# ground truth exactly: same ids, same text.
truth_by_id = {r["rule_id"]: r for r in truth}
chk({r["rule_id"] for r in pool} == set(truth_by_id), "rule_ledger.json and ground truth list different rules")
for r in pool:
    g = truth_by_id.get(r["rule_id"])
    chk(g is not None and g["rule"] == r["rule"], f"{r['rule_id']}: pool text differs from ground truth")
    chk("learned_on" not in r, f"{r['rule_id']} still carries learned_on")

for r in truth:
    needle = norm(r["rule"])[:60]
    for fname, blob in blobs.items():
        if fname == "rule_ledger.json":
            continue
        if needle and needle in norm(blob):
            fails.append(f"LEAK: rule {r['rule_id']} appears in {fname}")

print(f"  runtime files scanned: {len(blobs)}")
print(f"  rules in the pool: {len(pool)}  (12 go into context per seed, the rest are held out)")
chk(len(pool) > 12, "the pool must be larger than the 12 that go into context")
for b in buyers:
    n = sum(1 for r in pool if r["buyer_id"] == b["id"])
    print(f"    {b['short_name']:9s} {n} rules")

# ------------------------------------------------------------------ 3. learnable
print()
print("=" * 78)
print("3. ARE THE RULES ACTUALLY RECOVERABLE?")
print("=" * 78)
dsp_ids = {d["dispute_id"] for d in disputes}
for r in truth:
    srcs = r["recoverable_from"]
    chk(bool(srcs), f"{r['rule_id']} has no source dispute — agent cannot infer it")
    for s in srcs:
        chk(s in dsp_ids, f"{r['rule_id']} cites {s}, which is not in disputes.json")
print(f"  all {len(truth)} rules cite a dispute that exists")

# ------------------------------------------------------------------ 4. scope
print()
print("=" * 78)
print("4. V1 SCOPE: TWO BUCKETS, NO CODES, NO SUPERVISORS, NO ATTACHMENTS")
print("=" * 78)
buckets_seen = {b for d in disputes for b in d["buckets"]} | {r["type"] for r in pool}
print(f"  buckets in use: {sorted(buckets_seen)}")
chk(buckets_seen == {"business", "format"}, f"unexpected buckets: {buckets_seen}")
for term in ("cost_centre", "emp_code", "meridian_hrms_code", "employee_code", "attachments", "evidence"):
    for fname, blob in blobs.items():
        chk(term not in blob, f"{fname} still mentions {term}")
for fname in ("invoices.json", "rate_cards.json"):
    chk("supervisor" not in blobs[fname].lower(), f"{fname} still has a supervisor role")
for inv in invoices:
    for ln in inv["lines"]:
        chk(ln["site_code"] is not None, f"{inv['invoice_id']} {ln['line_id']} has no site")
print("  clean")

# ------------------------------------------------------------------ 5. demo
print()
print("=" * 78)
print("5. DEMO DISPUTE — VALUE IMPACT")
print("=" * 78)
demo = blobs["demo_dispute.txt"]
held = expected["demo_held_out_rules"]
chk("1st to 5th" in demo, "demo dispute no longer restates the portal window")
chk("site wise" in demo.lower(), "demo dispute no longer asks for site-wise grouping")
for rid in held:
    chk(rid in truth_by_id, f"demo holds out {rid}, which is not a rule")
print(f"  demo holds out {', '.join(held)}")

mer = next(i for i in invoices if i["invoice_id"] == "INV-2026-0847")
lines = {l["line_id"]: l for l in mer["lines"]}
ot_sh, ot_md, ot_py, ld_sh = lines["L9"], lines["L10"], lines["L11"], lines["L6"]
chk(ot_sh["unit"] == "hours" and ot_py["unit"] == "hours" and ot_md["site_code"] == "MD",
    "L9/L10/L11 are no longer the per-site OT lines")
by_site = annex["ot_summary"]["by_site"]
ot_drop = (ot_sh["qty"] - by_site["SH"]["authorised_hours"]) * ot_sh["rate"] \
    + (ot_md["qty"] - by_site["MD"]["authorised_hours"]) * ot_md["rate"] \
    + (ot_py["qty"] - by_site["PY"]["authorised_hours"]) * ot_py["rate"]
excess = sum(r["days_billed"] - int(r["last_working_day"].split("-")[2])
             for r in annex["rows"] if r["last_working_day"])
exit_drop = excess * ld_sh["rate"]
new_w = round(mer["totals"]["wages"] - ot_drop - exit_drop, 2)
ntax = round(new_w * (1 + PF + ESI + 0.07), 2)
ntot = round(ntax * 1.18, 2)

print(f"  OT        remove {ot_sh['qty']+ot_py['qty']} hrs        Rs {ot_drop:>10,.0f}")
print(f"  Exits     remove {excess} man-days     Rs {exit_drop:>10,.0f}")
print(f"  Revised invoice   Rs {ntot:>13,.2f}  (was Rs {mer['totals']['grand_total']:,.2f})")
chk(abs(ntot - expected["revised_invoice_total_inr"]) < 1,
    f"expected_analysis revised total {expected['revised_invoice_total_inr']} != {ntot}")
chk(abs(ot_drop - 19710) < 1, "OT impact drifted")
chk(abs(exit_drop - 13600) < 1, "exit impact drifted")
chk(abs(expected["wage_reduction_inr"] - (ot_drop + exit_drop)) < 1, "wage reduction drifted")

claims = expected["claims"]
for c in claims:
    chk(c["bucket"] in ("business", "format"), f"bad bucket: {c['bucket']}")
    chk(c["autonomy"] in ("propose_merchant_approves", "auto_apply"), f"bad autonomy: {c['autonomy']}")
bk = {}
for c in claims:
    bk[c["bucket"]] = bk.get(c["bucket"], 0) + 1
print(f"  claims: {len(claims)}  buckets {bk}")
chk(len(bk) == 2, "demo dispute does not cover both buckets")

# ------------------------------------------------------------------ 6. history
print()
print("=" * 78)
print("6. DISPUTE HISTORY")
print("=" * 78)
rate = len(disputes) / (agency["active_clients"] * 4)
print(f"  {len(disputes)} disputes over ~4 months x {agency['active_clients']} invoices "
      f"= {rate:.0%} dispute rate")
chk(0.15 < rate < 0.45, f"dispute rate {rate:.0%} outside intended band")
mapped = sum(1 for p in per_dispute if p["maps_to_rule_id"])
print(f"  {mapped}/{len(per_dispute)} disputes map to a ground-truth rule "
      f"({len(per_dispute)-mapped} open or without a rule)")

print()
print("=" * 78)
if fails:
    print(f"FAILED — {len(fails)} issue(s)")
    for f in fails:
        print("  !", f)
    raise SystemExit(1)
print("ALL CHECKS PASSED")
print("=" * 78)
