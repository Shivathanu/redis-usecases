/**
 * Demo · Distributed lock for a flash sale.
 *
 *  10 consoles in stock, 50 buyers (think: 50 app instances) at once.
 *  The checkout does read stock → charge the card (slow, external) → write stock.
 *
 *  1. No lock: buyers interleave between the read and the write → oversold.
 *  2. SET lock NX PX + token, released with a compare-and-delete Lua script → exactly 10 orders.
 *  3. The expiry trap: a holder slower than the TTL loses the lock; the token stops it from
 *     deleting the next holder's lock. A fencing token (INCR) lets the database reject stale writers.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "../lib/redis.js";
import { ACQUIRE_LOCK, RELEASE_LOCK } from "../lib/scripts.js";
import { banner, step, cmd, info, pause, bold, green, red, yellow, dim, sleep } from "../lib/ui.js";

const redis = createClient("lock");
const STOCK = "inventory:ps5";
const ORDERS = "orders:ps5";
const LOCK = "lock:inventory:ps5";
const BUYERS = 50;

const chargeCard = () => sleep(20 + Math.random() * 30); // the external payment call

async function reset(): Promise<void> {
  await redis.del(STOCK, ORDERS, LOCK, "fence:inventory:ps5");
  await redis.set(STOCK, 10);
}

async function checkoutNoLock(buyer: number): Promise<void> {
  const stock = Number(await redis.get(STOCK));
  if (stock <= 0) return;
  await chargeCard();
  await redis.set(STOCK, stock - 1);
  await redis.rpush(ORDERS, `buyer-${buyer}`);
}

async function withLock<T>(ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const token = randomBytes(8).toString("hex");
  const giveUp = Date.now() + 3_000;
  while (Date.now() < giveUp) {
    if ((await redis.eval(ACQUIRE_LOCK, 1, LOCK, token, ttlMs)) === 1) {
      try {
        return await fn();
      } finally {
        await redis.eval(RELEASE_LOCK, 1, LOCK, token);
      }
    }
    await sleep(5 + Math.random() * 15); // back off with jitter
  }
  return null; // couldn't get the lock in time: fail the request, don't oversell
}

async function checkoutWithLock(buyer: number): Promise<void> {
  await withLock(2_000, async () => {
    const stock = Number(await redis.get(STOCK));
    if (stock <= 0) return;
    await chargeCard();
    await redis.set(STOCK, stock - 1);
    await redis.rpush(ORDERS, `buyer-${buyer}`);
  });
}

async function report(label: string): Promise<void> {
  const orders = await redis.llen(ORDERS);
  const stock = Number(await redis.get(STOCK));
  const ok = orders === 10;
  info(`${label.padEnd(10)} orders ${bold((ok ? green : red)(String(orders)))} for 10 consoles   stock left ${stock}` +
    (ok ? green("   ✓ correct") : red(`   ✗ oversold by ${orders - 10}`)));
}

async function main(): Promise<void> {
  banner("Use case 3 · Distributed lock", "SET NX PX + token: one writer at a time across every instance");

  step(1, `Flash sale without a lock: ${BUYERS} buyers, 10 consoles`);
  await reset();
  await Promise.all(Array.from({ length: BUYERS }, (_, i) => checkoutNoLock(i)));
  await report("no lock");
  await pause();

  step(2, "Same sale with a lock");
  cmd(`SET ${LOCK} <random-token> NX PX 2000      …work…      EVAL "if GET == token then DEL"`);
  await reset();
  await Promise.all(Array.from({ length: BUYERS }, (_, i) => checkoutWithLock(i)));
  await report("with lock");
  await pause();

  step(3, "The expiry trap: worker A is slower than its lock TTL");
  await reset();
  const tokenA = "A-" + randomBytes(4).toString("hex");
  const tokenB = "B-" + randomBytes(4).toString("hex");
  await redis.eval(ACQUIRE_LOCK, 1, LOCK, tokenA, 300);
  const fenceA = await redis.incr("fence:inventory:ps5");
  info(`A acquires (TTL 300 ms, fencing token ${fenceA}) and stalls in a GC pause…`);
  await sleep(400);
  const bGot = await redis.eval(ACQUIRE_LOCK, 1, LOCK, tokenB, 2_000);
  const fenceB = await redis.incr("fence:inventory:ps5");
  info(`${yellow("A's lock expired.")} B acquires: ${bGot === 1 ? green("yes") : red("no")} (fencing token ${fenceB})`);
  const aRelease = await redis.eval(RELEASE_LOCK, 1, LOCK, tokenA);
  info(`A wakes up and releases: deleted ${aRelease}  ${dim("← token mismatch, B's lock is safe")}`);
  info(`A then writes with fence ${fenceA}; a database that remembers max(fence) = ${fenceB} ${red("rejects the stale write")}.`);
  info(dim("Rule: TTL > worst-case critical section, always release by token, fence writes to the resource."));
  info(dim("For a plain counter you don't need a lock at all: a Lua 'if stock > 0 then DECR' is atomic. Lock when the critical section spans other systems."));

  await redis.del(STOCK, ORDERS, LOCK, "fence:inventory:ps5");
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
