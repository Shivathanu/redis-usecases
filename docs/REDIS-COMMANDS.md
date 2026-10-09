# Redis plain commands: on-stage cheat sheet

The same patterns the TypeScript demos use, as raw commands you can type or paste during the talk.
One section per use case, in talk order. `# →` shows what Redis replies.

## Open a session

```bash
docker exec -it redis-beyond-caching redis-cli
```

Paste the commands into this **interactive** prompt. That matters for the vector section: the interactive
prompt turns `"\x00\x00\x80\x3f"` into raw bytes, but `redis-cli CMD …` run from your shell does not.

Handy while presenting: `MONITOR` in a second terminal shows every command the TypeScript demos send.

---

## 1 · Caching: cache-aside + stampede lock

Demo: `npm run demo:cache`

**Read path: miss → load → write back with a TTL**

```redis
HGETALL cache:product:p-001
# → (empty array)  = MISS, so the app loads from the database

HSET cache:product:p-001 id p-001 name "Sourdough Loaf" price_cents 650 stock 42
# → (integer) 4
EXPIRE cache:product:p-001 300
# → (integer) 1      (the app adds ±10% jitter: 270–330)

HGETALL cache:product:p-001
# → 1) "id" 2) "p-001" ...  = HIT
TTL cache:product:p-001
# → (integer) 298
```

**Stampede lock: only one caller reloads a hot key**

```redis
# acquire: SET NX PX in a script, returns 1 (won) or 0 (someone else is loading)
EVAL "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end return 0" 1 lock:cache:product:p-001 tok-A 2000
# → (integer) 1      caller A loads from the DB
EVAL "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end return 0" 1 lock:cache:product:p-001 tok-B 2000
# → (integer) 0      caller B waits and re-reads the cache instead

# release: delete only if the lock still holds MY token
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0" 1 lock:cache:product:p-001 tok-B
# → (integer) 0      B can't delete A's lock
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0" 1 lock:cache:product:p-001 tok-A
# → (integer) 1
```

**Write path: invalidate, don't update**

```redis
DEL cache:product:p-001
# → (integer) 1      the next read repopulates from the database
```

---

## 1b · Eviction: what goes when memory is full

Demos: `npm run demo:flashsale` (talk), `npm run demo:eviction` (extra)

**Inspect the current setup**

```redis
CONFIG GET maxmemory
CONFIG GET maxmemory-policy
# → noeviction (Docker default) · volatile-lru on AWS / GCP / Azure managed Redis
CONFIG GET maxmemory-samples
# → "5"   Redis samples 5 keys per eviction, it does not track exact LRU order
INFO stats
# look for: evicted_keys, keyspace_hits, keyspace_misses
# hit ratio = keyspace_hits / (keyspace_hits + keyspace_misses)
INFO memory
# look for: used_memory_human, maxmemory_human
```

**Why a key gets picked**

```redis
OBJECT IDLETIME cart:user1
# → (integer) 42     seconds since last access: what LRU looks at
OBJECT FREQ product:1
# → (integer) 5      LFU's hit counter (only works when an *-lfu policy is active)
```

**Flash sale by hand.** Use a scratch database and put the settings back afterwards.

```redis
SELECT 4
FLUSHDB

# 300 customers with a cart and a session, no TTL (real state)
EVAL "for i=1,300 do redis.call('HSET','cart:user'..i,'sku:ps5',1,'sku:controller',2) redis.call('HSET','session:user'..i,'loggedIn',1) end return 600" 0

# cap memory ~3 MB above what is used now: read used_memory_human first
INFO memory
CONFIG SET maxmemory 8mb                       # e.g. used_memory_human = 5M → 8mb
CONFIG SET maxmemory-policy allkeys-lru        # then repeat with noeviction, then volatile-lru

# the sale: 500 product pages per call, ~2 KB each, TTL 5 min. Run it 8 times.
EVAL "for i=1,500 do redis.call('SET','product:'..(ARGV[1]*500+i), string.rep('p',2000),'EX',300) end return 1" 0 0
EVAL "for i=1,500 do redis.call('SET','product:'..(ARGV[1]*500+i), string.rep('p',2000),'EX',300) end return 1" 0 1
# … up to ARGV 7

HLEN cart:user1                  # 0 means this customer's cart was evicted
HSET order:late items ps5        # under noeviction → (error) OOM command not allowed …
INFO stats                       # evicted_keys
```

From a shell, count what survived (works outside the interactive prompt):

```bash
docker exec redis-beyond-caching redis-cli -n 4 --scan --pattern 'cart:*' | wc -l
docker exec redis-beyond-caching redis-cli -n 4 --scan --pattern 'product:*' | wc -l
```

Rehearsal: `allkeys-lru` kept ~80 of 300 carts · `noeviction` kept all carts but rejected writes · `volatile-lru` kept all 300.

