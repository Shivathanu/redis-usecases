/**
 * Demo 3 — The Eviction War.
 *
 * A cache that is smaller than the data set has to throw something away.
 * Which policy throws away the *right* things?
 *
 * We run the same cache-aside workload (Zipf-distributed key popularity — a few
 * keys are very hot, most are cold) against each maxmemory-policy, then hit the
 * cache with a one-off "batch job scan" of cold keys and see who survives it.
 * Finally the trend shifts (yesterday's hot items go cold, new ones get hot) —
 * which policy adapts?
 *
 * NOTE: this demo changes maxmemory / maxmemory-policy on the server and FLUSHes
 * DB 3. Original settings are restored at the end. Don't point it at production.
 */
import { createClient } from "../lib/redis.js";
import { banner, step, cmd, info, pause, bold, green, red, yellow, dim, fmtNum, table } from "../lib/ui.js";

const DB = 3;
const KEYSPACE = 100_000; // distinct items in the "database"
const VALUE = "v".repeat(1_000); // ~1 KB payload
const CACHE_MB = 10; // budget on top of current usage → room for roughly 8k items
const WARMUP_OPS = 40_000;
const MEASURE_OPS = 40_000;
const SCAN_KEYS = 15_000; // one-off batch job touching cold keys exactly once
const BATCH = 250;

const POLICIES = ["noeviction", "allkeys-random", "volatile-ttl", "allkeys-lru", "allkeys-lfu"] as const;

const redis = createClient("eviction");

/** Zipf(s=1.0) sampler via precomputed CDF + binary search. Deterministic seed. */
function zipfSampler(n: number, s: number, seed: number) {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += 1 / k ** s;
  let acc = 0;
  for (let k = 1; k <= n; k++) {
    acc += 1 / k ** s / sum;
    cdf[k - 1] = acc;
  }
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return () => {
    const u = rand();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

type Stats = { hits: number; misses: number; oom: number };

/** Cache-aside: GET → on miss "load from DB" and SET with a TTL. */
async function runOps(keys: number[], stats: Stats): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    const gets = redis.pipeline();
    chunk.forEach((k) => gets.get(`item:${k}`));
    const res = (await gets.exec()) ?? [];

    const sets = redis.pipeline();
    let pending = 0;
    res.forEach(([err, val], j) => {
      if (!err && val !== null) {
        stats.hits++;
        return;
      }
      stats.misses++;
      // random TTL (5–30 min) that has nothing to do with popularity — like real life
      const ttl = 300 + ((chunk[j] * 7919) % 1500);
      sets.set(`item:${chunk[j]}`, VALUE, "EX", ttl);
      pending++;
    });
    if (pending) {
      const out = (await sets.exec()) ?? [];
      stats.oom += out.filter(([err]) => err && String(err.message).startsWith("OOM")).length;
    }
  }
}

