"""
Seed data generator — Invoice Dispute Prevention Agent
Razorpay x ISB AI PM Build Challenge

Emits JSON files consumed by the prototype. All data is synthetic.

Design notes:
  - Invoice lines are role x site summaries (realistic for staffing).
    Person-level detail lives in the annexure. Disputes reference the annexure.
  - buyers.json carries GROUND TRUTH rules — what the buyer actually enforces
    but has never written down. The agent's ledger starts empty and must
    discover these. Keeping them separate lets us measure precision/recall.
  - All parties are in Telangana, so GST is CGST 9% + SGST 9%.
"""

import copy, json, os
from pathlib import Path

OUT = Path(__file__).parent

# ---------------------------------------------------------------- constants
PF_RATE = 0.13        # 12% PF + 1% admin/EDLI, employer side
ESI_RATE = 0.0325     # employer side
CGST = 0.09
SGST = 0.09
SAC_STAFFING = "998519"

# ---------------------------------------------------------------- agency
agency = {
    "legal_name": "Pragati Facility & Manpower Services Pvt Ltd",
    "short_name": "Pragati Manpower",
    "city": "Hyderabad",
    "state": "Telangana",
    "state_code": "36",
    "gstin": "36AABCP4821F1Z9",
    "pan": "AABCP4821F",
    "pf_code": "TG/HYD/0049283",
    "esi_code": "52000394820001099",
    "cin": "U74999TG2016PTC110482",
    "founded": 2016,
    "headcount_deployed": 500,
    "active_clients": 20,
    "monthly_billing_inr": 11000000,
    "monthly_gross_margin_inr": 560000,
    "note_revenue": (
        "Gross billing is ~Rs 1.1 cr a month including GST. What Pragati actually "
        "keeps is the service charge, roughly Rs 5.6 lakh — about 5% of billed value "
        "and 6-7% of the wage base. Everything else is pass-through: wages, PF, ESI "
        "and GST. This is why a delayed invoice is dangerous out of proportion to the "
        "margin at stake."
    ),
    "client_mix": (
        "Three anchor clients (Meridian, Yogita, Teamlease) are 193 heads and ~52% of "
        "billing. The remaining 17 clients are 307 heads at ~Rs 17,000 billed per head "
        "per month — smaller, housekeeping-heavy deployments at lower wage grades."
    ),
    "payroll_date": 7,
    "payroll_note": "500 workers are paid on the 7th of every month regardless of whether clients have paid. A disputed invoice is financed from the owner's OD limit.",
    "od_limit_inr": 4000000,
    "od_rate_pa": 0.115,
    "team": [
        {
            "name": "Sunita Reddy",
            "role": "Billing Executive",
            "does": "Prepares and sends all 20 invoices between the 1st and 5th. First responder to client objections. Primary user of the tool.",
        },
        {
            "name": "Ravi Prakash Shetty",
            "role": "Founder / Managing Director",
            "does": "Pulled in when a dispute is contentious or large. Approves credit notes. Signs off anything that reduces an invoice materially.",
        },
    ],
}

# ---------------------------------------------------------------- buyers
# ground_truth_rules = what the buyer enforces but never documented.
buyers = [
    {
        "id": "BUY-MERIDIAN",
        "legal_name": "Meridian Logistics Park Pvt Ltd",
        "short_name": "Meridian",
        "archetype": "Rigid AP portal. Silent rejections.",
        "gstin": "36AADCM7719K1ZT",
        "state_code": "36",
        "ap_contact": "Prashant Dubey, AP Executive",
        "ap_email": "ap.vendors@meridianlogistics.in",
        "ap_system": "SAP Ariba vendor portal",
        "payment_terms_days": 30,
        "sites": [
            {"code": "SH", "name": "Shamshabad Hub"},
            {"code": "MD", "name": "Medchal DC"},
            {"code": "PY", "name": "Patancheru Yard"},
        ],
        "service_charge_pct": 0.07,
        "service_charge_base": "wages_only",
        "billing_cycle": "calendar_month",
        "headcount": 83,
        "behaviour": (
            "Invoices are uploaded to an Ariba portal. If a field is missing the portal "
            "rejects silently — no email, no notification. Pragati finds out 10-14 days "
            "later when they chase payment. Prashant is responsive but only answers "
            "direct questions; he never volunteers what is wrong."
        ),
        "ground_truth_rules": [
            {"type": "format", "rule": "The PO number must be entered against every line item, not only in the invoice reference field.", "discovered": False},
            {"type": "format", "rule": "SAC 998519 must appear on every line, not once in the header.", "discovered": False},
            {"type": "business", "rule": "Overtime is payable only against a Meridian OT authorisation number issued by the site manager. Unreferenced OT is struck off.", "discovered": False},
            {"type": "business", "rule": "Workers who exit mid-month are billable only to their last working day; Meridian's gate system is the reference.", "discovered": False},
            {"type": "format", "rule": "Lines must be grouped site-wise (Shamshabad, Medchal, Patancheru), not role-wise.", "discovered": False},
            {"type": "format", "rule": "Invoices are only accepted on the portal between the 1st and 5th of the month. Later uploads sit unprocessed until the next window.", "discovered": False},
        ],
    },
    {
        "id": "BUY-YOGITA",
        "legal_name": "Yogita Precision Components Ltd",
        "short_name": "Yogita",
        "archetype": "Argues every number. Line-by-line scrutiny.",
        "gstin": "36AAACK2284L1Z6",
        "state_code": "36",
        "ap_contact": "Mrs. Lakshmi Narayanan, Manager - Accounts",
        "ap_email": "lakshmi.n@yogitaprecision.com",
        "ap_system": "Email, with a marked-up Excel annexure attached",
        "payment_terms_days": 30,
        "sites": [
            {"code": "PL1", "name": "Pashamylaram Plant"},
        ],
        "service_charge_pct": 0.065,
        "service_charge_base": "wages_only",
        "billing_cycle": "26th_to_25th",
        "headcount": 61,
        "behaviour": (
            "Lakshmi reconciles the invoice against the plant's biometric gate register "
            "line by line, every month, and replies with a marked-up copy of Pragati's "
            "own annexure. Her objections are specific and almost always arithmetically "
            "correct. She is not difficult — she is thorough, and Pragati's data is "
            "usually the sloppy side."
        ),
        "ground_truth_rules": [
            {"type": "business", "rule": "Man-days must reconcile to the plant biometric gate register. Yogita's register is authoritative, not Pragati's muster.", "discovered": False},
            {"type": "business", "rule": "Billing cycle runs 26th to 25th, not calendar month. Days after the 25th belong to the next invoice.", "discovered": False},
            {"type": "business", "rule": "Overtime above 1.5x requires prior written approval from the plant head, referenced by approval number.", "discovered": False},
            {"type": "business", "rule": "Service charge is computed on wages only, never on PF/ESI.", "discovered": False},
            {"type": "format", "rule": "The annexure must be in Yogita's own Excel template with gate ID and shift columns.", "discovered": False},
            {"type": "business", "rule": "A worker absent more than 3 consecutive days is not billable for those days even if on the muster.", "discovered": False},
        ],
    },
    {
        "id": "BUY-TEAMLEASE",
        "legal_name": "Teamlease Retail Ventures Pvt Ltd",
        "short_name": "Teamlease",
        "archetype": "Silent short-payer. Deducts without explanation.",
        "gstin": "36AAGCV5531M1ZP",
        "state_code": "36",
        "ap_contact": "Accounts Payable (shared mailbox, rarely replies)",
        "ap_email": "payables@teamleaseretail.in",
        "ap_system": "NEFT with a remittance advice PDF, sometimes",
        "payment_terms_days": 45,
        "sites": [
            {"code": "ST", "name": "6 stores - Hyderabad metro"},
        ],
        "service_charge_pct": 0.08,
        "service_charge_base": "wages_plus_statutory",
        "billing_cycle": "calendar_month",
        "headcount": 49,
        "behaviour": (
            "Teamlease never raises a dispute. They simply pay less than the invoice and "
            "move on. Pragati discovers the gap at bank reconciliation, often weeks later. "
            "A remittance advice sometimes arrives, sometimes does not. By the time anyone "
            "investigates, the deduction is two cycles old and usually gets written off."
        ),
        "ground_truth_rules": [
            {"type": "business", "rule": "Uncovered shifts are deducted at Rs 500 per shift as an SLA penalty, applied silently.", "discovered": False},
            {"type": "business", "rule": "Payment terms are 45 days from invoice date, not the 30 days stated on Pragati's invoice.", "discovered": False},
            {"type": "business", "rule": "Festival/holiday double-pay is not accepted unless the store manager pre-approved the shift in writing.", "discovered": False},
        ],
    },
]

