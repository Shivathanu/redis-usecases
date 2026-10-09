/**
 * Demo · Broadcasting events: Pub/Sub vs Streams.
 *
 *  Live price alerts for a chat/notification feature.
 *   - Pub/Sub: instant fan-out to everyone connected. A client that connects late misses everything.
 *   - Stream:  same fan-out (XREAD), but the late client catches up from its last seen ID.
 */
import { createClient } from "../lib/redis.js";
import { banner, step, cmd, info, pause, green, red, dim, sleep } from "../lib/ui.js";

const CHANNEL = "notify:prices";
const STREAM = "events:prices";
const pub = createClient("publisher");

async function main(): Promise<void> {
  banner("Use case 4 · Broadcasting events", "Pub/Sub for live fan-out, Streams when nobody may miss a message");
  await pub.del(STREAM);
  const alerts = ["BTC +2%", "ETH -1%", "SOL +5%"];

  step(1, "Pub/Sub: ana is online, ben's phone reconnects a second later");
  const ana = createClient("ana");
  const anaGot: string[] = [];
  await ana.subscribe(CHANNEL);
  ana.on("message", (_c, m) => anaGot.push(m));
  cmd(`PUBLISH ${CHANNEL} "BTC +2%"   (×3)`);
  for (const a of alerts) await pub.publish(CHANNEL, a);
  await sleep(200);
  const ben = createClient("ben");
  const benGot: string[] = [];
  await ben.subscribe(CHANNEL);
  ben.on("message", (_c, m) => benGot.push(m));
  await sleep(300);
  info(`ana received ${green(anaGot.length)}: ${anaGot.join(", ")}`);
  info(`ben received ${red(benGot.length)}  ${dim("fire-and-forget: not connected = missed for good")}`);
  await ana.quit();
  await ben.quit();
  await pause();

  step(2, "Stream: same alerts, ben catches up from the last ID he saw");
  cmd(`XADD ${STREAM} MAXLEN ~ 10000 * alert "BTC +2%"   (×3)`);
  for (const a of alerts) await pub.xadd(STREAM, "MAXLEN", "~", 10_000, "*", "alert", a);
  cmd(`XREAD COUNT 100 STREAMS ${STREAM} 0     (ben's last seen ID; 0 = from the start)`);
  const res = (await pub.xread("COUNT", 100, "STREAMS", STREAM, "0")) as [string, [string, string[]][]][] | null;
  const caught = res?.[0][1].map(([, f]) => f[1]) ?? [];
  info(`ben caught up on ${green(caught.length)}: ${caught.join(", ")}`);
  info(dim("Each client keeps its own last ID, so every reader gets every event. Add consumer groups to split work instead."));

  await pause(`open RedisInsight (http://localhost:5540) → key ${STREAM}, then press ⏎ to clean up`);

  await pub.del(STREAM);
  await pub.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
