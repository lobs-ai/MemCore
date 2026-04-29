# CLAUDE.md

This file is for Claude Code specifically. It mirrors `AGENTS.md` (which all coding agents should read) and adds Claude-specific guidance.

**Read `AGENTS.md` first.** It is the primary source of working instructions. This file supplements it.

## Claude-specific working norms

### Tool usage

- **Use `Bash` for read-only inspection liberally.** `ls`, `cat`, `grep`, `rg`, `git diff`, `git log` are all cheap. Don't ask permission to look around.
- **Use `Read` before `Edit`.** Always view a file before modifying it. The line numbers in `Read` output are display-only — never include them in `Edit` strings.
- **Prefer `Edit` over `Write` for existing files.** `Write` rewrites the whole file and loses git history granularity.
- **Run tests yourself before reporting completion.** Don't tell the user "this should work" — run the tests and tell them what happened.

### Planning

For non-trivial changes, write a brief plan before editing. The plan goes in your reply to the user, not as a file. Format:

```
Plan:
1. <step> — <reason>
2. <step> — <reason>
3. <step> — <reason>

I'll start with step 1.
```

For trivial changes (single-line fix, one-file refactor), skip the plan and just do it.

### Reading the docs

When starting any task, read the relevant docs in this order:

1. `AGENTS.md` — operational instructions (always)
2. `SPEC.md` — the section relevant to the change
3. `DESIGN.md` — only if you need to understand the *why*
4. `ROADMAP.md` — only if you're unsure whether the task is in scope

You don't have to re-read these every turn within a single session, but do re-read at the start of each new task.

### Commits and PRs

- Don't commit unless asked or unless you've finished a coherent unit of work and the user said "commit when ready."
- Never push to `main` or any protected branch directly.
- When the user asks you to commit, write the commit message yourself based on the diff. Don't ask them to write it.
- Use the PR template from `CONTRIBUTING.md`. Fill in all sections, including eval impact when relevant.

### What to ask the user before doing

(Mirroring `AGENTS.md` § "When to ask the user vs. proceed":)

**Do not ask before:**
- Reading any file
- Running any read-only command
- Running tests
- Adding code that follows an existing pattern
- Writing a clear, scoped change

**Ask before:**
- Schema changes
- New dependencies
- Cross-phase work (per `ROADMAP.md`)
- Spec/code disagreements
- Deletions or rewrites of >100 lines

### Working with prompts

The extraction, contextualization, and conflict detection prompts are critical components. Treat them like code:

- Read the current version before editing.
- Edits create a new version file (`extraction_v2.txt`), they don't modify the old one.
- Test prompt changes against the eval suite. Report the delta.
- A prompt change is a behavior change. PR description must explain what shifted.

### When you find a bug in the docs

Don't silently fix it. Flag it in your reply: "I noticed `SPEC.md` says X but the code does Y. Here's what I'd update — confirm?"

The docs are authoritative, but they can also be wrong. Distinguishing the two is the user's call.

## Repository tour for first contact

If you're working on this repo for the first time in a session, run these to get oriented:

```bash
# Where are we
ls -la
cat README.md
cat ROADMAP.md | head -50

# What's the current state
git status
git log --oneline -20

# What's the test situation
find . -name "*_test.py" -o -name "*.test.ts" | head -20
```

Then read the doc(s) relevant to the task. Then plan. Then code.

## Notes on style

- Be direct. No filler in code comments. No filler in PR descriptions. No "I'll go ahead and..."
- When you don't know, say so. Don't fabricate file paths, function signatures, or library APIs.
- When you're uncertain, propose two options instead of guessing.

## Specific reminders for memory-system work

This codebase has a few traps that LLMs (including you) tend to fall into. Watch for these:

1. **Conflating chunks and memories.** They are separate. Don't write code that treats them as the same thing.
2. **Per-turn ingestion.** Don't add it. Sessions are the unit. See `DESIGN.md` § 4.
3. **Generic edges.** Edges are typed. There is no "related" edge type — every edge is `updates`, `extends`, `derives`, or `contradicts`.
4. **Single-axis time.** Every memory has *two* timestamps. Don't store only one.
5. **Auto-summarization at query time.** No. Memories are extracted at ingestion time. Query time is for retrieval, not extraction.
6. **The agent calling save_memory autonomously.** No. The agent only calls it for explicit user requests. Extraction is a pipeline component, not an agent decision.

If you find yourself writing code that violates any of these, stop and re-read `DESIGN.md`.
