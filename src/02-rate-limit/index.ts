/**
 * Demo · Rate limiting by client IP.
 *
 *  1. Fixed window: INCR + PEXPIRE in one Lua call. 10 requests / 10 s per IP.
 *     An abusive IP that blows through 2× the limit gets blocked for 60 s (SET block:<ip> EX 60).
 *  2. Precision: a fixed window lets a burst straddle the boundary (2× the limit in ~0.3 s).
 *     A sliding-window log in a sorted set does not.
 */
import { createClient } from "../lib/redis.js";
import { FIXED_WINDOW, SLIDING_WINDOW } from "../lib/scripts.js";
import { banner, step, cmd, info, pause, bold, green, red, yellow, dim, sleep } from "../lib/ui.js";

const redis = createClient("rate-limit");
const IP = "203.0.113.7";

type Verdict = { allowed: boolean; status: 200 | 429 | 403; detail: string };

/** Fixed window + temporary block for clients that keep hammering after a 429. */
async function fixedWindow(ip: string, limit: number, windowMs: number): Promise<Verdict> {
  if (await redis.exists(`block:${ip}`)) return { allowed: false, status: 403, detail: "blocked" };
  const bucket = Math.floor(Date.now() / windowMs);
  const [count] = (await redis.eval(FIXED_WINDOW, 1, `rl:fixed:${ip}:${bucket}`, windowMs)) as [number, number];
  const retryMs = windowMs - (Date.now() % windowMs); // until this window's bucket ends
  if (count <= limit) return { allowed: true, status: 200, detail: `${count}/${limit}` };
  if (count >= limit * 2) {
    await redis.set(`block:${ip}`, "abuse", "EX", 60);
    return { allowed: false, status: 403, detail: "now blocked for 60 s" };
  }
  return { allowed: false, status: 429, detail: `Retry-After ${Math.ceil(retryMs / 1000)} s` };
}

let seq = 0;
async function slidingWindow(ip: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const [ok] = (await redis.eval(SLIDING_WINDOW, 1, `rl:sliding:${ip}`, now, windowMs, limit, `${now}-${seq++}`)) as [
    number,
    number,
  ];
  return ok === 1;
}

async function main(): Promise<void> {
  banner("Use case 2 · Rate limiting", "per-IP quotas with INCR + TTL, and Lua for precision");
  await redis.del(`block:${IP}`);

  step(1, `Burst of 25 requests from ${IP} (limit 10 per 10 s)`);
  cmd(`EVAL "INCR rl:fixed:${IP}:<window>; PEXPIRE on first hit" 1 …`);
  const line: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const v = await fixedWindow(IP, 10, 10_000);
    const tag = v.status === 200 ? green("200") : v.status === 429 ? yellow("429") : red("403");
    line.push(tag);
    if (i === 10 || i === 19 || i === 20 || i === 25) {
      info(`req ${String(i).padStart(2)}  ${line.join(" ")}  ${dim(v.detail)}`);
      line.length = 0;
    }
  }
  info(`${bold("block:" + IP)} TTL ${await redis.ttl(`block:${IP}`)} s  ${dim("→ a WAF or API gateway can read the same key")}`);
  await redis.del(`block:${IP}`);
  await pause();

  step(2, "Precision: a burst that straddles the window boundary (limit 5 per 2 s)");
  const W = 2_000;
  await redis.del(`rl:sliding:${IP}`);
  // wait until 150 ms before a fixed-window boundary
  const toBoundary = W - (Date.now() % W);
  await sleep(toBoundary > 150 ? toBoundary - 150 : toBoundary + W - 150);
  let fixedOk = 0;
  let slidingOk = 0;
  const run = async () => {
    for (let i = 0; i < 5; i++) {
      if ((await fixedWindow(`${IP}-b`, 5, W)).allowed) fixedOk++;
      if (await slidingWindow(IP, 5, W)) slidingOk++;
    }
  };
  await run(); // 5 requests just before the boundary
  await sleep(300); // …cross it…
  await run(); // 5 more just after
  cmd(`ZREMRANGEBYSCORE · ZCARD · ZADD rl:sliding:${IP}   (one Lua script)`);
  info(`10 requests in ~0.3 s:  fixed window allowed ${bold(red(String(fixedOk)))}   sliding window allowed ${bold(green(String(slidingOk)))}`);
  info(dim("Fixed window: 1 key, O(1), can let 2× through at the edge. Sliding log: exact, costs one sorted-set entry per request."));
  await redis.del(`rl:sliding:${IP}`);
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
