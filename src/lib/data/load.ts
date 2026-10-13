import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AgencySchema,
  AnnexureSchema,
  BuyerSchema,
  DisputeSchema,
  InvoiceSchema,
  OverrideSchema,
  RateCardSchema,
  RuleSchema,
  type Agency,
  type Annexure,
  type Buyer,
  type Dispute,
  type Invoice,
  type Override,
  type RateCard,
  type Rule,
} from "../schema";
import { RULE_CHECKS } from "../engine/seed_checks";
import { DEMO_SEED, splitLedger, type LedgerSplit } from "./split";

/**
 * The ONLY module that reads dataset/. Everything the agent may see goes
 * through here, and the answer key (dataset/qa) is refused outright: if it
 * reached a prompt the demo would prove nothing.
 */
const ROOT = findRoot();

/**
 * The project root. Beside this file's source when running from source (tsx, vitest). Once Next has bundled
 * the app, import.meta.url points at the build machine's checkout, so fall back to the working directory,
 * which is the deployment root on Vercel.
 */
function findRoot(): string {
  const fromSource = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return [fromSource, process.cwd()].find((dir) => existsSync(join(dir, "dataset"))) ?? fromSource;
}

/**
 * Where mutable state lives. state/ in the project, except on Vercel where the deployment is read-only and
 * only the temp directory is writable. That copy outlives requests on a warm instance but not a cold start,
 * and the ledger reseeds itself from the dataset when it is missing, so a cold start is a clean demo, never a crash.
 */
function defaultStateDir(): string {
  return process.env.VERCEL ? join(tmpdir(), "dispute-agent-state") : join(ROOT, "state");
}
const ANSWER_KEY_DIR = "qa";

const datasetDir = () => resolve(process.env.DATASET_DIR ?? join(ROOT, "dataset"));
const stateDir = () => resolve(process.env.STATE_DIR ?? defaultStateDir());
const promptsDir = () => resolve(process.env.PROMPTS_DIR ?? join(ROOT, "prompts"));
const fixturesDir = () => resolve(process.env.FIXTURES_DIR ?? join(ROOT, "fixtures"));

export function resolveDatasetPath(rel: string): string {
  const root = datasetDir();
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`refusing to read outside dataset/: ${rel}`);
  }
  const segments = full.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase() === ANSWER_KEY_DIR)) {
    throw new Error(`refusing to read the answer key: ${rel}`);
  }
  return full;
}

