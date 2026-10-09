# Redis, Beyond Caching — live demos

Small, self-contained TypeScript demos, Each one prints the Redis commands it runs, so the audience can follow along.

> **On stage:** [`docs/REDIS-COMMANDS.md`](docs/REDIS-COMMANDS.md) has every pattern as plain `redis-cli` commands with expected replies.

## Demos

| Folder | Use case | What it shows | Command |
|--------|----------|---------------|---------|
| `src/01-cache-aside` | 1 · Cache-aside | miss → load → write back with TTL; 200-request stampede: 200 DB queries naive vs 1 with a Lua `SET NX PX` lock; invalidate on write | `npm run demo:cache` |
| `src/01-flash-sale` | 1 · Eviction (flash sale) | one Redis with product cache, sessions and carts runs out of memory: `allkeys-lru` empties carts, `noeviction` fails new orders, `volatile-lru` + TTLs on cache keys evicts only product pages | `npm run demo:flashsale` |
| `src/01-eviction` | 1 · Eviction benchmark | 5 `maxmemory-policy` values, same Zipf workload: hit rate, after a cold scan, after a trend shift | `npm run demo:eviction` |
| `src/02-rate-limit` | 2 · Rate limiting | per-IP fixed window (INCR + PEXPIRE in Lua), 429 → 403 block, fixed vs sliding window at the boundary | `npm run demo:ratelimit` |
| `src/03-lock` | 3 · Distributed lock | flash sale: 50 buyers, 10 items; oversell without a lock, exact with one; expiry trap + fencing token | `npm run demo:lock` |
| `src/04-broadcast` | 4 · Broadcasting | Pub/Sub misses offline clients, a Stream lets them catch up | `npm run demo:broadcast` |
| `src/04-streams` | 4 · Consumer groups | work split across consumers, crash + `XAUTOCLAIM` recovery, retries, dead-letter queue, fan-out | see runbook below |

Shared helpers (Redis client, Lua scripts, terminal UI) live in `src/lib/`.

## Setup (once)

Requirements: Docker Desktop, Node.js 20+.

```bash
npm install
npm run up                # Redis 8.2 on :6379 + RedisInsight on http://localhost:5540
```

RedisInsight runs in its own container and is pre-configured with a **redis-beyond-caching** database
(host `redis`, port `6379`). If you add one by hand, use host `redis`, not `localhost`: inside the
RedisInsight container `localhost` is the container itself.

Every demo pauses between steps — press ⏎ to advance. Add `-- --auto` to run straight through.

## Demo runbook

### 1 · Cache-aside (`npm run demo:cache`)
Read path (miss, then hit), then a stampede of 200 concurrent requests for a cold hot key:
naive hits the database 200 times, single-flight (lock winner loads, the rest poll the cache) hits it once.
Finishes with the write path: update the database, then `DEL` the cache key.

### 1 · Flash sale eviction (`npm run demo:flashsale`)
Same sale under three `maxmemory-policy` settings; look at who survives (product pages, sessions, carts).
Temporarily changes `maxmemory` / `maxmemory-policy` and flushes **DB 4 only**; settings are restored at the end.

### 1 · Eviction benchmark (`npm run demo:eviction`)
Temporarily changes `maxmemory` / `maxmemory-policy` and flushes **DB 3 only**; restores settings at the end.
Expect: LFU wins steady state and shrugs off the scan; LRU and random degrade on the scan; volatile-ttl is worst
because TTL ≠ popularity; noeviction looks fine until the trend shifts, then collapses (writes fail with OOM).

### 2 · Rate limiting (`npm run demo:ratelimit`)
25 requests from one IP against a 10-per-10-s limit (200 → 429 → 403 block for 60 s), then a burst that
straddles a window boundary: fixed window lets 10 through, the sliding-window log lets 5.

### 3 · Distributed lock (`npm run demo:lock`)
50 buyers, 10 consoles. Without a lock the stock is oversold; with `SET NX PX` + token + compare-and-delete
it is exactly 10. Step 3 shows the expiry trap and why a fencing token matters.

### 4 · Broadcasting (`npm run demo:broadcast`)
Pub/Sub: a late subscriber misses everything. Stream: the late client reads from its last seen ID.
The script pauses before cleanup so you can open the `events:prices` stream in RedisInsight.

### 4 · Streams + consumer groups (~8 min) — use 4 terminals
```bash
npm run demo:streams:reset                                   # clean slate
npm run demo:streams:monitor                                 # T1: live XINFO dashboard
npm run demo:streams:consumer -- --name alice                # T2
npm run demo:streams:consumer -- --name bob --die-after 5    # T3: will "crash" holding a message
npm run demo:streams:producer -- --rate 3                    # T4
```
1. Watch alice and bob split the work (each message goes to exactly one consumer in a group).
2. bob crashes → monitor shows his pending count stuck and idle time climbing.
3. Every 25th order is poison and fails → stays pending.
4. Stop the producer and run the reclaimer:
   ```bash
   npm run demo:streams:reclaim -- --watch
   ```
   bob's message is recovered; poison messages retry until 3 deliveries, then land in `orders:dlq`.
5. Fan-out: a second group replays the whole history independently:
   ```bash
   npm run demo:streams:consumer -- --name report --group analytics --from 0
   ```
6. Restart bob with the same name (`--name bob`, no `--die-after`) — he first re-reads his own pending list (`XREADGROUP … 0`).

Options: consumer `--name --group --from --die-after --work-ms`; producer `--rate --count`.

## Teardown
```bash
npm run down      # stops containers and deletes the volume
```

## Project layout
```
src/
  lib/             shared client, Lua scripts, terminal helpers
  01-cache-aside/  cache-aside + stampede protection
  01-flash-sale/   eviction policies on a mixed keyspace (DB 4)
  01-eviction/     maxmemory-policy benchmark (DB 3)
  02-rate-limit/   fixed window + block, sliding window
  03-lock/         distributed lock, expiry trap, fencing
  04-broadcast/    Pub/Sub vs Streams
  04-streams/      producer, consumer, reclaimer (XAUTOCLAIM + DLQ), monitor, reset
docs/
  REDIS-COMMANDS.md  on-stage redis-cli cheat sheet
```

Pointing at another server: `REDIS_URL=redis://host:6379 npm run demo:cache`. Don't run the eviction demos against anything shared.
