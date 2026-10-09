/**
 * Producer — appends order events to the stream.
 *
 *   npm run demo:streams:producer -- --rate 5
 *
 * Every 25th order is a "poison" message that consumers can never process,
 * so we can show retries and the dead-letter queue.
 */
import { createClient } from "../lib/redis.js";
import { banner, cmd, dim, green, red, sleep } from "../lib/ui.js";
import { STREAM, arg } from "./config.js";

const redis = createClient("producer");
const rate = Number(arg("rate", "5")); // events per second
const total = Number(arg("count", "0")); // 0 = forever

const CUSTOMERS = ["ana", "bao", "chen", "devi", "eli", "farah", "goro", "hana"];
const SKUS = ["keyboard", "monitor", "mouse", "headset", "webcam", "dock"];

async function main(): Promise<void> {
  banner("Streams · producer", `XADD ${STREAM} at ~${rate}/s`);
  cmd(`XADD ${STREAM} MAXLEN ~ 100000 * orderId … customer … sku … amount …`);
  let n = (await redis.xlen(STREAM)) + 1;
  for (let sent = 0; total === 0 || sent < total; sent++, n++) {
    const poison = n % 25 === 0;
    const fields = {
      orderId: `ord-${String(n).padStart(5, "0")}`,
      customer: CUSTOMERS[n % CUSTOMERS.length],
      sku: SKUS[(n * 7) % SKUS.length],
      amount: (10 + ((n * 37) % 490)).toFixed(2),
      ...(poison ? { poison: "1" } : {}),
    };
    // MAXLEN ~ caps memory: the stream is a log, not an infinite buffer. "*" = server-assigned ID.
    const id = await redis.xadd(STREAM, "MAXLEN", "~", 100_000, "*", ...Object.entries(fields).flat());
    console.log(
      `  ${dim(id ?? "")}  ${fields.orderId}  ${fields.customer.padEnd(6)} ${fields.sku.padEnd(9)} $${fields.amount.padStart(6)}` +
        (poison ? `  ${red("☠ poison")}` : `  ${green("+")}`),
    );
    await sleep(1000 / rate);
  }
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
