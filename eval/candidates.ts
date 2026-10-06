/**
 * The question sets the eval compares. `baseline` is the shipped set; every
 * other entry replaces some of its questions.
 */

import type { ClassifierQuestion } from "@earendil-works/pi-ai";

import { SYSTEM_ONE_QUESTIONS } from "../src/system-one-review";

export const CANDIDATES: Record<string, Record<string, ClassifierQuestion>> = {
  baseline: SYSTEM_ONE_QUESTIONS,
};
