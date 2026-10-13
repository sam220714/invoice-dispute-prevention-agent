import {
  getBuyer, getInvoice, loadAllDisputes, loadAnnexure, loadLedger, loadLocalEnv, loadPrompt, writeRunArtifact,
} from "../data/load";
import { analyzeDispute, MessageNotReady } from "../engine/analyze";
import { assembleContext, type ContextInput } from "../engine/context";
import { AnalysisError } from "../engine/llm_call";
import { geminiFromEnv } from "../llm/gemini";
import { LlmError, type LlmProvider } from "../llm/provider";
import { RecordingProvider, ReplayOrLiveProvider, ReplayProvider } from "../llm/replay";
import { loadAnalysis, saveAnalysis } from "./store";

/**
 * Paste in, analysis out: the same path as `npm run analyze`, for the screen.
 *
 * The model is Gemini unless ANALYZE_REPLAY names a recorded fixture, which answers offline (the demo's
 * safety net). ANALYZE_RECORD saves the live reply under that name, so a good run can be kept.
 */

export type AnalyzeResponse =
  | { ok: true }
  | {
      ok: false;
      /** blocked: change the text. failed: the agent could not answer. resolved: nothing left to analyse. */
      kind: "blocked" | "failed" | "resolved";
      message: string;
      detail?: string[];
      transient?: boolean;
    };

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** The day the message was sent, from a "Date:" header such as "Mon, 6 Oct 2026, 7:42 PM"; today when there is none. */
export function receivedOn(message: string, now: Date = new Date()): string {
  const header = /^date:\s*(.+)$/im.exec(message)?.[1];
  const m = header ? /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(header) : null;
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  if (m && month) return `${m[3]}-${month}-${m[1]!.padStart(2, "0")}`;
  return now.toISOString().slice(0, 10);
}

/**
 * ANALYZE_RECEIVED_ON=YYYY-MM-DD fixes the date the message counts as received. The date is part of the prompt,
 * so without this a recording only replays on the day it was made. The demo pins it to the day of the story.
 */
function pinnedReceivedOn(): string | null {
  const pinned = process.env.ANALYZE_RECEIVED_ON;
  return pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned) ? pinned : null;
}

function providerFromEnv(): LlmProvider {
  const replay = process.env.ANALYZE_REPLAY;
  if (replay) return new ReplayProvider(replay);
  const live = geminiFromEnv();
  // The deployed demo: the recorded email is instant, everything else is live.
  const demo = process.env.ANALYZE_DEMO_REPLAY;
  if (demo) return new ReplayOrLiveProvider(demo, live);
  const record = process.env.ANALYZE_RECORD;
  return record ? new RecordingProvider(live, record) : live;
}

export async function analyseMessage(invoiceId: string, rawMessage: string): Promise<AnalyzeResponse> {
  loadLocalEnv();
  // A browser sends a textarea's line breaks as CRLF. Read the message as the file would, so the same email
  // is the same prompt whichever way it arrives (and a recorded reply still matches it).
  const message = rawMessage.replace(/\r\n?/g, "\n").trim();
  if (loadAnalysis(invoiceId)?.resolved)
    return { ok: false, kind: "resolved", message: "This dispute is already resolved. Reset the demo to run it again." };

  const invoice = getInvoice(invoiceId);
  if (invoice.status === "paid_late")
    return { ok: false, kind: "resolved", message: "This invoice is already paid, so there is nothing left to dispute." };
  const input: ContextInput = {
    buyer: getBuyer(invoice.buyer_id),
    invoice,
    annexure: loadAnnexure(invoiceId),
    rules: loadLedger(),
    disputes: loadAllDisputes(),
    message,
    receivedOn: pinnedReceivedOn() ?? receivedOn(message),
    systemPrompt: loadPrompt("analyze.md"),
  };

  try {
    const result = await analyzeDispute(input, providerFromEnv());
    // The inspectable record of what the agent looked at, as the CLI keeps it.
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    writeRunArtifact(runId, "context.json", assembleContext(input).snapshot);
    writeRunArtifact(runId, "analysis.json", result);
    saveAnalysis(invoiceId, { saved_at: new Date().toISOString(), result });
    return { ok: true };
  } catch (err) {
    if (err instanceof MessageNotReady) return { ok: false, kind: "blocked", message: err.verdict.message };
    if (err instanceof AnalysisError)
      return { ok: false, kind: "failed", message: "The agent's answer did not pass the engine's checks, so none of it was used.", detail: err.problems };
    if (err instanceof LlmError)
      return {
        ok: false, kind: "failed", transient: err.transient,
        message: err.transient ? "The model is busy right now. Try again in a moment." : err.message,
      };
    throw err;
  }
}
