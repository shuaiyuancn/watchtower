// Determines whether a connected client is running the latest published
// release, by fetching the release's checksum file for the device's platform
// from GitHub (`watchtower.exe.sha256` on Windows,
// `watchtower-macos-arm64.sha256` on macOS) and comparing it to the SHA-256 the
// client reports for its own binary.
//
// Best-effort and cached: a network failure never blocks a connection; it just
// yields an "unknown" result (null), and the last good value is kept until TTL.

import { Platform } from '../types.js';

const RELEASE_DOWNLOAD_BASE = 'https://github.com/shuaiyuancn/watchtower/releases/latest/download';

/** The release asset each platform's client runs, as published by release-client.yml. */
export const RELEASE_ASSET: Record<Platform, string> = {
  windows: 'watchtower.exe',
  macos: 'watchtower-macos-arm64'
};

/** Download URL of a platform's release binary (append `.sha256` for its checksum). */
export function releaseAssetUrl(platform: Platform): string {
  return `${RELEASE_DOWNLOAD_BASE}/${RELEASE_ASSET[platform]}`;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 4000;

const cache: Record<Platform, { hash: string | null; ts: number }> = {
  windows: { hash: null, ts: 0 },
  macos: { hash: null, ts: 0 }
};

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
 * The latest published release's binary SHA-256 for `platform` (Windows when
 * omitted), cached for TTL_MS per platform. Returns the last cached value
 * (possibly null) if the fetch fails, so callers never throw.
 */
export async function getLatestBinaryHash(platform: Platform = 'windows'): Promise<string | null> {
  const entry = cache[platform];
  const now = Date.now();
  if (entry.hash && now - entry.ts < TTL_MS) return entry.hash;

  try {
    const res = await fetch(`${releaseAssetUrl(platform)}.sha256`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return entry.hash; // keep stale value on HTTP error
    const hash = parseSha256(await res.text());
    if (hash) cache[platform] = { hash, ts: now };
    return hash ?? entry.hash;
  } catch {
    return entry.hash; // keep stale value on network error
  }
}
