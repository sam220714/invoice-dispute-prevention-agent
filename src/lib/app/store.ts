import { readStateJson, removeState, writeStateJson } from "../data/load";
import type { AnalysisResult } from "../engine/analyze";
import type { Corroboration } from "../engine/learn";
import type { Rule } from "../schema";
import type { ToolCall } from "../engine/tools";

/**
 * What the screens remember between requests, kept in state/ next to the ledger.
 * Plain JSON, no database: this is a prototype and the file is the audit trail.
 * The dataset is never written.
 */

// ------------------------------------------------------------------ pre-send
/** A business finding the merchant resolved with the agent's proposal, on a draft. */
export interface Approval {
  rule_id: string;
  /** The finding as it read when it was open: "171 overtime hours, no authorisation". */
  title: string;
  /** What happened, for the resolved row: "Overtime held pending authorisation". */
  resolved: string;
  /** One line of detail: "171 hours removed from L9, L10, L11". */
  note: string;
  line_ids: string[];
  /** The proposal as it was executed. Replayed on the draft at every render. */
  calls: ToolCall[];
  /** What it took off the invoice, as the arithmetic engine computed it when it was approved. */
  wage_cut: number;
  total_cut: number;
  at: string;
}

export interface InvoiceRecord {
  approved: Approval[];
  sent_at?: string;
  sent_total?: number;
}

interface AppFile {
  invoices: Record<string, InvoiceRecord>;
}

const APP = "app.json";
const readJson = readStateJson;
const writeJson = writeStateJson;

export const loadRecord = (invoiceId: string): InvoiceRecord =>
  readJson<AppFile>(APP, { invoices: {} }).invoices[invoiceId] ?? { approved: [] };

export function saveRecord(invoiceId: string, record: InvoiceRecord): void {
  const file = readJson<AppFile>(APP, { invoices: {} });
  file.invoices[invoiceId] = record;
  writeJson(APP, file);
}

export const loadAllRecords = (): Record<string, InvoiceRecord> =>
  readJson<AppFile>(APP, { invoices: {} }).invoices;

// ----------------------------------------------------------------- analyses
export interface ResolvedRecord {
  at: string;
  dispute_id: string;
  approved: string[];
  declined: { claim_id: string; reason: string | null }[];
  /** Quantities the merchant changed before approving, by line id. */
  edited_qty: Record<string, number>;
  /** Indexes into proposed_rules the merchant chose not to teach the ledger. */
  skipped_rules: number[];
  written: Rule[];
  corroborated: Corroboration[];
  revised_total: number;
  total_reduction: number;
  wage_reduction: number;
  ledger_size: number;
}

export interface StoredAnalysis {
  saved_at: string;
  result: AnalysisResult;
  resolved?: ResolvedRecord;
}

const safeId = (invoiceId: string) => {
  if (!/^[\w.-]+$/.test(invoiceId)) throw new Error(`bad invoice id: ${invoiceId}`);
  return invoiceId;
};
const analysisPath = (invoiceId: string) => `analyses/${safeId(invoiceId)}.json`;

export const loadAnalysis = (invoiceId: string): StoredAnalysis | null =>
  readJson<StoredAnalysis | null>(analysisPath(invoiceId), null);

export const saveAnalysis = (invoiceId: string, stored: StoredAnalysis): void => writeJson(analysisPath(invoiceId), stored);

// -------------------------------------------------------------------- reset
/** Forget everything the screens remember. The ledger is reset separately (see resetState in load.ts). */
export function resetApp(): void {
  removeState(APP);
  removeState("analyses");
}

export const discardStoredAnalysis = (invoiceId: string): void => removeState(analysisPath(invoiceId));
