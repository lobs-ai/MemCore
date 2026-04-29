# CONTRIBUTING.md

Conventions for contributing to this codebase. Whether you're a human or an AI coding agent, follow these.

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
- [ ] Migrations added if schema changed
- [ ] Eval suite run if quality-affecting
- [ ] Tests added/updated
- [ ] Docs updated
```

PRs must pass CI: lint, type check, test, eval suite (for quality-affecting changes).

## Code style

### Python

- Python 3.11+. Use modern syntax (`list[int]`, not `List[int]`).
- Type hints on every function signature, validated by `mypy --strict`.
- `ruff` for lint and format. CI enforced.
- Docstrings on public functions, classes, and modules. Use Google style.
- No `print` statements. Use the structured logger.
- Prefer composition over inheritance. Inheritance only for true is-a relationships.
- Async-first. If a function does I/O, it's `async def`.

### Database

- All schema changes via Alembic migrations. Never edit the schema directly.
- Migrations must be reversible. Write the `downgrade` step.
- Test migrations against a copy of production-like data before merging.
- Index decisions documented in the migration's docstring.
- Foreign keys must have `ON DELETE` behavior specified explicitly.

### Prompts

- Prompts live in `src/prompts/` as `.txt` files.
- Filename suffix encodes version: `extraction_v1.txt`, `extraction_v2.txt`.
- Prompts are read by version, never edited in place. Bumping the version is a deliberate act.
- The prompt version is stored on every memory it produces, so we can track what was extracted by what.
- Test prompt changes against the eval suite. Document deltas in the PR.

### LLM calls

- All LLM calls go through `src/llm/client.py`. No direct SDK usage outside this module.
- The client wraps: retries with exponential backoff, structured logging, cost tracking, model selection.
- Streaming is opt-in. Default is unary.
- Prompt caching is opt-in but encouraged for the contextualizer and any prompt that gets reused with stable prefixes.

### Tests

- Co-located with source: `chunker.py` and `chunker_test.py` in the same directory.
- Pytest, async support via `pytest-asyncio`.
- Unit tests mock the LLM via `src/llm/client.py`'s test mode. Integration tests hit a real (cheap, deterministic) model.
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
- Schema changes without a migration
- Magic numbers without a named constant
- TODO comments without an issue link

## Decision-making

For non-trivial decisions (architecture, dependencies, prompt strategy), record the decision in `ROADMAP.md` § Decision Log with date and reasoning. Future you, or a future maintainer, will thank you.