# ---------------------------------------------------------------- rate cards
rate_cards = [
    {
        "buyer_id": "BUY-MERIDIAN", "version": "v3", "effective_from": "2026-04-01",
        "rates": [
            {"role": "Security Guard", "unit": "per_man_day", "rate": 720},
            {"role": "Housekeeping Attendant", "unit": "per_man_day", "rate": 640},
            {"role": "Loader / Packer", "unit": "per_man_day", "rate": 680},
            {"role": "Forklift Operator", "unit": "per_man_day", "rate": 950},
            {"role": "Overtime", "unit": "per_hour", "rate": 135},
        ],
    },
    {
        "buyer_id": "BUY-YOGITA", "version": "v2", "effective_from": "2026-07-01",
        "rates": [
            {"role": "Machine Operator Helper", "unit": "per_man_day", "rate": 780},
            {"role": "Material Handler", "unit": "per_man_day", "rate": 700},
            {"role": "Housekeeping Attendant", "unit": "per_man_day", "rate": 620},
            {"role": "Overtime (1.5x)", "unit": "per_hour", "rate": 146},
            {"role": "Overtime (2x)", "unit": "per_hour", "rate": 195},
        ],
    },
    {
        "buyer_id": "BUY-TEAMLEASE", "version": "v4", "effective_from": "2026-01-01",
        "rates": [
            {"role": "Store Security Guard", "unit": "per_man_day", "rate": 690},
            {"role": "Housekeeping Attendant", "unit": "per_man_day", "rate": 620},
            {"role": "Stock Assistant", "unit": "per_man_day", "rate": 660},
            {"role": "Overtime", "unit": "per_hour", "rate": 130},
        ],
    },
]


# ---------------------------------------------------------------- invoice math
def build_invoice(inv_id, buyer, period_label, period_start, period_end,
                  invoice_date, due_date, lines, sc_pct, sc_base,
                  status, po_number, fill_line_po=False, notes=""):
    """lines: list of dicts with description, site_code, role, qty, unit, rate"""
    # Integer paise, half-up: the same rounding the app's arithmetic engine uses,
    # so the dataset and the engine agree to the paisa.
    def bp(paise, rate_bp):
        return (paise * rate_bp * 2 + 10_000) // 20_000

    for ln in lines:
        ln["amount"] = round(ln["qty"] * ln["rate"] * 100) / 100
        if fill_line_po:
            ln["po_number"] = po_number

    wages = sum(round(l["qty"] * l["rate"] * 100) for l in lines)
    pf = bp(wages, round(PF_RATE * 10_000))
    esi = bp(wages, round(ESI_RATE * 10_000))

    sc_basis = wages if sc_base == "wages_only" else wages + pf + esi
    service_charge = bp(sc_basis, round(sc_pct * 10_000))

    taxable = wages + pf + esi + service_charge
    cgst = bp(taxable, round(CGST * 10_000))
    sgst = bp(taxable, round(SGST * 10_000))
    total = taxable + cgst + sgst
    r = lambda paise: paise / 100

    return {
        "invoice_id": inv_id,
        "buyer_id": buyer["id"],
        "buyer_name": buyer["legal_name"],
        "buyer_gstin": buyer["gstin"],
        "period_label": period_label,
        "period_start": period_start,
        "period_end": period_end,
        "invoice_date": invoice_date,
        "due_date": due_date,
        "sac": SAC_STAFFING,
        "po_number": po_number,
        "lines": lines,
        "totals": {
            "wages": r(wages),
            "pf_employer": r(pf),
            "esi_employer": r(esi),
            "service_charge": r(service_charge),
            "service_charge_pct": sc_pct,
            "service_charge_base": sc_base,
            "service_charge_basis_amount": r(sc_basis),
            "taxable_value": r(taxable),
            "cgst": r(cgst),
            "sgst": r(sgst),
            "grand_total": r(total),
        },
        "status": status,
        "notes": notes,
    }


