/**
 * Eval case + scoring types. JSONL files in `evals/cases/` parse into `EvalCase`.
 */

export interface SetupMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export type Category =
  | "single_session_recall"
  | "knowledge_update"
  | "temporal_reasoning"
  | "multi_session"
  | "abstain";

export type ScoringMode = "contains" | "exact";

export interface EvalCase {
  case_id: string;
  category: Category;
  setup: SetupMessage[];
  question: string;
  expected_answer: string;
  scoring: ScoringMode;
}

export interface EvalResult {
  case_id: string;
  category: Category;
  passed: boolean;
  retrievedTopK: { content: string; score: number }[];
  latencyMs: number;
  notes?: string;
}
