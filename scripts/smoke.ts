import { MemCore } from "../src/index.js";

const memcore = new MemCore({
  databaseUrl: "postgresql://postgres:postgres@localhost:5433/memcore",
  embeddingDim: 64,
});

const addResult = await memcore.add({
  containerTag: "smoke",
  content: "The capital of France is Paris. Paris has the Eiffel Tower.",
  externalId: "smoke-1",
});
console.log("add:", addResult);

const search = await memcore.search({
  containerTag: "smoke",
  query: "What city is the Eiffel Tower in?",
  limit: 3,
});
console.log("search:", JSON.stringify(search, null, 2));

await memcore.close();
