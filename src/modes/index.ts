import { codeReview } from "./code-review.ts";
import { codeTest } from "./tester.ts";

export type ModeHandler = (input: any, controller: AbortController) => Promise<unknown>;

export const MODES = {
  "code-review": codeReview,
  "code-test": codeTest,
} satisfies Record<string, ModeHandler>;

export type ModeName = keyof typeof MODES;