async function evictedKeys(): Promise<number> {
  const m = (await redis.info("stats")).match(/evicted_keys:(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function main(): Promise<void> {
  banner("Demo 3 · The Eviction War", "same workload, five maxmemory-policies, one cold-scan ambush");

  const [, origMax] = (await redis.config("GET", "maxmemory")) as string[];
  const [, origPolicy] = (await redis.config("GET", "maxmemory-policy")) as string[];
  await redis.select(DB);

  const next = zipfSampler(KEYSPACE, 1.0, 42);
  const warmup = Array.from({ length: WARMUP_OPS }, next);
  const measure = Array.from({ length: MEASURE_OPS }, next);
  const afterScan = Array.from({ length: MEASURE_OPS }, next);
  // trend shift: same popularity curve, but over a different set of items
  const shifted = Array.from({ length: MEASURE_OPS * 2 }, () => (next() + KEYSPACE / 2) % KEYSPACE);
  // cold keys nobody normally asks for (outside the hot head of the distribution)
  const scan = Array.from({ length: SCAN_KEYS }, (_, i) => KEYSPACE + i);

  info(dim(`keyspace ${fmtNum(KEYSPACE)} items · ~1 KB each · cache budget ≈ ${CACHE_MB} MB (~8% of data)`));
  info(dim("phases: warm-up → measure → batch job scans 15k cold keys once → measure → trend shift → measure"));
  await pause("press ⏎ to start the war");

  const results: Record<string, string | number>[] = [];
  const bars: { policy: string; before: number; after: number; shift: number }[] = [];

  try {
    for (const policy of POLICIES) {
      await redis.flushdb();
      await redis.config("SET", "maxmemory", "0");
      const used = Number((await redis.info("memory")).match(/used_memory:(\d+)/)![1]);
      await redis.config("SET", "maxmemory", String(used + CACHE_MB * 1024 * 1024));
      await redis.config("SET", "maxmemory-policy", policy);
      await redis.config("RESETSTAT");

      step("", policy);
      cmd(`CONFIG SET maxmemory-policy ${policy}`);

      const s0: Stats = { hits: 0, misses: 0, oom: 0 };
      await runOps(warmup, s0);

      const s1: Stats = { hits: 0, misses: 0, oom: 0 };
      await runOps(measure, s1);

      const sScan: Stats = { hits: 0, misses: 0, oom: 0 };
      await runOps(scan, sScan);

      const s2: Stats = { hits: 0, misses: 0, oom: 0 };
      await runOps(afterScan, s2);

      const s3: Stats = { hits: 0, misses: 0, oom: 0 };
      await runOps(shifted, s3);

      const hr = (s: Stats) => (s.hits / (s.hits + s.misses)) * 100;
      const oom = s0.oom + s1.oom + sScan.oom + s2.oom + s3.oom;
      const evicted = await evictedKeys();
      info(
        `hit rate ${bold(hr(s1).toFixed(1) + "%")} → after scan ${bold(hr(s2).toFixed(1) + "%")} → after shift ${bold(hr(s3).toFixed(1) + "%")}` +
          `   evicted ${fmtNum(evicted)}` +
          (oom ? `   ${red(`OOM errors ${fmtNum(oom)}`)}` : ""),
      );
      results.push({
        policy,
        "hit rate": `${hr(s1).toFixed(1)}%`,
        "after scan": `${hr(s2).toFixed(1)}%`,
        "after trend shift": `${hr(s3).toFixed(1)}%`,
        "evicted keys": fmtNum(evicted),
        "OOM write errors": fmtNum(oom),
      });
      bars.push({ policy, before: hr(s1), after: hr(s2), shift: hr(s3) });
    }
  } finally {
    await redis.flushdb();
    await redis.config("SET", "maxmemory", origMax);
    await redis.config("SET", "maxmemory-policy", origPolicy);
  }

  step("✓", "Results");
  table(results);
  const width = 40;
  for (const b of bars) {
    const bar = (v: number, paint: (s: string) => string) => paint("█".repeat(Math.round((v / 100) * width)).padEnd(width, " "));
    console.log(`  ${b.policy.padEnd(15)} ${bar(b.before, green)} ${b.before.toFixed(1)}%`);
    console.log(`  ${"".padEnd(15)} ${bar(b.after, yellow)} ${b.after.toFixed(1)}% ${dim("after scan")}`);
    console.log(`  ${"".padEnd(15)} ${bar(b.shift, red)} ${b.shift.toFixed(1)}% ${dim("after trend shift")}`);
  }
  console.log();
  info(dim("noeviction: writes fail with OOM once full — the cache freezes and can't follow a trend. Right for queues/streams/primary data."));
  info(dim("LRU (approximate, samples maxmemory-samples keys) is polluted by one-off scans; LFU remembers frequency."));
  info(dim("LFU's counters decay slowly (lfu-decay-time) — it can cling to yesterday's hot keys. No policy wins every war."));
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