def L(desc, site, role, qty, unit, rate):
    return {
        "line_id": None,
        "description": desc,
        "site_code": site,
        "role": role,
        "qty": qty,
        "unit": unit,
        "rate": rate,
        "po_number": None,
        "sac": None,
    }


def number_lines(lines, prefix="L"):
    for i, ln in enumerate(lines, start=1):
        ln["line_id"] = f"{prefix}{i}"
    return lines


meridian = buyers[0]
yogita = buyers[1]
teamlease = buyers[2]


def meridian_lines(sg, hk, ld, fk, ot):
    """Meridian invoices are cut role by role, the way Pragati's template does it.

    sg = (SH, MD, PY) security guards, hk = (SH, MD) housekeeping, ld = (SH, MD)
    loaders, fk = PY forklift, ot = (SH, MD, PY) overtime hours. The lines are
    deliberately NOT grouped by site: that is what Meridian's GL posting rejects.
    """
    return number_lines([
        L("Security Guard - Shamshabad Hub", "SH", "Security Guard", sg[0], "man-days", 720),
        L("Security Guard - Medchal DC", "MD", "Security Guard", sg[1], "man-days", 720),
        L("Security Guard - Patancheru Yard", "PY", "Security Guard", sg[2], "man-days", 720),
        L("Housekeeping Attendant - Shamshabad Hub", "SH", "Housekeeping Attendant", hk[0], "man-days", 640),
        L("Housekeeping Attendant - Medchal DC", "MD", "Housekeeping Attendant", hk[1], "man-days", 640),
        L("Loader / Packer - Shamshabad Hub", "SH", "Loader / Packer", ld[0], "man-days", 680),
        L("Loader / Packer - Medchal DC", "MD", "Loader / Packer", ld[1], "man-days", 680),
        L("Forklift Operator - Patancheru Yard", "PY", "Forklift Operator", fk, "man-days", 950),
        L("Overtime - Shamshabad Hub", "SH", "Overtime", ot[0], "hours", 135),
        L("Overtime - Medchal DC", "MD", "Overtime", ot[1], "hours", 135),
        L("Overtime - Patancheru Yard", "PY", "Overtime", ot[2], "hours", 135),
    ])


# ---- Meridian, August 2026 (paid, but late — portal rejection)
mer_aug_lines = meridian_lines(
    sg=(434, 310, 248), hk=(248, 186), ld=(558, 372), fk=124, ot=(50, 44, 70))

inv_mer_aug = build_invoice(
    "INV-2026-0831", meridian, "August 2026", "2026-08-01", "2026-08-31",
    "2026-09-03", "2026-10-03", mer_aug_lines, 0.07, "wages_only",
    status="paid_late", po_number="MLP/PO/2026/3318",
    notes="Uploaded to Ariba 3 Sep. Silently rejected — missing SAC on lines. Discovered 17 Sep when chasing. Re-uploaded 18 Sep, outside the 1-5 window, so it sat until 1 Oct. Paid 29 Oct, 26 days late.",
)

# ---- Meridian, September 2026  <<< THE DEMO INVOICE >>>
mer_sep_lines = meridian_lines(
    sg=(420, 300, 240), hk=(240, 180), ld=(540, 360), fk=120, ot=(54, 40, 92))

inv_mer_sep = build_invoice(
    "INV-2026-0847", meridian, "September 2026", "2026-09-01", "2026-09-30",
    "2026-10-02", "2026-11-01", mer_sep_lines, 0.07, "wages_only",
    status="disputed", po_number="MLP/PO/2026/3318",
    notes="THE DEMO INVOICE. Sent 2 Oct. Prashant replied 6 Oct with the mixed-bucket objection (see demo_dispute.txt).",
)

# ---- Meridian, October 2026  <<< PRE-SEND CHECK TARGET >>>
# Deliberately repeats the same mistakes, so the learned rules fire.
mer_oct_lines = meridian_lines(
    sg=(434, 310, 248), hk=(248, 186), ld=(558, 372), fk=124, ot=(48, 42, 81))

inv_mer_oct = build_invoice(
    "INV-2026-0863", meridian, "October 2026", "2026-10-01", "2026-10-31",
    "2026-11-03", "2026-12-03", mer_oct_lines, 0.07, "wages_only",
    status="draft", po_number="MLP/PO/2026/3318",
    notes=(
        "PRE-SEND CHECK TARGET. Deliberately seeded with the same defects the "
        "September dispute taught: no PO number against the lines, no SAC on the "
        "lines, lines grouped role-wise rather than site-wise, unreferenced OT "
        "(171 hrs, no authorisation numbers) and 2 exited workers billed the full "
        "month (Loader/Packer SH). Dated 3 Nov, inside Meridian's 1-5 window."
    ),
)

# ---- Yogita, September 2026
kri_sep_lines = number_lines([
    L("Machine Operator Helper - Pashamylaram", "PL1", "Machine Operator Helper", 728, "man-days", 780),
    L("Material Handler - Pashamylaram", "PL1", "Material Handler", 546, "man-days", 700),
    L("Housekeeping Attendant - Pashamylaram", "PL1", "Housekeeping Attendant", 182, "man-days", 620),
    L("Overtime (1.5x) - Pashamylaram", "PL1", "Overtime (1.5x)", 214, "hours", 146),
])

