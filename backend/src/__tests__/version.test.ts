import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WatchtowerStore } from '../ledger/store.js';
import { ClientHeartbeatPayload } from '../types.js';
import { parseSha256, compareToLatest } from '../release/latest.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function heartbeat(overrides: Partial<ClientHeartbeatPayload> = {}): ClientHeartbeatPayload {
  return {
    deviceId: 'child-pc',
    hostname: 'child-pc',
    currentApp: 'chrome.exe',
    windowTitle: '',
    isIdle: false,
    idleSeconds: 0,
    elapsedActiveDeltaSeconds: 1,
    utcOffsetMinutes: 0,
    autoUpdate: true,
    ...overrides
  };
}

describe('release/latest helpers', () => {
  it('parseSha256 extracts a 64-char hex digest, lowercased', () => {
    expect(parseSha256(HASH_A.toUpperCase() + '  watchtower.exe\n')).toBe(HASH_A);
    expect(parseSha256('no hash here')).toBeNull();
    expect(parseSha256('')).toBeNull();
  });

  it('compareToLatest is case-insensitive and null when either side is unknown', () => {
    expect(compareToLatest(HASH_A, HASH_A.toUpperCase())).toBe(true);
    expect(compareToLatest(HASH_A, HASH_B)).toBe(false);
    expect(compareToLatest(null, HASH_A)).toBeNull();
    expect(compareToLatest(HASH_A, undefined)).toBeNull();
  });
});

describe('store records client version and latest status', () => {
  let tempDir: string;
  let store: WatchtowerStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-ver-'));
    store = new WatchtowerStore(tempDir);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('persists reported version and binary hash on the active session', () => {
    store.recordHeartbeat(heartbeat({ clientVersion: '0.1.0', binaryHash: HASH_A }));
    const session = store.getActiveSession('child-pc');
    expect(session?.clientVersion).toBe('0.1.0');
    expect(session?.binaryHash).toBe(HASH_A);
    expect(session?.isLatest).toBeNull(); // not yet resolved
  });

  it('carries version/hash and isLatest forward across heartbeats', () => {
    store.recordHeartbeat(heartbeat({ clientVersion: '0.1.0', binaryHash: HASH_A }));
    store.markDeviceVersionStatus('child-pc', '0.1.0', HASH_A, true);
    // A later heartbeat without version fields must not wipe what we know.
    store.recordHeartbeat(heartbeat({ clientVersion: undefined, binaryHash: undefined }));
    const session = store.getActiveSession('child-pc');
    expect(session?.clientVersion).toBe('0.1.0');
    expect(session?.binaryHash).toBe(HASH_A);
    expect(session?.isLatest).toBe(true);
  });

  it('markDeviceVersionStatus records an outdated client', () => {
    store.recordHeartbeat(heartbeat({ clientVersion: '0.1.0', binaryHash: HASH_B }));
    store.markDeviceVersionStatus('child-pc', '0.1.0', HASH_B, false);
    expect(store.getActiveSession('child-pc')?.isLatest).toBe(false);
  });
});
