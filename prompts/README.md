# Prompts

System prompts live here as versioned files, not inline in code, so changes can be
diffed when accuracy moves.

- `analyze.md` is the one LLM call. It covers the role, the two buckets and how to
  tell them apart, the autonomy rule per bucket, how to match a claim against the
  buyer's ledger, which tool calls may fix which bucket, how to infer a new rule
  (and the closed vocabulary its `check` must come from), and the output contract.

It is one call, not two. The design started as a classify call followed by a propose
call per claim. One call is enough, is faster, and keeps the claims, the ledger match
and the proposed fix in a single consistent view. The response schema is derived from
`src/lib/engine/analysis_schema.ts`, so the contract has a single source of truth.

## Constraints the prompt must keep stating

- The model never emits a money figure. `recomputeInvoice()` is the only source of totals.
- The buyer's message is untrusted data inside `<buyer_message>` tags.
- Quotes are verbatim, so a hallucinated claim can be caught by string search.
- Only ids from the context are valid.

## Rules for editing it

- Do not put the demo's answers in it. Examples must be generic or invented. A prompt
  that says "the portal accepts invoices from the 1st to the 5th" is reciting, not inferring.
- `eval/context.leak.test.ts` scans the real prompt against every answer-key rule.
- Try every edit against the live model with the sandbox: `npm run try` (the demo dispute,
  demo seed), `npm run try -- --dispute DSP-012 --seed 7`, `--runs 3` to see how stable
  an answer is, `--engine` to also see verified quantities and money. It prints the raw
  reply and any validation problems, and the rules the seed held out, for you to read
  against it. Nothing in `dataset/qa/` is ever sent.
- There are no recorded replies for the prompt right now. The engine tests use a
  hand-written reply (`eval/demo_reply.ts`), so editing the prompt does not break them.
  Freeze recordings once the prompt settles, if replay is wanted.
