/**
 * Fixed-window in-memory rate limiter.
 * Good enough for a single instance; with several instances this would move
 * to Redis (INCR + EXPIRE) so all instances share the counters.
 */
export const createRateLimiter = ({ windowMs, max, now = () => Date.now() }) => {
  const hits = new Map(); // key -> { count, resetAt }

  const take = (key) => {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    }
    return { allowed: entry.count <= max, retryAfterMs: Math.max(0, entry.resetAt - t) };
  };

  const middleware = (keyFn) => (req, res, next) => {
    const { allowed, retryAfterMs } = take(keyFn(req));
    if (allowed) return next();
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ message: 'Too many requests, slow down' });
  };

  return { take, middleware };
};
