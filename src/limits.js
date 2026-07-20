/**
 * Rate limiting and job concurrency.
 *
 * murdock runs as a single instance on a small box, so in-memory counters are
 * sufficient and correct — there is no second process to coordinate with. If it
 * ever scales horizontally this needs to move to shared state (Redis).
 *
 * Two separate protections:
 *   - Per-IP rate limits stop one caller monopolising the instance.
 *   - A global concurrency semaphore stops N simultaneous ffmpeg transcodes
 *     from exhausting RAM. On a 512MB host, two concurrent WAV jobs is already
 *     the practical ceiling.
 */

export const EXTRACT_PER_HOUR = Number(process.env.MURDOCK_EXTRACT_PER_HOUR || 12);
export const PROBE_PER_HOUR = Number(process.env.MURDOCK_PROBE_PER_HOUR || 60);
export const MAX_CONCURRENT = Number(process.env.MURDOCK_MAX_CONCURRENT || 2);

const WINDOW_MS = 60 * 60 * 1000;

/** bucketName -> Map<ip, number[]> of request timestamps within the window. */
const buckets = new Map();

function bucketFor(name) {
  if (!buckets.has(name)) buckets.set(name, new Map());
  return buckets.get(name);
}

/**
 * Trust the platform's forwarded header when present — on Render/Fly the
 * socket address is the load balancer, identical for every caller, which would
 * otherwise rate-limit all users as one.
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Record a hit and report whether it is allowed.
 * Returns { allowed, remaining, retryAfterSeconds }.
 */
export function consume(bucketName, ip, limit) {
  const bucket = bucketFor(bucketName);
  const now = Date.now();
  const hits = (bucket.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (hits.length >= limit) {
    const oldest = hits[0];
    bucket.set(ip, hits);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((oldest + WINDOW_MS - now) / 1000),
    };
  }

  hits.push(now);
  bucket.set(ip, hits);
  return { allowed: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

/** Drop IPs with no recent activity so the maps don't grow without bound. */
export function pruneBuckets() {
  const now = Date.now();
  for (const bucket of buckets.values()) {
    for (const [ip, hits] of bucket) {
      const live = hits.filter((t) => now - t < WINDOW_MS);
      if (live.length === 0) bucket.delete(ip);
      else bucket.set(ip, live);
    }
  }
}

const pruneTimer = setInterval(pruneBuckets, 10 * 60 * 1000);
pruneTimer.unref?.();

/** Express middleware factory. */
export function rateLimit(bucketName, limit) {
  return (req, res, next) => {
    const result = consume(bucketName, clientIp(req), limit);
    res.set('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return res.status(429).json({
        error: `Rate limit reached (${limit}/hour). Try again in about ${minutes} minute${
          minutes === 1 ? '' : 's'
        }.`,
      });
    }

    next();
  };
}

/* ---------- concurrency ---------- */

let active = 0;
const waiting = [];

export function activeJobs() {
  return { active, queued: waiting.length, max: MAX_CONCURRENT };
}

/**
 * Acquire a job slot, waiting if the instance is already at capacity.
 * Resolves to a release function that must be called in a finally block.
 */
export function acquireSlot() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => waiting.push(() => resolve(release)));
}

function release() {
  const next = waiting.shift();
  if (next) {
    // Hand the slot straight to the next waiter; `active` stays unchanged.
    next();
  } else {
    active = Math.max(0, active - 1);
  }
}