inv_kri_sep = build_invoice(
    "INV-2026-0849", yogita, "26 Aug - 25 Sep 2026", "2026-08-26", "2026-09-25",
    "2026-10-02", "2026-11-01", kri_sep_lines, 0.065, "wages_only",
    status="disputed", po_number="YPC/PO/2026/0912", fill_line_po=True,
    notes="Lakshmi returned a marked-up annexure disputing 31 man-days and the full OT line.",
)

# ---- Teamlease, September 2026 (short-paid)
van_sep_lines = number_lines([
    L("Store Security Guard - 6 stores", "ST", "Store Security Guard", 540, "man-days", 690),
    L("Housekeeping Attendant - 6 stores", "ST", "Housekeeping Attendant", 360, "man-days", 620),
    L("Stock Assistant - 6 stores", "ST", "Stock Assistant", 450, "man-days", 660),
    L("Overtime - 6 stores", "ST", "Overtime", 96, "hours", 130),
])

inv_van_sep = build_invoice(
    "INV-2026-0852", teamlease, "September 2026", "2026-09-01", "2026-09-30",
    "2026-10-02", "2026-11-16", van_sep_lines, 0.08, "wages_plus_statutory",
    status="short_paid", po_number="TRV/PO/2026/0455", fill_line_po=True,
    notes="No reply, no dispute raised. NEFT received 14 Nov for less than the invoice value. No remittance advice.",
)

invoices = [inv_mer_aug, inv_mer_sep, inv_mer_oct, inv_kri_sep, inv_van_sep]

# ---------------------------------------------------------------- annexure
# Person-level detail for the Meridian lines the dispute touches. It is an
# extract: only the workers the dispute references. `ot_summary` is the
# authoritative overtime ledger, per site, so the engine can check an OT line
# against what the site manager actually authorised.
annexure_sep_meridian = {
    "invoice_id": "INV-2026-0847",
    "buyer_id": "BUY-MERIDIAN",
    "note": "Extract. Only the rows the September dispute references.",
    "rows": [
        {"emp_name": "Ramesh Kumar Yadav", "role": "Loader / Packer", "site": "SH", "days_billed": 30, "last_working_day": None, "ot_hours": 14, "ot_auth_ref": None},
        {"emp_name": "Shaik Imran", "role": "Loader / Packer", "site": "SH", "days_billed": 30, "last_working_day": "2026-09-18", "ot_hours": 0, "ot_auth_ref": None},
        {"emp_name": "Bhaskar Rao Gundu", "role": "Loader / Packer", "site": "SH", "days_billed": 30, "last_working_day": "2026-09-22", "ot_hours": 0, "ot_auth_ref": None},
        {"emp_name": "Mohd Rafiuddin", "role": "Security Guard", "site": "MD", "days_billed": 30, "last_working_day": None, "ot_hours": 22, "ot_auth_ref": "MLP-OT-9931"},
        {"emp_name": "Srinivas Chary", "role": "Security Guard", "site": "MD", "days_billed": 30, "last_working_day": None, "ot_hours": 18, "ot_auth_ref": "MLP-OT-9931"},
        {"emp_name": "Jagadish Naik", "role": "Forklift Operator", "site": "PY", "days_billed": 30, "last_working_day": None, "ot_hours": 26, "ot_auth_ref": None},
        {"emp_name": "Venkatesh Bandari", "role": "Forklift Operator", "site": "PY", "days_billed": 30, "last_working_day": None, "ot_hours": 31, "ot_auth_ref": None},
        {"emp_name": "Lakshmi Devi", "role": "Housekeeping Attendant", "site": "SH", "days_billed": 30, "last_working_day": None, "ot_hours": 9, "ot_auth_ref": None},
    ],
    "ot_summary": {
        "total_billed_hours": 186,
        "hours_with_authorisation": 40,
        "hours_without_authorisation": 146,
        "authorisation_refs_present": ["MLP-OT-9931"],
        "by_site": {
            "SH": {"billed_hours": 54, "authorised_hours": 0},
            "MD": {"billed_hours": 40, "authorised_hours": 40},
            "PY": {"billed_hours": 92, "authorised_hours": 0},
        },
    },
}

# Person-level detail for the October draft (pre-send check target). Same
# defects as September: OT has no Meridian authorisation reference, and two
# Shamshabad loaders who exited mid-month are billed all 31 days.
annexure_oct_meridian = {
    "invoice_id": "INV-2026-0863",
    "buyer_id": "BUY-MERIDIAN",
    "note": "Extract. Only the rows relevant to the pre-send check.",
    "rows": [
        {"emp_name": "Ramesh Kumar Yadav", "role": "Loader / Packer", "site": "SH", "days_billed": 31, "last_working_day": None, "ot_hours": 12, "ot_auth_ref": None},
        {"emp_name": "Mohd Ismail", "role": "Loader / Packer", "site": "SH", "days_billed": 31, "last_working_day": "2026-10-14", "ot_hours": 0, "ot_auth_ref": None},
        {"emp_name": "Gopal Reddy Anumula", "role": "Loader / Packer", "site": "SH", "days_billed": 31, "last_working_day": "2026-10-23", "ot_hours": 0, "ot_auth_ref": None},
        {"emp_name": "Mohd Rafiuddin", "role": "Security Guard", "site": "MD", "days_billed": 31, "last_working_day": None, "ot_hours": 20, "ot_auth_ref": None},
        {"emp_name": "Srinivas Chary", "role": "Security Guard", "site": "MD", "days_billed": 31, "last_working_day": None, "ot_hours": 16, "ot_auth_ref": None},
        {"emp_name": "Jagadish Naik", "role": "Forklift Operator", "site": "PY", "days_billed": 31, "last_working_day": None, "ot_hours": 28, "ot_auth_ref": None},
        {"emp_name": "Venkatesh Bandari", "role": "Forklift Operator", "site": "PY", "days_billed": 31, "last_working_day": None, "ot_hours": 33, "ot_auth_ref": None},
        {"emp_name": "Lakshmi Devi", "role": "Housekeeping Attendant", "site": "SH", "days_billed": 31, "last_working_day": None, "ot_hours": 11, "ot_auth_ref": None},
    ],
    "ot_summary": {
        "total_billed_hours": 171,
        "hours_with_authorisation": 0,
        "hours_without_authorisation": 171,
        "authorisation_refs_present": [],
        "by_site": {
            "SH": {"billed_hours": 48, "authorised_hours": 0},
            "MD": {"billed_hours": 42, "authorised_hours": 0},
            "PY": {"billed_hours": 81, "authorised_hours": 0},
        },
    },
}

