# MemCore

MemCore is a memory engine for AI agents — chunks, atomic memories, a typed graph, hybrid retrieval with temporal reasoning. Inspired by Supermemory and Mem0.

## What this is

A backend system that gives AI agents persistent memory across sessions. You feed it conversations and documents; it extracts atomic facts, stores them in a graph that handles updates and contradictions, and serves them back via a search API. Your agent queries this on every turn and gets relevant memories with full source context.

This is **not** a chat app, a vector database, or a RAG library. It is a memory engine that uses retrieval as one component.

## Documentation

Read these in order:

1. **[README.md](./README.md)** — you are here
2. **[AGENTS.md](./AGENTS.md)** — instructions for AI coding agents working in this repo
3. **[DESIGN.md](./DESIGN.md)** — the architectural reasoning
4. **[SPEC.md](./SPEC.md)** — schemas, APIs, configuration (authoritative reference)
5. **[ROADMAP.md](./ROADMAP.md)** — phased build plan
6. **[CONTRIBUTING.md](./CONTRIBUTING.md)** — contribution conventions

## Quickstart (local dev)

Prerequisites: Docker, Python 3.11+, `uv` or `pip`.

```bash
# 1. Clone and enter
git clone <repo>
cd MemCore

# 2. Set up environment
cp .env.example .env
# edit .env to add your ANTHROPIC_API_KEY (or OPENAI_API_KEY)

# 3. Start dependencies
docker-compose up -d  # Postgres + Redis

# 4. Install Python deps
uv sync  # or: pip install -e .[dev]

# 5. Run migrations
alembic upgrade head

# 6. Run the API
uvicorn src.api.main:app --reload

# 7. (separate terminal) Run the worker
rq worker --url redis://localhost:6379
```

Verify:

```bash
curl http://localhost:8000/v1/health
```

## Try it

Add some content:

```bash
curl -X POST http://localhost:8000/v1/add \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "container_tag": "test_user",
    "messages": [
      {"role": "user", "content": "Hi! I just moved to Brooklyn last week. The new place is bigger but the commute is brutal."},
      {"role": "assistant", "content": "Congrats on the move! How long is the commute now?"},
      {"role": "user", "content": "About 45 minutes each way. I might switch to the train."}
    ],
    "external_id": "test-session-1"
  }'
```

Wait for ingestion (a few seconds), then search:

```bash
curl -X POST http://localhost:8000/v1/search \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "container_tag": "test_user",
    "query": "where does the user live?"
  }'
```

You should see a memory like *"User moved to Brooklyn"* with the original conversation chunk attached.

## Running the eval suite

The eval suite is how we measure quality. Run it before and after any change to extraction, retrieval, or conflict detection.

```bash
python -m evals.runner --category all --output report.json
python -m evals.runner --category knowledge_update  # one category
```

Report includes per-category accuracy, latency, and cost.

## Project layout

See `SPEC.md` § Project Structure for the canonical layout. High-level:

```
src/
├── api/         # FastAPI routes
├── ingestion/   # Async pipeline: chunk → contextualize → extract → conflict → store
├── retrieval/   # Search: vector + keyword → RRF → rerank → graph-expand
├── llm/         # Provider-agnostic LLM client
├── prompts/     # Versioned prompt files
├── models/      # Pydantic + SQLAlchemy
└── db/          # Database access

evals/           # Quality measurement harness
migrations/      # Alembic
scripts/         # One-off operational scripts
```

## Status

**Phase 0 complete; Phase 1 next.** See [ROADMAP.md](./ROADMAP.md) for what's built, what's next, and where we are.

## License

MIT.
