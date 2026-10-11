/** Invoice status chips. Client-safe: no file access here. */
export type Chip = "draft" | "sent" | "revised" | "disputed" | "short_paid" | "paid_late";

export const CHIP_LABEL: Record<Chip, string> = {
  draft: "Draft",
  sent: "Sent",
  revised: "Revised",
  disputed: "Disputed",
  short_paid: "Short-paid",
  paid_late: "Paid late",
};

/** Teal when the system has handled it, rose when it is holding money up, grey otherwise. */
export const CHIP_TONE: Record<Chip, "calm" | "done" | "hold"> = {
  draft: "calm", sent: "done", revised: "done", disputed: "hold", short_paid: "hold", paid_late: "calm",
};
