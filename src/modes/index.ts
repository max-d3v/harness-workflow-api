import { codeReview } from "./code-review.ts";
import { codeTest } from "./qa.ts";
import { reviewExecutor } from "./review-executor.ts";

export type ModeHandler = (input: any, controller: AbortController) => Promise<unknown>;

export const MODES = {
  "code-review": codeReview,
  "code-test": codeTest,
  "review-executor": reviewExecutor,
} satisfies Record<string, ModeHandler>;

export type ModeName = keyof typeof MODES;
