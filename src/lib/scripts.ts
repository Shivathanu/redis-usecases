/**
 * Lua scripts shared by the demos. Each runs atomically on the Redis main thread:
 * no other command can interleave between its reads and writes.
 */

/** Acquire: SET key token NX PX ttl. Returns 1 if we got it, 0 if someone else holds it. */
export const ACQUIRE_LOCK = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return 1
end
return 0`;

/** Release: delete ONLY if the lock still holds our token (it may have expired and been re-acquired). */
export const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** Fixed window: INCR, set the TTL on the first hit of the window. Returns {count, ttlMs}. */
export const FIXED_WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}`;

/**
 * Sliding window log in a sorted set (score = timestamp ms).
 * ARGV: now, windowMs, limit, member. Returns {allowed (1/0), countInWindow}.
 */
export const SLIDING_WINDOW = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, count + 1}
end
return {0, count}`;