**Put it back**

```redis
FLUSHDB
CONFIG SET maxmemory 0
CONFIG SET maxmemory-policy noeviction
SELECT 0
```

---

## 2 · Rate limiting: throttle and block an IP

Demo: `npm run demo:ratelimit`

**Fixed window: INCR + PEXPIRE in one atomic script** (limit 10 per 10 s)

```redis
EVAL "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n" 1 rl:203.0.113.7 10000
# → (integer) 1, 2, 3 …  run it 11 times: above 10 the app answers 429
PTTL rl:203.0.113.7
# → (integer) 8123   ms until the window resets: the Retry-After value
```

Without Lua you need a transaction so the TTL is never lost:

```redis
MULTI
INCR rl:203.0.113.7
EXPIRE rl:203.0.113.7 10 NX
EXEC
```

**Block a repeat offender** (the demo does this at 2× the limit)

```redis
SET block:203.0.113.7 abuse EX 60
EXISTS block:203.0.113.7
# → (integer) 1      every request gets 403 until the key expires
TTL block:203.0.113.7
```

**Sliding window: exact count over the last 2 s** (limit 5; ARGV = now in ms, window, limit, unique id)

```redis
EVAL "local now=tonumber(ARGV[1]) local w=tonumber(ARGV[2]) redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now-w) local c=redis.call('ZCARD', KEYS[1]) if c < tonumber(ARGV[3]) then redis.call('ZADD', KEYS[1], now, ARGV[4]) redis.call('PEXPIRE', KEYS[1], w) return {1, c+1} end return {0, c}" 1 rl:sliding:203.0.113.7 1791400000000 2000 5 req-1
# → 1) (integer) 1   allowed      2) (integer) 1   requests in window
ZRANGE rl:sliding:203.0.113.7 0 -1 WITHSCORES
```

**Cleanup:** `DEL rl:203.0.113.7 block:203.0.113.7 rl:sliding:203.0.113.7`

---

## 3 · Distributed locking: inventory and payments

Demo: `npm run demo:lock`

```redis
SET inventory:ps5 10

# acquire: set only if absent, auto-expire after 2 s, value = my random token
SET lock:sku:ps5 tok-1 NX PX 2000
# → OK               I hold the lock
SET lock:sku:ps5 tok-2 NX PX 2000
# → (nil)            someone else holds it: back off and retry
PTTL lock:sku:ps5
# → (integer) 1873

# … charge the card, reserve stock …

# release by token (compare-and-delete must be one script)
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0" 1 lock:sku:ps5 tok-1
# → (integer) 1
```

**Fencing token:** a number that only goes up, sent with every write

```redis
INCR fence:sku:ps5
# → (integer) 1      worker A
INCR fence:sku:ps5
# → (integer) 2      worker B (after A's lock expired); the DB rejects any write with fence < 2
```

**No lock needed for a plain counter:** check-and-decrement is already atomic in Lua

```redis
EVAL "if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end return -1" 1 inventory:ps5
# → (integer) 9 … 0, then -1 = sold out, never negative
```

**Cleanup:** `DEL inventory:ps5 lock:sku:ps5 fence:sku:ps5`

---

## 4 · Broadcasting events: Pub/Sub, Streams, consumer groups

Demos: `npm run demo:broadcast`, then the four-terminal streams demo

**Pub/Sub: live only.** Open two `redis-cli` terminals.

```redis
# terminal A
SUBSCRIBE notify:prices
# terminal B
PUBLISH notify:prices "BTC +2%"
# → (integer) 1      = how many subscribers got it. With nobody listening: 0, message gone.
PSUBSCRIBE notify:*        # pattern subscription
PUBSUB CHANNELS            # channels with at least one subscriber
```

**Stream: history + catch-up**

```redis
XADD events:prices MAXLEN ~ 10000 * alert "BTC +2%"
# → "1791458170668-0"   ID = milliseconds-sequence
XADD events:prices * alert "ETH -1%"
XLEN events:prices
XRANGE events:prices - +                     # replay everything
XREAD COUNT 100 STREAMS events:prices 0      # read after the last ID you saw (0 = from the start)
XREAD BLOCK 0 STREAMS events:prices $        # wait for new entries only (like SUBSCRIBE, but durable)
```

**Consumer group: split the work, ack, recover**

