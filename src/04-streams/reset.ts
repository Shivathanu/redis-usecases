/** Delete the demo streams (and their consumer groups) to start fresh. */
import { createClient } from "../lib/redis.js";
import { STREAM, DLQ } from "./config.js";

const redis = createClient("reset");
await redis.del(STREAM, DLQ);
console.log(`deleted ${STREAM} and ${DLQ}`);
await redis.quit();
