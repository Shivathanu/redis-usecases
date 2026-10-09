/**
 * Reclaimer — the "nobody gets left behind" loop.
 *
 *   npm run demo:streams:reclaim -- --watch
 *
 * Messages that were delivered but never XACKed sit in the group's
 * Pending Entries List (PEL). If one has been idle longer than MIN_IDLE_MS
 * its consumer is presumed dead:
 *   - delivered fewer than MAX_DELIVERIES times → XAUTOCLAIM it and retry
 *   - delivered MAX_DELIVERIES times or more   → copy to the DLQ stream and XACK it
 */
import { createClient } from "../lib/redis.js";
import { banner, cmd, info, dim, green, red, yellow, sleep } from "../lib/ui.js";
import { STREAM, DLQ, DEFAULT_GROUP, MAX_DELIVERIES, MIN_IDLE_MS, arg, toObject, type StreamEntry } from "./config.js";

const group = arg("group", DEFAULT_GROUP)!;
const watch = process.argv.includes("--watch");
const me = "reclaimer";
const redis = createClient(me);

type PendingRow = [id: string, consumer: string, idleMs: number, deliveries: number];

async function deadLetter(): Promise<number> {
  // XPENDING <stream> <group> IDLE <ms> - + <count>  → [id, owner, idle, deliveryCount]
  const rows = (await redis.xpending(STREAM, group, "IDLE", MIN_IDLE_MS, "-", "+", 100)) as PendingRow[];
  let moved = 0;
  for (const [id, owner, , deliveries] of rows) {
    if (deliveries < MAX_DELIVERIES) continue;
    const [entry] = (await redis.xrange(STREAM, id, id)) as StreamEntry[];
    const fields = entry ? entry[1] : ["missing", "1"]; // trimmed away by MAXLEN
    // MULTI so "copy to DLQ" and "remove from PEL" happen together
    await redis
      .multi()
      .xadd(DLQ, "*", ...fields, "originalId", id, "lastOwner", owner, "deliveries", String(deliveries))
      .xack(STREAM, group, id)
      .exec();
    moved++;
    info(`${red("☠ dead-lettered")} ${id} ${dim(`after ${deliveries} deliveries (last owner ${owner})`)}`);
  }
  return moved;
}

async function retryAbandoned(): Promise<number> {
  // XAUTOCLAIM <stream> <group> <consumer> <min-idle> <start> COUNT n
  //   → [nextCursor, claimedEntries, deletedIds]; claiming bumps the delivery counter.
  const [, entries] = (await redis.xautoclaim(STREAM, group, me, MIN_IDLE_MS, "0-0", "COUNT", 50)) as [
    string,
    StreamEntry[],
    string[],
  ];
  for (const [id, raw] of entries) {
    const f = toObject(raw);
    if (f.poison === "1") {
      info(`${yellow("↻ retry failed")} ${id} ${f.orderId} ${dim("(still poison — stays pending)")}`);
      continue;
    }
    await sleep(100); // do the work
    await redis.xack(STREAM, group, id);
    info(`${green("↻ recovered")}    ${id} ${f.orderId} ${dim("abandoned by a dead consumer, now done")}`);
  }
  return entries.length;
}

async function main(): Promise<void> {
  banner("Streams · reclaimer", `min idle ${MIN_IDLE_MS / 1000}s · max deliveries ${MAX_DELIVERIES} · DLQ "${DLQ}"`);
  cmd(`XPENDING ${STREAM} ${group} IDLE ${MIN_IDLE_MS} - + 100`);
  cmd(`XAUTOCLAIM ${STREAM} ${group} ${me} ${MIN_IDLE_MS} 0-0 COUNT 50`);
  do {
    const dl = await deadLetter();
    const rc = await retryAbandoned();
    if (!dl && !rc) process.stdout.write(dim("."));
    if (watch) await sleep(2_000);
  } while (watch);
  await redis.quit();
}

process.on("SIGINT", async () => {
  await redis.quit();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
