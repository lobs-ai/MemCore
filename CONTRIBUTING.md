# CONTRIBUTING.md

Conventions for contributing to **MemCore**. Whether you're a human or an AI coding agent, follow these.

## Before you start

1. Read `AGENTS.md`. Yes, even if you're a human. It contains the operational guidance.
2. Read the relevant sections of `DESIGN.md` and `SPEC.md` for the area you're touching.
3. Confirm your work falls within the current phase per `ROADMAP.md`.
4. If anything is ambiguous, ask before coding.

## Branches and commits

- Branch names: `phase-N/short-description` (e.g., `phase-2/extraction-prompt`) or `fix/short-description`.
- Commit messages: imperative mood, present tense. "Add semantic chunker", not "Added" or "Adds".
- Keep commits small and focused. One logical change per commit.
- The first line is ≤72 characters. Body is wrapped at 100.

## Pull requests

PR template:

```markdown
## What
<one paragraph>

## Why
<one paragraph; link to DESIGN.md or SPEC.md sections if relevant>

## How
<bullet list of approach>

## Eval impact
<required for changes to extraction, retrieval, conflict detection, or temporal>
- Before: <metrics>
- After: <metrics>
- Delta: <per-category>

## Cost / latency impact
<if applicable>

## Checklist
- [ ] Spec updated if behavior changed
- [ ] `db/schema.sql` updated if schema changed (and `pnpm db:reset` succeeds locally)
- [ ] Eval suite run if quality-affecting
- [ ] Tests added/updated
- [ ] Docs updated
```

PRs must pass CI: lint, type check, test, eval suite (for quality-affecting changes).

## Code style

### TypeScript

- TypeScript 5.7+, Node 20+, ESM modules.
- `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) is CI-enforced.
- `biome` for lint and format. CI enforced. Run `pnpm lint:fix` before committing.
- JSDoc on exported functions, classes, and modules. Explain *why*, not *what*.
- No `console.log`. Use the structured logger (`getLogger("component")`).
- Prefer composition over inheritance. Inheritance only for true is-a relationships.
- Async-first. If a function does I/O, it returns a `Promise`.
- No new top-level `dependencies` without justification in the PR. The fewer the better.

### Database

- Schema lives in **one place**: `db/schema.sql`. Edit that file directly.
- Apply locally with `pnpm db:reset` — destructive: drops every table.
- We do **not** run migrations during pre-production phases. Phase 8 introduces a migration tool against a frozen baseline. Until then, schema churn is expected and a migration history would be cargo-cult noise.
- Foreign keys must have `ON DELETE` behavior specified explicitly.
- Index decisions documented inline in `db/schema.sql`.

### Prompts

- Prompts live in `src/prompts/` as `.txt` files.
- Filename suffix encodes version: `extraction_v1.txt`, `extraction_v2.txt`.
- Prompts are read by version, never edited in place. Bumping the version is a deliberate act.
- The prompt version is stored on every memory it produces, so we can track what was extracted by what.
- Test prompt changes against the eval suite. Document deltas in the PR.

### LLM calls

- All LLM and embedding calls go through the `LLMClient` / `Embedder` interfaces in `src/llm/`. No provider SDKs in this package — adapters live in user code or sibling packages.
- Use the `TrackedLLMClient` / `TrackedEmbedder` wrappers so cost is recorded against the active `CostTracker`.
- Streaming is opt-in. Default is unary.
- Prompt caching is opt-in but encouraged for the contextualizer and any prompt that gets reused with stable prefixes.

### Tests

- Co-located with source: `chunker.ts` and `chunker.test.ts` in the same directory.
- Vitest (`pnpm test`).
- Unit tests inject a fake `Embedder` / `LLMClient` (the interfaces are designed for this). Integration tests hit a real cheap model.
- Every bug fix starts with a failing test that reproduces the bug.
- Quality-affecting changes must add eval cases, not just unit tests. Unit tests don't catch quality regressions.
- Coverage isn't measured strictly. Test the behavior, not the lines.

## Adding a new dependency

Justify it in the PR description. Specifically:

- What does this give us that's not already in the stack?
- What did we evaluate as alternatives?
- What's the maintenance burden (security, license, update cadence)?
- Why is it worth a new top-level dependency?

Default to "no." The fewer dependencies, the better.

## When you're stuck

In order:

1. Re-read `SPEC.md` for the area you're working in
2. Re-read `DESIGN.md` for the principle behind the design
3. Look at adjacent code for the existing pattern
4. Ask the user with a specific question and your two best guesses

## What gets a PR rejected

(Repeating from `AGENTS.md` for visibility.)

- Adding a new top-level dependency without justification
- LLM calls outside `src/llm/`
- Editing prompts in place without bumping the version
- Catch-and-rethrow exception handling
- Synchronous LLM calls in API request handlers
- Tests that mock the LLM with hardcoded responses without an integration test alongside
- Skipping the eval suite on quality-affecting changes
- Schema changes without updating `db/schema.sql`
- Magic numbers without a named constant
- TODO comments without an issue link

## Decision-making

For non-trivial decisions (architecture, dependencies, prompt strategy), record the decision in `ROADMAP.md` § Decision Log with date and reasoning. Future you, or a future maintainer, will thank you.