function readJson<T>(rel: string, schema: z.ZodType<T>): T {
  const parsed = JSON.parse(readFileSync(resolveDatasetPath(rel), "utf-8"));
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${rel} failed validation: ${result.error.message}`);
  }
  return result.data;
}

// ------------------------------------------------------------------ dataset
export const loadAgency = (): Agency => readJson("agency.json", AgencySchema);
export const loadBuyers = (): Buyer[] => readJson("buyers.json", z.array(BuyerSchema));
export const loadRateCards = (): RateCard[] => readJson("rate_cards.json", z.array(RateCardSchema));
export const loadInvoices = (): Invoice[] => readJson("invoices.json", z.array(InvoiceSchema));
export const loadDisputes = (): Dispute[] => readJson("disputes.json", z.array(DisputeSchema));

export const loadDemoDispute = (): string =>
  readFileSync(resolveDatasetPath("demo_dispute.txt"), "utf-8");

export function getBuyer(buyerId: string): Buyer {
  const buyer = loadBuyers().find((b) => b.id === buyerId);
  if (!buyer) throw new Error(`unknown buyer: ${buyerId}`);
  return buyer;
}

export function getInvoice(invoiceId: string): Invoice {
  const invoice = loadInvoices().find((i) => i.invoice_id === invoiceId);
  if (!invoice) throw new Error(`unknown invoice: ${invoiceId}`);
  return invoice;
}

/** A buyer by id (BUY-YOGITA) or by name (yogita, Yogita Precision...), case-insensitive. */
export function findBuyer(ref: string): Buyer {
  const q = ref.trim().toLowerCase();
  const matches = loadBuyers().filter(
    (b) => b.id.toLowerCase() === q || b.short_name.toLowerCase() === q || b.legal_name.toLowerCase().startsWith(q),
  );
  if (matches.length !== 1)
    throw new Error(`${matches.length ? "ambiguous" : "unknown"} buyer "${ref}"; use one of ${loadBuyers().map((b) => b.short_name.toLowerCase()).join(", ")}`);
  return matches[0]!;
}

/**
 * The invoice a dispute is most likely about when nobody says: the buyer's most
 * recent invoice that has actually gone out. A draft cannot be disputed, so drafts
 * are skipped unless the buyer has nothing else.
 */
export function latestInvoiceFor(buyerId: string): Invoice {
  const mine = loadInvoices().filter((i) => i.buyer_id === buyerId);
  if (!mine.length) throw new Error(`no invoices for ${buyerId}`);
  const sent = mine.filter((i) => i.status !== "draft");
  const pool = sent.length ? sent : mine;
  return [...pool].sort((a, b) => b.invoice_date.localeCompare(a.invoice_date) || b.invoice_id.localeCompare(a.invoice_id))[0]!;
}

/** Person-level detail behind an invoice, or null when none was produced. */
export function loadAnnexure(invoiceId: string): Annexure | null {
  const rel = `annexure_${invoiceId}.json`;
  if (!existsSync(resolveDatasetPath(rel))) return null;
  return readJson(rel, AnnexureSchema);
}

// ------------------------------------------------------------------- ledger
const ledgerPath = () => join(stateDir(), "rule_ledger.json");

/** The seed the live ledger is split with. LEDGER_SEED overrides the demo seed. */
export function ledgerSeed(): number {
  const raw = process.env.LEDGER_SEED;
  if (raw === undefined || raw === "") return DEMO_SEED;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`LEDGER_SEED must be an integer, got "${raw}"`);
  return n;
}

/** Every rule the buyers enforce, each with its hand-authored check attached. Never fed to a prompt whole. */
export function loadRulePool(): Rule[] {
  return readJson("rule_ledger.json", z.array(RuleSchema)).map((rule) => ({
    ...rule,
    check: rule.check ?? RULE_CHECKS[rule.rule_id] ?? {
      kind: "manual_review",
      note: "No machine-readable check was authored for this rule.",
    },
  }));
}

/** The pool split by seed: what goes into context, and what is held out for testing. */
export const loadSplit = (seed: number = ledgerSeed(), hold: string[] = []): LedgerSplit =>
  splitLedger(loadRulePool(), seed, hold);

/**
 * The rules the live ledger starts with. Every rule in the pool by default. LEDGER_RULES=12 starts from the
 * seeded split instead, holding the rest out so a dispute has something genuinely new to teach.
 */
export function startingRules(seed: number = ledgerSeed()): Rule[] {
  const raw = process.env.LEDGER_RULES;
  if (raw === undefined || raw === "") return loadRulePool();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`LEDGER_RULES must be a whole number, got "${raw}"`);
  return splitLedger(loadRulePool(), seed, [], Math.min(n, loadRulePool().length)).context;
}

/**
 * The live ledger. Created from the starting rules on first use, then mutated by the app, so learning
 * between runs is observable. The pool is never written.
 */
export function loadLedger(): Rule[] {
  if (!existsSync(ledgerPath())) saveLedger(startingRules());
  return z.array(RuleSchema).parse(JSON.parse(readFileSync(ledgerPath(), "utf-8")));
}

export function saveLedger(rules: Rule[]): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify(rules, null, 2) + "\n", "utf-8");
}

/** Back to the starting rules. Used between demo runs and by tests. */
export function resetLedger(seed: number = ledgerSeed()): Rule[] {
  const context = startingRules(seed);
  saveLedger(context);
  return context;
}

// ---------------------------------------------------------- app records
// The screens' own records (decisions, saved analyses) live under state/, one JSON file each.
const appPath = (rel: string) => {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(rel) || rel.includes("..")) throw new Error(`bad state path: ${rel}`);
  return join(stateDir(), ...rel.split("/"));
};

export function readStateJson<T>(rel: string, fallback: T): T {
  const path = appPath(rel);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeStateJson(rel: string, value: unknown): void {
  const path = appPath(rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export const removeState = (rel: string): void => rmSync(appPath(rel), { force: true, recursive: true });

// ---------------------------------------------------------------- outcomes
// Disputes resolved through the agent. Kept apart from dataset/ (which is
// regenerated) and merged in only where history matters: the last-5 few-shot slice.
const resolvedPath = () => join(stateDir(), "disputes_resolved.json");
const outcomesPath = () => join(stateDir(), "outcomes.json");

export interface OutcomeRecord {
  dispute_id: string;
  resolution: string;
  merchant_accepted: boolean;
  recorded_at: string;
}

export const loadResolvedDisputes = (): Dispute[] =>
  existsSync(resolvedPath()) ? z.array(DisputeSchema).parse(JSON.parse(readFileSync(resolvedPath(), "utf-8"))) : [];

/** Seed history plus everything resolved since. */
export const loadAllDisputes = (): Dispute[] => [...loadDisputes(), ...loadResolvedDisputes()];

export const loadOutcomes = (): OutcomeRecord[] =>
  existsSync(outcomesPath()) ? (JSON.parse(readFileSync(outcomesPath(), "utf-8")) as OutcomeRecord[]) : [];

/** record_outcome(): file the dispute as resolved and note whether the merchant accepted the proposal. */
export function recordOutcome(dispute: Dispute, merchantAccepted: boolean): void {
  mkdirSync(stateDir(), { recursive: true });
  const resolved = loadResolvedDisputes().filter((d) => d.dispute_id !== dispute.dispute_id);
  writeFileSync(resolvedPath(), JSON.stringify([...resolved, dispute], null, 2) + "\n", "utf-8");
  const outcomes = loadOutcomes().filter((o) => o.dispute_id !== dispute.dispute_id);
  const record: OutcomeRecord = {
    dispute_id: dispute.dispute_id, resolution: dispute.resolution,
    merchant_accepted: merchantAccepted, recorded_at: new Date().toISOString(),
  };
  writeFileSync(outcomesPath(), JSON.stringify([...outcomes, record], null, 2) + "\n", "utf-8");
}

// --------------------------------------------------------------- overrides
const overridesPath = () => join(stateDir(), "overrides.json");

export const loadOverrides = (): Override[] =>
  existsSync(overridesPath()) ? z.array(OverrideSchema).parse(JSON.parse(readFileSync(overridesPath(), "utf-8"))) : [];

export function saveOverrides(overrides: Override[]): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(overridesPath(), JSON.stringify(overrides, null, 2) + "\n", "utf-8");
}

/** Back to a clean demo: the split's ledger, no resolved disputes, no outcomes, no overrides. */
export function resetState(seed: number = ledgerSeed()): void {
  resetLedger(seed);
  for (const p of [resolvedPath(), outcomesPath(), overridesPath()]) rmSync(p, { force: true });
}

// ------------------------------------------------------------------ prompts
/** A versioned system prompt from prompts/, so changes diff when accuracy moves. */
export function loadPrompt(name: string): string {
  if (!/^[\w.-]+\.md$/.test(name)) throw new Error(`bad prompt name: ${name}`);
  return readFileSync(join(promptsDir(), name), "utf-8");
}

// ----------------------------------------------------------------- fixtures
// Recorded model responses, so a run can be replayed offline: free, repeatable,
// and immune to a busy API on demo day.
const fixturePath = (name: string) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad fixture name: ${name}`);
  return join(fixturesDir(), `${name}.json`);
};