# ---------------------------------------------------------------- disputes
# 18 historical disputes across ~Jun-Sep 2026, with how each resolved.
# These are the agent's few-shot history. Written in the register the
# sender would actually use.
disputes = [
    # ---------------- Meridian (format-heavy, silent rejections)
    {
        "dispute_id": "DSP-001", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0712",
        "received_at": "2026-06-19", "channel": "email", "detected_how": "chased after 14 days of silence",
        "raw_text": "Dear Sir,\n\nYour invoice is not appearing in our system. Please check and resubmit.\n\nRegards,\nPrashant Dubey\nAP - Meridian Logistics Park",
        "buckets": ["format"],
        "resolution": "Found the Ariba upload had failed validation because the PO number was entered in the reference field instead of the line-item field. Re-uploaded 21 Jun.",
        "rule_learned": "PO number must be entered at line-item level in Ariba, not in the invoice reference field.",
        "rule_type": "format",
        "days_delayed": 19, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-002", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0729",
        "received_at": "2026-07-14", "channel": "email", "detected_how": "chased",
        "raw_text": "Hi,\n\nInvoice rejected again. PO number is given only in the reference field. Our system cannot post without the PO against each line item. Kindly revise.\n\nPrashant",
        "buckets": ["format"],
        "resolution": "PO number added against every line and re-uploaded.",
        "rule_learned": "The PO number must be entered against every line item, not only in the invoice reference field.",
        "rule_type": "format",
        "days_delayed": 12, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-004", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0745",
        "received_at": "2026-08-11", "channel": "email", "detected_how": "chased",
        "raw_text": "Madam,\n\nThe OT amount claimed is not supported. Site manager has not raised any OT authorisation for Patancheru for July. Please remove or provide authorisation number.\n\nPrashant Dubey",
        "buckets": ["business"],
        "resolution": "57 of 142 OT hours had no authorisation reference. Credit note issued for Rs 7,695. Balance paid.",
        "rule_learned": "Overtime is payable only against a Meridian OT authorisation number issued by the site manager.",
        "rule_type": "business",
        "days_delayed": 16, "amount_disputed": 7695,
    },
    {
        "dispute_id": "DSP-006", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0831",
        "received_at": "2026-09-17", "channel": "phone, confirmed by email", "detected_how": "chased after 14 days of silence",
        "raw_text": "As discussed on call - the invoice was rejected by the portal on upload. SAC code is required on each line item. Your invoice has it only in the header. Please correct and upload. Note our portal window for submission is 1st to 5th, so this will now move to next month's run.",
        "buckets": ["format"],
        "resolution": "SAC 998519 added to each line. Re-uploaded 18 Sep but outside window, so it sat until 1 Oct. Paid 29 Oct — 26 days late.",
        "rule_learned": "SAC 998519 must appear on every line, and invoices are only accepted on the portal between the 1st and 5th.",
        "rule_type": "format",
        "days_delayed": 26, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-007", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0712",
        "received_at": "2026-06-28", "channel": "email", "detected_how": "reply",
        "raw_text": "Kindly group the lines site wise (Shamshabad, Medchal, Patancheru). Currently you have given role wise which does not match our GL posting.",
        "buckets": ["format"],
        "resolution": "Re-sorted lines by site.",
        "rule_learned": "Lines must be grouped site-wise (Shamshabad, Medchal, Patancheru), not role-wise.",
        "rule_type": "format",
        "days_delayed": 6, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-008", "buyer_id": "BUY-MERIDIAN", "invoice_id": "INV-2026-0698",
        "received_at": "2026-06-05", "channel": "email", "detected_how": "proactive from buyer",
        "raw_text": "Two of your loaders left on 20th May but you have billed full month. Our gate records show last entry 20/05. Please revise.",
        "buckets": ["business"],
        "resolution": "Credit note for 22 man-days, Rs 14,960.",
        "rule_learned": "Workers who exit mid-month are billable only to their last working day; Meridian's gate system is the reference.",
        "rule_type": "business",
        "days_delayed": 11, "amount_disputed": 14960,
    },

    # ---------------- Yogita (business-heavy, forensic)
    {
        "dispute_id": "DSP-009", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0714",
        "received_at": "2026-06-30", "channel": "email with marked-up annexure", "detected_how": "buyer replied",
        "raw_text": "Dear Sunita,\n\nPlease find attached our reconciliation against your annexure. As per our gate register the total man-days for the period is 1,478 against your claim of 1,512. Difference of 34 man-days is mainly from the operator helper category. Marked in yellow.\n\nAlso please note our cycle is 26th to 25th. You have billed 26th to 30th September in this invoice which should move to next bill.\n\nKindly revise and resend.\n\nRegards,\nLakshmi Narayanan\nManager - Accounts",
        "buckets": ["business"],
        "resolution": "Verified against gate register — Yogita was correct on 29 of 34 days. Revised invoice issued. The 5 contested days were withdrawn to keep the relationship smooth.",
        "rule_learned": "Man-days must reconcile to the plant biometric gate register, which is authoritative over Pragati's muster. Cycle is 26th to 25th.",
        "rule_type": "business",
        "days_delayed": 14, "amount_disputed": 26520,
    },
    {
        "dispute_id": "DSP-010", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0731",
        "received_at": "2026-07-29", "channel": "email", "detected_how": "buyer replied",
        "raw_text": "Sunita,\n\nOT of 186 hours claimed at 2x rate. Plant head has approved only 94 hours at 1.5x for this period (approval YPC/OT/26-07/118). Remaining cannot be processed. Please issue revised invoice.\n\nLakshmi",
        "buckets": ["business"],
        "resolution": "Revised to 94 hrs at 1.5x. Credit note Rs 23,122.",
        "rule_learned": "Overtime above 1.5x requires prior written approval from the plant head, referenced by approval number.",
        "rule_type": "business",
        "days_delayed": 17, "amount_disputed": 23122,
    },
    {
        "dispute_id": "DSP-011", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0731",
        "received_at": "2026-07-29", "channel": "same email", "detected_how": "buyer replied",
        "raw_text": "Further, your service charge of 6.5% appears to be calculated on wages plus PF and ESI. Our agreement clause 4.2 provides service charge on wages component only. Please recompute.",
        "buckets": ["business"],
        "resolution": "Agreed — contract does say wages only. Recomputed. This had been wrong for 3 months; Yogita did not claim the earlier months back.",
        "rule_learned": "Service charge is computed on wages only, never on PF/ESI.",
        "rule_type": "business",
        "days_delayed": 17, "amount_disputed": 9431,
    },
    {
        "dispute_id": "DSP-012", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0748",
        "received_at": "2026-08-28", "channel": "email with marked-up annexure", "detected_how": "buyer replied",
        "raw_text": "Attached marked copy. Four workers shown present for full period but our register shows continuous absence - K. Srinivasulu 7 days, M. Yadaiah 5 days, P. Ganesh 4 days, D. Mallesh 6 days. As per practice continuous absence beyond 3 days is not billable. 22 man-days to be deducted.\n\nLakshmi",
        "buckets": ["business"],
        "resolution": "Verified. Credit note for 22 man-days, Rs 16,940.",
        "rule_learned": "A worker absent more than 3 consecutive days is not billable for those days even if on the muster.",
        "rule_type": "business",
        "days_delayed": 13, "amount_disputed": 16940,
    },
    {
        "dispute_id": "DSP-013", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0748",
        "received_at": "2026-08-29", "channel": "email", "detected_how": "follow-up",
        "raw_text": "Also the annexure format has changed from your side. Please continue to use the template we shared - we need employee code, gate ID and shift columns for our records.",
        "buckets": ["format"],
        "resolution": "Reverted to Yogita's template.",
        "rule_learned": "The annexure must use Yogita's own Excel template with gate ID and shift columns.",
        "rule_type": "format",
        "days_delayed": 4, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-014", "buyer_id": "BUY-YOGITA", "invoice_id": "INV-2026-0849",
        "received_at": "2026-10-06", "channel": "email with marked-up annexure", "detected_how": "buyer replied",
        "raw_text": "Dear Sunita,\n\n31 man-days variance again this period, same pattern as earlier - operator helper category. Also the entire OT line of 214 hours has no approval reference quoted. Please check and revert.\n\nLakshmi",
        "buckets": ["business"],
        "resolution": "OPEN at time of dataset snapshot.",
        "rule_learned": None,
        "rule_type": None,
        "days_delayed": None, "amount_disputed": 55448,
    },

    # ---------------- Teamlease (silent short payments)
    {
        "dispute_id": "DSP-015", "buyer_id": "BUY-TEAMLEASE", "invoice_id": "INV-2026-0701",
        "received_at": "2026-07-18", "channel": "none - detected at bank reconciliation",
        "detected_how": "NEFT received was less than invoice value; no communication",
        "raw_text": "(no message received. Invoice Rs 11,84,320. NEFT credited Rs 11,42,320. Gap Rs 42,000.)",
        "buckets": ["business"],
        "resolution": "After two weeks of chasing, store ops confirmed 84 uncovered shifts at Rs 500 penalty. Written off — no credit note raised, just absorbed.",
        "rule_learned": "Uncovered shifts are deducted at Rs 500 per shift as an SLA penalty, applied silently.",
        "rule_type": "business",
        "days_delayed": 0, "amount_disputed": 42000,
    },
    {
        "dispute_id": "DSP-017", "buyer_id": "BUY-TEAMLEASE", "invoice_id": "INV-2026-0738",
        "received_at": "2026-09-22", "channel": "none - detected at bank reconciliation",
        "detected_how": "payment arrived 45 days after invoice date, not 30",
        "raw_text": "(no message. Payment consistently lands on day 45-47 despite invoice stating 30 days.)",
        "buckets": ["business"],
        "resolution": "Ravi checked the signed work order — it does say 45 days. Pragati's invoice template had been stating 30 days incorrectly for two years.",
        "rule_learned": "Payment terms with Teamlease are 45 days from invoice date, not 30.",
        "rule_type": "business",
        "days_delayed": 0, "amount_disputed": 0,
    },
    {
        "dispute_id": "DSP-018", "buyer_id": "BUY-TEAMLEASE", "invoice_id": "INV-2026-0738",
        "received_at": "2026-09-26", "channel": "none - detected at bank reconciliation",
        "detected_how": "short credit, no advice",
        "raw_text": "(no message. Invoice Rs 12,07,640. NEFT credited Rs 11,89,340. Gap Rs 18,300.)",
        "buckets": ["business"],
        "resolution": "Traced to Ganesh Chaturthi double-pay shifts that the store manager had not pre-approved in writing. Absorbed.",
        "rule_learned": "Festival/holiday double-pay is not accepted unless the store manager pre-approved the shift in writing.",
        "rule_type": "business",
        "days_delayed": 0, "amount_disputed": 18300,
    },
]

