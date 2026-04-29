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
  /**
   * Single-session setup. Ingested as one conversation (one `add` call). Use
   * this for single_session_recall, knowledge_update, and any case where the
   * relevant facts can fit in one conversation.
   */
  setup?: SetupMessage[];
  /**
   * Multi-session setup. Each entry is ingested as a separate conversation
   * with its own `external_id`. Used for multi_session cases where the answer
   * requires combining facts that arrived in different sessions, and for
   * knowledge_update cases where we want the conflict detector to see the
   * prior fact already committed before the updating fact arrives.
   */
  setup_sessions?: SetupMessage[][];
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