export function readFixture(name: string): unknown | null {
  return existsSync(fixturePath(name)) ? JSON.parse(readFileSync(fixturePath(name), "utf-8")) : null;
}

export function writeFixture(name: string, value: unknown): void {
  mkdirSync(fixturesDir(), { recursive: true });
  writeFileSync(fixturePath(name), JSON.stringify(value, null, 2) + "\n", "utf-8");
}

// --------------------------------------------------------------------- runs
/** Per-run artefacts (e.g. the assembled context), kept for the "what the agent looked at" panel. */
export function writeRunArtifact(runId: string, name: string, value: unknown): string {
  if (!/^[\w.:-]+$/.test(runId) || !/^[\w.-]+$/.test(name)) throw new Error("bad run artefact name");
  const dir = join(stateDir(), "runs", runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", "utf-8");
  return path;
}

// ---------------------------------------------------------------------- env
/** Load .env.local into process.env without overriding anything already set. */
export function loadLocalEnv(): void {
  const path = join(ROOT, ".env.local");
  if (existsSync(path)) process.loadEnvFile(path);
}

// ------------------------------------------------------------------ messages
/** A buyer's message from a file the user points at. The answer key is refused here too. */
export function readMessageFile(path: string): string {
  const full = resolve(path);
  if (full.split(/[\\/]+/).some((seg) => seg.toLowerCase() === ANSWER_KEY_DIR)) {
    throw new Error(`refusing to read the answer key: ${path}`);
  }
  return readFileSync(full, "utf-8").replace(/\r\n?/g, "\n").trim();
}