# ---------------------------------------------------------------- demo dispute
# Pasted the way a person pastes a message from a phone: the body only, no sender, date or signature block.
demo_dispute = """Dear Madam,

We have reviewed the invoice and the following observations are there:

1. OT claimed is 186 hours. Our site managers have issued authorisation only
   for Medchal (ref MLP-OT-9931, 40 hours). Patancheru forklift OT and the
   Shamshabad housekeeping OT are not authorised. Kindly remove the
   unauthorised portion.

2. Two loaders at Shamshabad have been billed for the full month. Our gate
   records show Shaik Imran last entry 18/09 and B. Rao last entry 22/09.
   Please bill only till last working day.

3. The PO number is again given only in the reference field and not against
   the lines. We have told this earlier also. Our system cannot post it in
   this form.

4. SAC code is shown only in the header. It is required on every line item.

5. The lines are given role wise. Please group them site wise, as our GL
   posting is done site wise.

Please share the revised invoice at the earliest. Note that our portal
accepts invoices only from 1st to 5th of the month.
"""

# ---------------------------------------------------------------- expected
# What a correct agent run should produce for the demo dispute, when the
# context is the DEMO split of the rule ledger (held out: see DEMO_HELD_OUT).
# Used to measure the agent, and to keep the demo honest. The money is computed
# here from the invoice itself, the same way the app's arithmetic engine does it.
DEMO_HELD_OUT = ["MER-R5", "MER-R6", "YOG-R6"]


