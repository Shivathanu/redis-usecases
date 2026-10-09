import { Redis } from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** One place to build clients, so every demo points at the same server. */
export function createClient(name = "demo"): Redis {
  const client = new Redis(REDIS_URL, {
    connectionName: name,
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  client.on("error", (err) => {
    console.error(`[${name}] redis error: ${err.message}`);
  });
  return client;
}
