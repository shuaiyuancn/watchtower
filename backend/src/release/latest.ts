// Determines whether a connected client is running the latest published
// release, by fetching the release's `watchtower.exe.sha256` from GitHub and
// comparing it to the SHA-256 the client reports for its own binary.
//
// Best-effort and cached: a network failure never blocks a connection; it just
// yields an "unknown" result (null), and the last good value is kept until TTL.

const LATEST_SHA_URL =
  'https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe.sha256';

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 4000;

let cache: { hash: string | null; ts: number } = { hash: null, ts: 0 };

/** Extract a 64-char hex SHA-256 digest from a `.sha256` file's contents. */
export function parseSha256(content: string): string | null {
  const m = content.match(/[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Compare a client-reported binary hash against the latest release hash.
 * Returns true/false when both are known, or null when either is missing.
 */
export function compareToLatest(
  latest: string | null,
  clientHash: string | undefined
): boolean | null {
  if (!latest || !clientHash) return null;
  return latest.toLowerCase() === clientHash.toLowerCase();
}

/**
 * The latest published release's binary SHA-256, cached for TTL_MS. Returns the
 * last cached value (possibly null) if the fetch fails, so callers never throw.
 */
export async function getLatestBinaryHash(): Promise<string | null> {
  const now = Date.now();
  if (cache.hash && now - cache.ts < TTL_MS) return cache.hash;

  try {
    const res = await fetch(LATEST_SHA_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return cache.hash; // keep stale value on HTTP error
    const hash = parseSha256(await res.text());
    if (hash) cache = { hash, ts: now };
    return hash ?? cache.hash;
  } catch {
    return cache.hash; // keep stale value on network error
  }
}