def _revised_demo_invoice():
    lines = copy.deepcopy(inv_mer_sep["lines"])
    qty = {"L9": 0, "L11": 0, "L6": 520}   # OT SH, OT PY, Loader SH
    for ln in lines:
        if ln["line_id"] in qty:
            ln["qty"] = qty[ln["line_id"]]
    return build_invoice(
        "INV-2026-0847", meridian, "September 2026", "2026-09-01", "2026-09-30",
        "2026-10-02", "2026-11-01", lines, 0.07, "wages_only",
        status="disputed", po_number="MLP/PO/2026/3318",
    )


_revised = _revised_demo_invoice()
_wage_cut = round(inv_mer_sep["totals"]["wages"] - _revised["totals"]["wages"], 2)
_total_cut = round(inv_mer_sep["totals"]["grand_total"] - _revised["totals"]["grand_total"], 2)

expected_analysis = {
    "invoice_id": "INV-2026-0847",
    "demo_held_out_rules": DEMO_HELD_OUT,
    "claims": [
        {
            "claim": "Overtime at Shamshabad and Patancheru is not authorised; only Medchal's 40 hours are",
            "bucket": "business",
            "lines_affected": ["L9", "L11"],
            "proposed_fix": "adjust_line(L9, qty, 0); adjust_line(L11, qty, 0)",
            "value_impact_inr": -19710,
            "autonomy": "propose_merchant_approves",
            "matches_existing_rule": "MER-R3 (DSP-004) — OT requires a Meridian authorisation number",
        },
        {
            "claim": "Two exited loaders billed for the full month",
            "bucket": "business",
            "lines_affected": ["L6"],
            "proposed_fix": "adjust_line(L6, qty, 520) — Shaik Imran 12 days and B. Rao 8 days removed",
            "value_impact_inr": -13600,
            "autonomy": "propose_merchant_approves",
            "matches_existing_rule": "MER-R4 (DSP-008) — bill only to last working day per Meridian gate records",
        },
        {
            "claim": "PO number is not against the lines",
            "bucket": "format",
            "lines_affected": ["all"],
            "proposed_fix": "set_field(po_number) on every line",
            "value_impact_inr": 0,
            "autonomy": "auto_apply",
            "matches_existing_rule": "MER-R1 (DSP-001, DSP-002)",
        },
        {
            "claim": "SAC code is only in the header, not on every line",
            "bucket": "format",
            "lines_affected": ["all"],
            "proposed_fix": "set_field(sac) on every line",
            "value_impact_inr": 0,
            "autonomy": "auto_apply",
            "matches_existing_rule": "MER-R2 (DSP-006)",
        },
        {
            "claim": "Lines are grouped role-wise; Meridian wants them site-wise",
            "bucket": "format",
            "lines_affected": ["all"],
            "proposed_fix": "regroup_lines(site_code)",
            "value_impact_inr": 0,
            "autonomy": "auto_apply",
            "matches_existing_rule": None,
        },
    ],
    "new_rules_to_learn": [
        {"rule_id": "MER-R5", "type": "format", "rule": "Lines must be grouped site-wise, not role-wise.", "note": "From claim 5. Earlier asked for in DSP-007."},
        {"rule_id": "MER-R6", "type": "format", "rule": "Meridian's portal accepts invoices only between the 1st and 5th of the month.", "note": "From the closing remark, not a numbered claim. Earlier stated in DSP-006."},
    ],
    "wage_reduction_inr": _wage_cut,
    "revised_invoice_total_inr": _revised["totals"]["grand_total"],
    "original_invoice_total_inr": inv_mer_sep["totals"]["grand_total"],
    "total_reduction_inr": _total_cut,
    "collectable_now_inr": _revised["totals"]["grand_total"],
    "note_on_split": (
        "The revised total is collectable immediately once the two business claims "
        "are accepted. Under today's process the whole invoice waits while a "
        "Rs 48,444 disagreement is settled — and the format items would have "
        "stalled it a further two weeks on top."
    ),
    "commentary": (
        "Four of the five claims match rules already learned from earlier disputes "
        "(MER-R1, R2, R3, R4). The agent should say so explicitly — that is the "
        "prevention argument: every one of these was foreseeable before the invoice "
        "was sent. The fifth claim and the closing remark are new rules to learn."
    ),
}