```redis
XADD orders * orderId ord-00001 customer ana amount 47.00
XADD orders * orderId ord-00002 customer ben amount 84.00

XGROUP CREATE orders order-processors 0 MKSTREAM
# → OK               (use $ instead of 0 to start with new messages only)

XREADGROUP GROUP order-processors alice COUNT 1 STREAMS orders >
XREADGROUP GROUP order-processors bob   COUNT 1 STREAMS orders >
# ">" = never delivered to this group; each entry goes to ONE consumer

XPENDING orders order-processors
# → 2 pending, alice 1, bob 1
XPENDING orders order-processors - + 10
# → id, owner, idle ms, delivery count

XACK orders order-processors <id-from-alice>
# → (integer) 1      done, removed from the pending list

# bob "crashed": take over anything idle for more than 5 s
XAUTOCLAIM orders order-processors reclaimer 5000 0-0 COUNT 10
# → claimed entries, delivery count +1

XREADGROUP GROUP order-processors bob STREAMS orders 0
# a restarted consumer reads ITS OWN pending entries with ID 0 instead of >

XINFO GROUPS orders            # pending, last-delivered-id, lag
XINFO CONSUMERS orders order-processors

XGROUP CREATE orders analytics 0
# a second group gets every entry again (fan-out), with its own cursor
```

**Dead-letter after 3 failed deliveries** (what the reclaimer does)

```redis
MULTI
XADD orders:dlq * originalId <id> orderId ord-00025 deliveries 3
XACK orders order-processors <id>
EXEC
```

**Cleanup:** `DEL events:prices orders orders:dlq`

---

## 5 · Semantic cache for LLM answers

Demo: `npm run demo:vector:cache`

Real embeddings have 384 numbers. This toy version uses **2**, so you can type the vectors by hand.
A FLOAT32 vector is raw little-endian bytes: `1.0` = `\x00\x00\x80\x3f`, `0.0` = `\x00\x00\x00\x00`, `0.2` = `\xcd\xcc\x4c\x3e`.

```redis
FT.CREATE idx:llmcache:demo ON HASH PREFIX 1 llmcache:demo: SCHEMA prompt TEXT tenant TAG model TAG embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 2 DISTANCE_METRIC COSINE
# → OK

# two cached answers: "reset password" points at [1, 0], "dark mode" at [0, 1]
HSET llmcache:demo:1 prompt "How do I reset my password?" answer "Use the Forgot password link." tenant acme model v3 embedding "\x00\x00\x80\x3f\x00\x00\x00\x00"
HSET llmcache:demo:2 prompt "How do I enable dark mode?" answer "Settings > Appearance." tenant acme model v3 embedding "\x00\x00\x00\x00\x00\x00\x80\x3f"
EXPIRE llmcache:demo:1 3600

# a paraphrase lands near [1, 0.2] → nearest neighbour, filtered by tenant and model
FT.SEARCH idx:llmcache:demo "(@tenant:{acme} @model:{v3})=>[KNN 1 @embedding $v AS dist]" PARAMS 2 v "\x00\x00\x80\x3f\xcd\xcc\x4c\x3e" RETURN 3 prompt answer dist DIALECT 2
# → llmcache:demo:1   dist 0.0194…   "How do I reset my password?"
#   dist below your threshold → HIT, return the stored answer

# another tenant never sees acme's answers
FT.SEARCH idx:llmcache:demo "(@tenant:{globex})=>[KNN 1 @embedding $v AS dist]" PARAMS 2 v "\x00\x00\x80\x3f\xcd\xcc\x4c\x3e" RETURN 2 answer dist DIALECT 2
# → (integer) 0      MISS: call the LLM, then HSET the answer with a TTL

FT.INFO idx:llmcache:demo      # num_docs, indexing status
```

**Same idea with Vector Sets (Redis 8), no index or schema, plain numbers:**

```redis
VADD faq:vs VALUES 2 1 0 "reset password"
VADD faq:vs VALUES 2 0 1 "dark mode"
VSIM faq:vs VALUES 2 1 0.2 WITHSCORES COUNT 2
# → "reset password" 0.990…   "dark mode" 0.596…   (similarity: higher = closer)
```

**Cleanup:** `FT.DROPINDEX idx:llmcache:demo DD` then `DEL faq:vs`

---

## Quick reference

| Use case | Core commands |
|---|---|
| Cache-aside | `HGETALL` · `HSET` + `EXPIRE` · `DEL` on write · `SET key token NX PX` lock |
| Eviction | `CONFIG SET maxmemory / maxmemory-policy` · `INFO stats` · `OBJECT IDLETIME / FREQ` |
| Rate limiting | `INCR` + `PEXPIRE` in `EVAL` · `SET block:<ip> EX` · `ZADD` / `ZREMRANGEBYSCORE` / `ZCARD` |
| Locking | `SET key token NX PX` · compare-and-delete `EVAL` · `INCR` fencing token |
| Broadcasting | `PUBLISH` / `SUBSCRIBE` · `XADD` / `XREAD` · `XGROUP` / `XREADGROUP` / `XACK` / `XAUTOCLAIM` |
| Semantic cache | `FT.CREATE … VECTOR HNSW` · `HSET` + `EXPIRE` · `FT.SEARCH … KNN … PARAMS` · `VADD` / `VSIM` |
