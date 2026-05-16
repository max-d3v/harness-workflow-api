import { codeReview } from "./code-review.js";
import { codeTest } from "./tester.js";

export const MODES = {
  "code-review": codeReview,
  "code-test": codeTest,
} as const;

export type ModeName = keyof typeof MODES;