# ---------------------------------------------------------------- runtime / QA split
#
# The agent must NOT see the answer key. Two tiers:
#
#   dataset/      runtime — everything the app and the agent may read
#   dataset/qa/   answer key — ground-truth rules and expected outputs. Test only.
#
# dataset/rule_ledger.json is the whole pool of the buyers' rules, in the shape
# the ledger uses at runtime. The app never feeds the pool to the model. It
# splits it with a seed: 12 rules go into the context, the rest are held out so
# the agent has something genuinely new to learn. See src/lib/data/split.ts.

PREFIX = {"BUY-MERIDIAN": "MER", "BUY-YOGITA": "YOG", "BUY-TEAMLEASE": "TEA"}

# Which historical dispute each ground-truth rule is recoverable from.
RULE_SOURCE = {
    "MER-R1": ["DSP-001", "DSP-002"], "MER-R5": ["DSP-007"], "MER-R2": ["DSP-006"],
    "MER-R6": ["DSP-006"], "MER-R3": ["DSP-004"], "MER-R4": ["DSP-008"],
    "YOG-R1": ["DSP-009"], "YOG-R2": ["DSP-009"], "YOG-R3": ["DSP-010"],
    "YOG-R4": ["DSP-011"], "YOG-R6": ["DSP-012"], "YOG-R5": ["DSP-013"],
    "TEA-R1": ["DSP-015"], "TEA-R2": ["DSP-017"], "TEA-R3": ["DSP-018"],
}

CONFIDENCE = {}  # rule_id -> high / medium, by how many disputes corroborate it


def build_tiers():
    """Returns (runtime_buyers, runtime_disputes, rule_pool, ground_truth)."""
    ground_truth = []
    rule_pool = []

    for b in buyers:
        pfx = PREFIX[b["id"]]
        for i, r in enumerate(b["ground_truth_rules"], start=1):
            rid = f"{pfx}-R{i}"
            sources = RULE_SOURCE.get(rid, [])
            conf = "high" if len(sources) > 1 else "medium"
            CONFIDENCE[rid] = conf
            ground_truth.append({
                "rule_id": rid,
                "buyer_id": b["id"],
                "buyer_short_name": b["short_name"],
                "type": r["type"],
                "rule": r["rule"],
                "recoverable_from": sources,
                "expected_confidence": conf,
            })
            rule_pool.append({
                "rule_id": rid,
                "buyer_id": b["id"],
                "type": r["type"],
                "rule": r["rule"],
                "confidence": conf,
                "learned_from": sources,
                "status": "active",
                "times_corroborated": len(sources),
            })

    # runtime buyers: profile and behaviour, but no answer key
    rt_buyers = []
    for b in buyers:
        c = copy.deepcopy(b)
        c.pop("ground_truth_rules", None)
        rt_buyers.append(c)

    # runtime disputes: raw text and how it resolved, but not the rule to infer
    rt_disputes = []
    for d in disputes:
        c = copy.deepcopy(d)
        c.pop("rule_learned", None)
        c.pop("rule_type", None)
        rt_disputes.append(c)

    return rt_buyers, rt_disputes, rule_pool, ground_truth


def build_expected_rules():
    """Per-dispute: which rules a correct agent should infer from it."""
    out = []
    for d in disputes:
        rids = [rid for rid, srcs in RULE_SOURCE.items() if d["dispute_id"] in srcs]
        out.append({
            "dispute_id": d["dispute_id"],
            "buyer_id": d["buyer_id"],
            "buckets": d["buckets"],
            "expected_rule_text": d.get("rule_learned"),
            "expected_rule_type": d.get("rule_type"),
            "maps_to_rule_id": rids[0] if rids else None,
            "maps_to_rule_ids": rids,
        })
    return out


# ---------------------------------------------------------------- emit
def write(name, obj, sub=""):
    d = OUT / sub if sub else OUT
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        if isinstance(obj, str):
            f.write(obj)
        else:
            json.dump(obj, f, indent=2, ensure_ascii=False)
    return p


if __name__ == "__main__":
    rt_buyers, rt_disputes, rule_pool, ground_truth = build_tiers()

    runtime = [
        write("agency.json", agency),
        write("buyers.json", rt_buyers),
        write("rate_cards.json", rate_cards),
        write("invoices.json", invoices),
        write("annexure_INV-2026-0847.json", annexure_sep_meridian),
        write("annexure_INV-2026-0863.json", annexure_oct_meridian),
        write("disputes.json", rt_disputes),
        write("rule_ledger.json", rule_pool),
        write("demo_dispute.txt", demo_dispute),
    ]
    qa = [
        write("ground_truth_rules.json", ground_truth, sub="qa"),
        write("expected_rules_per_dispute.json", build_expected_rules(), sub="qa"),
        write("expected_analysis.json", expected_analysis, sub="qa"),
    ]

    print("RUNTIME  (dataset/)  — the agent may read these")
    for p in runtime:
        print(f"  {p.name:36s} {p.stat().st_size:>7,d} bytes")
    print("\nQA  (dataset/qa/)  — answer key, never loaded into a prompt")
    for p in qa:
        print(f"  {p.name:36s} {p.stat().st_size:>7,d} bytes")

    print("\n--- invoice totals ---")
    for inv in invoices:
        t = inv["totals"]
        print(f"{inv['invoice_id']}  {inv['buyer_name'][:28]:28s}  "
              f"wages {t['wages']:>12,.2f}  taxable {t['taxable_value']:>12,.2f}  "
              f"total {t['grand_total']:>12,.2f}  [{inv['status']}]")

    print("\n--- demo oracle ---")
    print(f"  wage cut {_wage_cut:,.2f}   total cut {_total_cut:,.2f}   "
          f"revised {_revised['totals']['grand_total']:,.2f}")

    print("\n--- rule pool ---")
    for b in buyers:
        n = sum(1 for r in rule_pool if r["buyer_id"] == b["id"])
        print(f"  {b['short_name']:9s} {n} rules")
    print(f"  total {len(rule_pool)}  (the app puts 12 in context and holds the rest out)")
