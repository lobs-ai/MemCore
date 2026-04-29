/**
 * Profile-relevance detector (Phase 6).
 *
 * Decides whether a search query is asking about the user themselves rather
 * than about a specific fact in their memory. Examples that are relevant:
 *
 *   - "what do you know about me?"
 *   - "tell me about myself"
 *   - "summarize me"
 *   - "describe the user"
 *   - "what's my profile?"
 *
 * Examples that are NOT profile-relevant:
 *
 *   - "what does the user prefer for breakfast?"  (one specific fact)
 *   - "where does the user live?"                 (one specific fact)
 *   - "what did I work on last summer?"           (temporal, scoped)
 *
 * The detector is intentionally a heuristic. The cost of an LLM call on every
 * search just to gate the profile injection isn't worth it — false positives
 * here are cheap (one extra row read) and false negatives are recoverable
 * (the regular memory search still runs and answers the question). Returning
 * a confidence score lets the caller demote borderline matches if needed.
 *
 * The patterns deliberately match on phrases, not isolated words. "Me" alone
 * is too common ("when did Maya finish her fellowship for me?") to be a
 * trigger; a profile-relevant query reliably contains a pattern like "about
 * me" or "summarize <pronoun>".
 */

const PATTERNS: { regex: RegExp; weight: number }[] = [
  // Direct asks for a profile / summary.
  { regex: /\bmy profile\b/i, weight: 1.0 },
  { regex: /\buser profile\b/i, weight: 1.0 },
  { regex: /\bprofile of (?:me|the user|this user)\b/i, weight: 1.0 },

  // "Tell/show/give me a summary of me / the user".
  {
    regex:
      /\b(?:tell|give|show|describe|paint|build|draft) (?:me )?(?:a |the )?(?:summary|picture|description|overview) (?:of|about) (?:me|myself|the user|this user)\b/i,
    weight: 0.95,
  },
  { regex: /\bsummari[sz]e (?:me|myself|the user|this user)\b/i, weight: 0.95 },
  { regex: /\bdescribe (?:me|myself|the user|this user)\b/i, weight: 0.9 },

  // "What do you know about me/the user".
  {
    regex:
      /\b(?:what|how much) (?:do you|have you) (?:know|learned|gathered) about (?:me|the user|this user|myself)\b/i,
    weight: 0.95,
  },
  { regex: /\b(?:tell|teach) me about (?:myself|me|the user)\b/i, weight: 0.9 },

  // "Who am I / who is the user".
  { regex: /\bwho (?:am i|is the user|is this user)\b/i, weight: 0.85 },

  // "Catch up on the user / refresh me on who I am".
  {
    regex: /\b(?:catch (?:me )?up|refresh) (?:on |about )?(?:me|the user|myself)\b/i,
    weight: 0.8,
  },

  // "Everything about the user".
  {
    regex: /\b(?:everything|anything) (?:you know )?about (?:me|the user|this user|myself)\b/i,
    weight: 0.85,
  },
];

export interface RelevanceMatch {
  isRelevant: boolean;
  /** 0..1 — highest pattern weight that fired. 0 when none fired. */
  confidence: number;
  /** The phrases that fired, useful for logging. */
  matched: string[];
}

const DEFAULT_THRESHOLD = 0.75;

export function isProfileRelevant(query: string, threshold = DEFAULT_THRESHOLD): RelevanceMatch {
  if (!query || !query.trim()) return { isRelevant: false, confidence: 0, matched: [] };
  let best = 0;
  const matched: string[] = [];
  for (const { regex, weight } of PATTERNS) {
    const m = query.match(regex);
    if (m) {
      matched.push(m[0]);
      if (weight > best) best = weight;
    }
  }
  return { isRelevant: best >= threshold, confidence: best, matched };
}
