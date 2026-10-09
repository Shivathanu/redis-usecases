/**
 * Demo · Flash sale: what does Redis evict when memory is full?
 *
 * One Redis holds three kinds of keys for an online shop:
 *   product:*  cached product pages   TTL 5 min   lose it → reload from the DB, nobody notices
 *   session:*  logged-in users        no TTL      lose it → user is logged out
 *   cart:*     shopping carts         no TTL      lose it → the cart is empty, the sale is lost
 *
 * The sale starts, product traffic floods the cache and memory fills up.
 * We run the same sale under three maxmemory-policy settings and look at who survived.
 *
 * NOTE: changes maxmemory / maxmemory-policy and FLUSHes DB 4 only; settings are restored at the end.
 */
import { createClient } from "../lib/redis.js";
import { banner, step, cmd, info, pause, bold, green, red, yellow, dim, fmtNum, table } from "../lib/ui.js";

const DB = 4;
const USERS = 300;
const PRODUCTS = 4_000;
const PRODUCT_PAGE = "p".repeat(2_000); // ~2 KB of rendered product JSON
const BUDGET_MB = 3; // much less than the ~8 MB the sale wants to cache

const redis = createClient("flash-sale");
const NAMES = ["ana", "ben", "chen", "devi", "eli", "farah", "goro", "hana", "ivan", "jia"];
const userName = (u: number) => (u < NAMES.length ? NAMES[u] : `${NAMES[u % NAMES.length]}${u}`);

type Result = {
  policy: string;
  products: number;
  sessions: number;
  carts: number;
  lostCustomer: string;
  checkout: string;
  oom: number;
};

async function count(pattern: string): Promise<number> {
  let cursor = "0";
  let n = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    cursor = next;
    n += keys.length;
  } while (cursor !== "0");
  return n;
}

async function runSale(policy: string): Promise<Result> {
  await redis.flushdb();
  await redis.config("SET", "maxmemory", "0");
  const used = Number((await redis.info("memory")).match(/used_memory:(\d+)/)![1]);
  await redis.config("SET", "maxmemory", String(used + BUDGET_MB * 1024 * 1024));
  await redis.config("SET", "maxmemory-policy", policy);

  // Before the sale: people log in and fill their carts. No TTLs — this is real state.
  const before = redis.pipeline();
  for (let u = 0; u < USERS; u++) {
    const name = userName(u);
    before.hset(`session:${name}`, { userId: name, loggedInAt: Date.now() });
    before.hset(`cart:${name}`, { "sku:ps5": 1, "sku:controller": 2, "sku:headset": 1 });
  }
  await before.exec();

  // The sale: product pages get cached (with a TTL) as fast as traffic arrives.
  let oom = 0;
  for (let i = 0; i < PRODUCTS; i += 200) {
    const p = redis.pipeline();
    for (let j = i; j < i + 200; j++) p.set(`product:${j}`, PRODUCT_PAGE, "EX", 300);
    const out = (await p.exec()) ?? [];
    oom += out.filter(([err]) => err && String(err.message).startsWith("OOM")).length;
  }

  // Mid-sale, a customer places an order (order record ≈ 2 KB with line items and address).
  let checkout: string;
  try {
    await redis.hset("order:late-buyer", { items: "sku:ps5", details: PRODUCT_PAGE });
    checkout = green("OK");
  } catch (err) {
    checkout = red(String((err as Error).message).startsWith("OOM") ? "FAILS (OOM)" : "FAILS");
  }

  // Find a real customer whose cart disappeared, to name on screen.
  let lostCustomer = "";
  for (let u = 0; u < USERS && !lostCustomer; u++) {
    const name = userName(u);
    if (!(await redis.exists(`cart:${name}`))) lostCustomer = name;
  }
  return {
    policy,
    products: await count("product:*"),
    sessions: await count("session:*"),
    carts: await count("cart:*"),
    lostCustomer,
    checkout,
    oom,
  };
}

function show(r: Result): void {
  const pct = (n: number) => (n === USERS ? green(`${n}/${USERS}`) : red(`${n}/${USERS}`));
  info(`products cached ${bold(fmtNum(r.products))}   sessions ${pct(r.sessions)}   carts ${pct(r.carts)}`);
  const cart = r.lostCustomer ? red(`cart:${r.lostCustomer} → GONE`) : green("every cart intact");
  info(`${bold(cart)}   new order mid-sale: ${r.checkout}` +
    (r.oom ? `   ${red(`${fmtNum(r.oom)} product writes rejected (OOM)`)}` : ""));
}

async function main(): Promise<void> {
  banner("Demo · Flash sale", "one Redis, three kinds of keys, memory runs out — who gets evicted?");
  const [, origMax] = (await redis.config("GET", "maxmemory")) as string[];
  const [, origPolicy] = (await redis.config("GET", "maxmemory-policy")) as string[];
  await redis.select(DB);

  info(dim(`${USERS} users with a session + cart (no TTL), then the sale caches ${fmtNum(PRODUCTS)} product pages (TTL 300 s)`));
  info(dim(`memory budget ≈ ${BUDGET_MB} MB; the sale wants ~${Math.round((PRODUCTS * 2) / 1024)} MB`));

  const results: Result[] = [];
  try {
    step(1, "allkeys-lru: any key can go, oldest first");
    cmd("CONFIG SET maxmemory-policy allkeys-lru");
    results.push(await runSale("allkeys-lru"));
    show(results[0]);
    info(yellow("Carts and sessions were written before the sale, so they look 'oldest' and get thrown out."));
    await pause();

    step(2, "noeviction: never delete anything");
    cmd("CONFIG SET maxmemory-policy noeviction");
    results.push(await runSale("noeviction"));
    show(results[1]);
    info(yellow("Nothing is lost, but once memory is full every write fails, including new orders."));
    await pause();

    step(3, "volatile-lru + TTLs only on cache keys");
    cmd("CONFIG SET maxmemory-policy volatile-lru     # only keys WITH a TTL can be evicted");
    results.push(await runSale("volatile-lru"));
    show(results[2]);
    info(green("Only product pages were evicted. They reload from the database; customers never notice."));
  } finally {
    await redis.flushdb();
    await redis.config("SET", "maxmemory", origMax);
    await redis.config("SET", "maxmemory-policy", origPolicy);
  }

  step("✓", "Side by side");
  table(
    results.map((r) => ({
      policy: r.policy,
      "products cached": r.products,
      "sessions kept": `${r.sessions}/${USERS}`,
      "carts kept": `${r.carts}/${USERS}`,
      "rejected writes": r.oom,
    })),
  );
  info(dim("Even better: separate instances. GitLab runs allkeys-lru on its cache Redis and noeviction on the one with sessions and queues."));
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
