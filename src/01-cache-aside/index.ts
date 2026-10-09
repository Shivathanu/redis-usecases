/**
 * Demo · Cache-aside with stampede protection.
 *
 *  1. Read path: GET → miss → load from the "database" → SET with TTL (+ jitter)
 *  2. Stampede: 200 concurrent requests for a cold hot key
 *       naive         → every request hits the database
 *       single-flight → a Lua SET NX PX lock lets ONE request load; the rest wait for the cache
 *  3. Write path: update the database, then DEL the cache key (invalidate, don't update)
 */
import { randomBytes } from "node:crypto";
import { createClient } from "../lib/redis.js";
import { ACQUIRE_LOCK, RELEASE_LOCK } from "../lib/scripts.js";
import { banner, step, cmd, info, pause, bold, green, red, yellow, dim, fmtNum, sleep } from "../lib/ui.js";

const redis = createClient("cache-aside");
const TTL_S = 300;
const LOCK_TTL_MS = 2_000;
const DB_LATENCY_MS = 300;

// ── a pretend primary database ────────────────────────────────────────────────
const db = new Map([["p-001", { id: "p-001", name: "Sourdough Loaf", price_cents: "650", stock: "42" }]]);
let dbCalls = 0;
async function loadProduct(id: string): Promise<Record<string, string> | null> {
  dbCalls++;
  await sleep(DB_LATENCY_MS);
  return db.get(id) ?? null;
}

const cacheKey = (id: string) => `cache:product:${id}`;
const lockKey = (id: string) => `lock:product:${id}`;
/** ±10% TTL jitter so keys written together don't all expire together. */
const ttlWithJitter = () => Math.round(TTL_S * (0.9 + Math.random() * 0.2));

async function writeBack(id: string, record: Record<string, string>): Promise<void> {
  await redis.multi().del(cacheKey(id)).hset(cacheKey(id), record).expire(cacheKey(id), ttlWithJitter()).exec();
}

/** Plain cache-aside: no protection. */
async function getNaive(id: string): Promise<Record<string, string> | null> {
  const cached = await redis.hgetall(cacheKey(id));
  if (Object.keys(cached).length) return cached;
  const record = await loadProduct(id);
  if (record) await writeBack(id, record);
  return record;
}

/** Cache-aside + single-flight: only the lock winner talks to the database. */
async function getSingleFlight(id: string): Promise<Record<string, string> | null> {
  const cached = await redis.hgetall(cacheKey(id));
  if (Object.keys(cached).length) return cached;

  const token = randomBytes(8).toString("hex");
  const acquired = await redis.eval(ACQUIRE_LOCK, 1, lockKey(id), token, LOCK_TTL_MS);
  if (acquired === 1) {
    try {
      const record = await loadProduct(id);
      if (record) await writeBack(id, record);
      return record;
    } finally {
      await redis.eval(RELEASE_LOCK, 1, lockKey(id), token);
    }
  }
  // Someone else is loading it: poll the cache briefly instead of hammering the DB.
  const deadline = Date.now() + LOCK_TTL_MS;
  while (Date.now() < deadline) {
    await sleep(25);
    const v = await redis.hgetall(cacheKey(id));
    if (Object.keys(v).length) return v;
  }
  return loadProduct(id); // lock holder died: fall back
}

async function stampede(label: string, fn: (id: string) => Promise<unknown>): Promise<void> {
  await redis.del(cacheKey("p-001"), lockKey("p-001"));
  dbCalls = 0;
  const t = performance.now();
  await Promise.all(Array.from({ length: 200 }, () => fn("p-001")));
  const ms = performance.now() - t;
  const paint = dbCalls > 1 ? red : green;
  info(`${label.padEnd(16)} database queries: ${bold(paint(fmtNum(dbCalls)))}   ${dim(`(${ms.toFixed(0)} ms for 200 requests)`)}`);
}

async function main(): Promise<void> {
  banner("Use case 1 · Cache-aside", "read through Redis, protect the database from stampedes");
  await redis.del(cacheKey("p-001"), lockKey("p-001"));

  step(1, "Read path: miss, load, write back with TTL — then hit");
  cmd("HGETALL cache:product:p-001   →   (miss) load from DB   →   HSET … + EXPIRE 300±10%");
  for (const attempt of ["first read", "second read"]) {
    const t = performance.now();
    const before = dbCalls;
    await getNaive("p-001");
    const hit = dbCalls === before;
    info(`${attempt.padEnd(12)} ${hit ? green("HIT ") : yellow("MISS")} ${(performance.now() - t).toFixed(1).padStart(6)} ms`);
  }
  info(dim(`TTL now: ${await redis.ttl(cacheKey("p-001"))}s`));
  await pause();

  step(2, "Stampede: the hot key expires and 200 requests arrive at once");
  cmd(`EVAL "SET lock:product:p-001 <token> NX PX ${LOCK_TTL_MS}"   (only one caller wins)`);
  await stampede("naive", getNaive);
  await stampede("single-flight", getSingleFlight);
  info(dim("The loser requests wait ~300 ms for the winner's write instead of piling onto the database."));
  await pause();

  step(3, "Write path: update the database, then invalidate");
  db.set("p-001", { ...db.get("p-001")!, price_cents: "700" });
  cmd("DEL cache:product:p-001");
  await redis.del(cacheKey("p-001"));
  const fresh = await getSingleFlight("p-001");
  info(`next read repopulates: price_cents = ${green(fresh?.price_cents ?? "?")}`);
  info(dim("Delete on write. Don't try to update both; the next read rebuilds from the source of truth."));

  await redis.del(cacheKey("p-001"));
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
