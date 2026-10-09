import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const c = (code: number) => (s: string | number) => `\x1b[${code}m${s}\x1b[0m`;
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const blue = c(34);
export const magenta = c(35);
export const cyan = c(36);

/** Pass --auto (or AUTO=1) to run straight through without pausing between steps. */
const AUTO = process.argv.includes("--auto") || process.env.AUTO === "1";

export function banner(title: string, subtitle?: string): void {
  const line = "─".repeat(Math.max(title.length, subtitle?.length ?? 0) + 4);
  console.log(`\n${cyan(line)}\n  ${bold(title)}${subtitle ? `\n  ${dim(subtitle)}` : ""}\n${cyan(line)}`);
}

export function step(n: number | string, text: string): void {
  const label = n === "" ? "▶" : `▶ Step ${n}`;
  console.log(`\n${magenta(label)}  ${bold(text)}`);
}

/** Echo the Redis command we are about to run, so the audience can read it. */
export function cmd(text: string): void {
  console.log(`  ${dim("redis>")} ${yellow(text)}`);
}

export function info(text: string): void {
  console.log(`  ${text}`);
}

export async function pause(prompt = "press ⏎ to continue"): Promise<void> {
  if (AUTO || !stdin.isTTY) return;
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question(dim(`  … ${prompt}`));
  rl.close();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function table(rows: Record<string, string | number>[]): void {
  console.table(rows);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
