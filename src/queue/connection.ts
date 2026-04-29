/**
 * Lazy ioredis connection used by both the producer (queue) and consumer
 * (worker). BullMQ requires `maxRetriesPerRequest: null` on the connection it
 * shares with workers; producers can use the same connection without issue.
 */

import { Redis } from "ioredis";

export function makeRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export type { Redis };
