/**
 * Monitor — a live view of the stream, its groups and consumers.
 *
 *   npm run demo:streams:monitor
 */
import { createClient } from "../lib/redis.js";
import { bold, cyan, dim, green, red, yellow, sleep } from "../lib/ui.js";
import { STREAM, DLQ, toObject } from "./config.js";

const redis = createClient("monitor");

/** XINFO replies are flat [k, v, k, v] arrays (sometimes nested). */
const kv = (arr: unknown[]): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < arr.length; i += 2) o[String(arr[i])] = arr[i + 1];
  return o;
};

async function render(): Promise<string> {
  const lines: string[] = [];
  const len = await redis.xlen(STREAM);
  const dlqLen = await redis.xlen(DLQ);
  lines.push(bold(`Stream "${STREAM}"`) + `   length ${bold(len)}   ${dim("(XLEN)")}`);

  let groups: Record<string, unknown>[] = [];
  try {
    groups = ((await redis.xinfo("GROUPS", STREAM)) as unknown[][]).map(kv);
  } catch {
    lines.push(dim("  stream does not exist yet — start a producer or consumer"));
  }

  for (const g of groups) {
    const lag = g["lag"] ?? "?";
    lines.push("");
    lines.push(
      `${cyan("group")} ${bold(String(g["name"]))}   last-delivered ${dim(String(g["last-delivered-id"]))}` +
        `   pending ${Number(g["pending"]) ? yellow(String(g["pending"])) : green("0")}   lag ${Number(lag) ? yellow(String(lag)) : green(String(lag))}`,
    );
    const consumers = ((await redis.xinfo("CONSUMERS", STREAM, String(g["name"]))) as unknown[][]).map(kv);
    for (const c of consumers) {
      const idle = Number(c["idle"]);
      const pending = Number(c["pending"]);
      const status = idle > 10_000 ? red("● silent") : green("● active");
      lines.push(
        `   ${status} ${String(c["name"]).padEnd(12)} pending ${String(pending).padStart(3)}   idle ${(idle / 1000).toFixed(1).padStart(6)}s`,
      );
    }
  }

  lines.push("");
  lines.push(bold(`Dead-letter "${DLQ}"`) + `   length ${dlqLen ? red(dlqLen) : green(0)}`);
  if (dlqLen) {
    const last = (await redis.xrevrange(DLQ, "+", "-", "COUNT", 3)) as [string, string[]][];
    for (const [, f] of last) {
      const o = toObject(f);
      lines.push(dim(`   ${o.orderId} (orig ${o.originalId}, ${o.deliveries} deliveries, last owner ${o.lastOwner})`));
    }
  }
  lines.push("");
  lines.push(dim(`XINFO GROUPS ${STREAM} · XINFO CONSUMERS ${STREAM} <group> · refreshed ${new Date().toLocaleTimeString()}`));
  return lines.join("\n");
}

async function main(): Promise<void> {
  for (;;) {
    const frame = await render();
    process.stdout.write("\x1b[2J\x1b[H" + frame + "\n");
    await sleep(1_000);
  }
}

process.on("SIGINT", async () => {
  await redis.quit();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
