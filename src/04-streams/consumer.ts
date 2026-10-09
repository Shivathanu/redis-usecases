/**
 * Consumer — one member of a consumer group.
 *
 *   npm run demo:streams:consumer -- --name alice
 *   npm run demo:streams:consumer -- --name bob --die-after 5     # crashes holding unacked work
 *   npm run demo:streams:consumer -- --name report --group analytics --from 0   # independent fan-out group
 *
 * Within a group, each message goes to exactly ONE consumer (load balancing).
 * Different groups each get EVERY message (fan-out), each with its own cursor.
 */
import { createClient } from "../lib/redis.js";
import { banner, cmd, info, dim, green, red, yellow, cyan, sleep } from "../lib/ui.js";
import { STREAM, DEFAULT_GROUP, arg, toObject, type StreamEntry } from "./config.js";

const name = arg("name", `consumer-${process.pid}`)!;
const group = arg("group", DEFAULT_GROUP)!;
const from = arg("from", "$")!; // "$" = only new messages, "0" = replay whole history
const dieAfter = Number(arg("die-after", "0"));
const workMs = Number(arg("work-ms", "300"));

const redis = createClient(`consumer:${name}`);
let running = true;
let processed = 0;

async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup("CREATE", STREAM, group, from, "MKSTREAM");
    info(green(`created group "${group}" starting at ${from}`));
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }
}

/** Pretend to do real work (charge card, reserve stock…). Poison messages always fail. */
async function handle(fields: Record<string, string>): Promise<void> {
  await sleep(workMs * (0.5 + Math.random()));
  if (fields.poison === "1") throw new Error(`cannot process ${fields.orderId}: malformed payload`);
}

async function processEntries(entries: StreamEntry[]): Promise<void> {
  for (const [id, raw] of entries) {
    const f = toObject(raw);
    if (dieAfter && processed >= dieAfter) {
      console.log(red(`\n  💥 ${name} crashed while holding ${id} (and any other unacked messages)`));
      console.log(dim("     they stay in the group's Pending Entries List until someone XAUTOCLAIMs them"));
      process.exit(1); // no XACK, no cleanup — simulates kill -9 / OOM / node failure
    }
    try {
      await handle(f);
      await redis.xack(STREAM, group, id); // ✅ only now is the message "done"
      processed++;
      console.log(`  ${dim(id)}  ${cyan(name)} ✔ ${f.orderId} ${f.customer} $${f.amount}`);
    } catch (err) {
      // No XACK → stays pending → will be retried by the reclaimer, then dead-lettered.
      console.log(`  ${dim(id)}  ${cyan(name)} ${red("✘")} ${yellow((err as Error).message)}`);
    }
  }
}

async function main(): Promise<void> {
  banner(`Streams · consumer "${name}"`, `group "${group}" on stream "${STREAM}"`);
  await ensureGroup();

  // 1) On start-up, first re-process anything already assigned to *me* that I never acked
  //    (e.g. I crashed and restarted with the same name). "0" = my pending list.
  const mine = (await redis.xreadgroup("GROUP", group, name, "COUNT", 100, "STREAMS", STREAM, "0")) as
    | [string, StreamEntry[]][]
    | null;
  if (mine?.[0]?.[1]?.length) {
    info(yellow(`recovering ${mine[0][1].length} message(s) I owned before restart`));
    await processEntries(mine[0][1]);
  }

  // 2) Then block for new messages. ">" = never-delivered-to-this-group-before.
  cmd(`XREADGROUP GROUP ${group} ${name} COUNT 5 BLOCK 5000 STREAMS ${STREAM} >`);
  while (running) {
    const res = (await redis.xreadgroup("GROUP", group, name, "COUNT", 5, "BLOCK", 5000, "STREAMS", STREAM, ">")) as
      | [string, StreamEntry[]][]
      | null;
    if (!res) continue; // timed out, loop again
    await processEntries(res[0][1]);
  }
  await redis.quit();
}

process.on("SIGINT", () => {
  running = false;
  console.log(dim(`\n  ${name} shutting down gracefully after ${processed} acks`));
  setTimeout(() => process.exit(0), 200);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
