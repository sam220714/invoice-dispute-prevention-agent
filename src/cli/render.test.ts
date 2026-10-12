import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadSplit } from "../lib/data/load";
import { DEMO_SEED } from "../lib/data/split";
import { buildPreSendReport } from "../lib/engine/presend";
import { applyToolCall, createDraft } from "../lib/engine/tools";
import { compactLines, renderReport, summariseApplied } from "./render";

const render = (invoiceId: string, color = false) => {
  const invoice = getInvoice(invoiceId);
  return renderReport(
    buildPreSendReport(
      { invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoiceId) },
      loadSplit(DEMO_SEED).context,
    ),
    { color },
  );
};

describe("compactLines", () => {
  it("collapses runs and keeps gaps", () => {
    expect(compactLines(["L1", "L2", "L3", "L9"])).toBe("L1-L3, L9");
    expect(compactLines(["L10", "L9"])).toBe("L9-L10");
    expect(compactLines(["L3"])).toBe("L3");
    expect(compactLines([])).toBe("");
  });
});

describe("renderReport", () => {
  const text = render("INV-2026-0863");

  it("leads with the one-line headline", () => {
    expect(text).toContain("2 business items to review");
    expect(text).toContain("2 format fixes to auto-apply");
    expect(text).not.toContain("evidence");
  });

  it("shows the two sections in bucket order", () => {
    const at = (s: string) => text.indexOf(s);
    expect(at("BUSINESS (2)")).toBeGreaterThan(-1);
    expect(at("BUSINESS (2)")).toBeLessThan(at("FORMAT (2)"));
  });

  it("makes the prevention argument and is honest that nothing was changed", () => {
    expect(text).toContain("foreseeable before the invoice went out");
    expect(text).toContain("no changes have been made");
  });

  it("is plain ASCII with no escape codes when colour is off", () => {
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("adds escape codes only when asked", () => {
    expect(render("INV-2026-0863", true)).toMatch(/\x1b\[/);
  });

  it("reads correctly for a single finding", () => {
    const invoice = getInvoice("INV-2026-0863");
    const onlySac = loadSplit(DEMO_SEED).context.filter((r) => r.rule_id === "MER-R2");
    const one = renderReport(buildPreSendReport({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: null }, onlySac));
    expect(one).toContain("The 1 finding comes from a rule");
    expect(one).not.toContain("All 1 findings");
  });

  it("says so plainly when there is nothing to fix", () => {
    const invoice = getInvoice("INV-2026-0863");
    const empty = renderReport(
      buildPreSendReport({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: null }, []),
    );
    expect(empty).toContain("Nothing found");
    expect(empty).not.toContain("foreseeable");
  });
});

describe("renderReport after auto-fix", () => {
  const invoice = getInvoice("INV-2026-0863");
  const buyer = getBuyer(invoice.buyer_id);
  const rules = loadSplit(DEMO_SEED).context;
  const { draft } = applyToolCall(
    createDraft({ invoice, buyer, annexure: loadAnnexure(invoice.invoice_id), rules }),
    { tool: "apply_template" },
    { actor: "engine" },
  );
  const applied = summariseApplied(draft.log);
  const text = renderReport(
    buildPreSendReport({ invoice: draft.invoice, buyer, annexure: draft.annexure }, rules),
    { applied },
  );

  it("collapses the per-line edits into one line each", () => {
    expect(applied).toEqual(["PO MLP/PO/2026/3318 set on 11 lines", "SAC 998519 set on 11 lines"]); // the umbrella call is not a change
  });

  it("lists what was applied, and says no amount changed", () => {
    expect(text).toContain("AUTO-APPLIED");
    expect(text).toContain("no amount was changed");
    expect(text).toContain("SAC 998519 set on 11 lines");
  });

  it("leaves the business items standing, and no format item for a person", () => {
    expect(text).toContain("2 business items to review");
    expect(text).toContain("0 format items left for a person");
    expect(text).toContain("lines: L9-L11");
  });

  it("is honest that nothing was saved", () => {
    expect(text).toContain("applied in memory only");
    expect(text).not.toContain("Detection only");
  });
});
