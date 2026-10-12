import { describe, expect, it } from "vitest";
import { loadDemoDispute } from "../src/lib/data/load";
import { analyzeDispute, MessageNotReady } from "../src/lib/engine/analyze";
import type { LlmProvider } from "../src/lib/llm/provider";
import { demoInput } from "./demo_reply";

/** HARNESS, NOT RUNTIME. The input guard in front of the model: refused text never reaches it. */
const demo = loadDemoDispute();

describe("the guard in front of the model", () => {
  const never: LlmProvider = {
    name: "never",
    generate: async () => {
      throw new Error("the model must not be called");
    },
  } as unknown as LlmProvider;

  const withMessage = (message: string) => ({ ...demoInput(), message });

  it("refuses an empty message without calling the model", async () => {
    await expect(analyzeDispute(withMessage("  "), never)).rejects.toBeInstanceOf(MessageNotReady);
  });

  it("does not hold back a message that looks cut off: the model is called", async () => {
    const half = demo.slice(0, demo.indexOf("3. The PO number")).trimEnd();
    await expect(analyzeDispute(withMessage(half), never)).rejects.toThrow("the model must not be called");
  });
});
