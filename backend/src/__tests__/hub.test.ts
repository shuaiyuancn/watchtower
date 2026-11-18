import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { WebSocket } from 'ws';

vi.mock('../notify/slack.js', () => ({
  notifySlack: vi.fn(),
  slackEnabled: () => true
}));
vi.mock('../release/latest.js', () => ({
  getLatestBinaryHash: vi.fn(async () => null),
  compareToLatest: vi.fn(() => null)
}));

import { notifySlack } from '../notify/slack.js';
import { getLatestBinaryHash, compareToLatest } from '../release/latest.js';
import { WatchtowerStore } from '../ledger/store.js';
import { WebSocketHub, LOCK_FAILED_ALERT_INTERVAL_MS } from '../ws/hub.js';
import { MAC_DEFAULT_APP_RULES } from '../ledger/rules.js';

class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  receive(msg: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

const slack = vi.mocked(notifySlack);
const lockFailedAlerts = () => slack.mock.calls.filter(([text]) => text.includes('could not lock'));

describe('WebSocketHub', () => {
  let tempDir: string;
  let store: WatchtowerStore;
  let hub: WebSocketHub;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-hub-test-'));
    store = new WatchtowerStore(tempDir);
    hub = new WebSocketHub(store);
    slack.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const connect = (deviceId: string, platform?: 'windows' | 'macos') => {
    const ws = new FakeSocket();
    hub.registerClient(deviceId, ws as unknown as WebSocket, platform);
    return ws;
  };

  describe('LOCK_FAILED', () => {
    it('alerts Slack naming the device, at most once per device per interval', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
      const ws = connect('kid-mac', 'macos');

      ws.receive({ type: 'LOCK_FAILED', reason: 'screen still unlocked after pmset' });
      expect(lockFailedAlerts()).toHaveLength(1);
      expect(lockFailedAlerts()[0][0]).toContain('kid-mac');
      expect(lockFailedAlerts()[0][0]).toContain('screen still unlocked after pmset');

      // Repeats inside the window are swallowed.
      vi.setSystemTime(new Date(Date.now() + LOCK_FAILED_ALERT_INTERVAL_MS - 1000));
      ws.receive({ type: 'LOCK_FAILED' });
      expect(lockFailedAlerts()).toHaveLength(1);

      // A different device has its own window.
      const other = connect('other-mac', 'macos');
      other.receive({ type: 'LOCK_FAILED' });
      expect(lockFailedAlerts()).toHaveLength(2);

      // After the window, the device alerts again.
      vi.setSystemTime(new Date(Date.now() + 2000));
      ws.receive({ type: 'LOCK_FAILED' });
      expect(lockFailedAlerts()).toHaveLength(3);
    });

    it('survives a reconnect without re-alerting inside the window', () => {
      connect('flappy', 'macos').receive({ type: 'LOCK_FAILED' });
      connect('flappy', 'macos').receive({ type: 'LOCK_FAILED' });
      expect(lockFailedAlerts()).toHaveLength(1);
    });

    it('rejects a malformed message and strips Slack markup from the reason', () => {
      const ws = connect('kid-mac', 'macos');
      ws.receive({ type: 'LOCK_FAILED', reason: 'x'.repeat(300) });
      expect(lockFailedAlerts()).toHaveLength(0);

      ws.receive({ type: 'LOCK_FAILED', reason: '<!channel> *bold*\nsecond line' });
      expect(lockFailedAlerts()).toHaveLength(1);
      const text = lockFailedAlerts()[0][0];
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('\n');
      expect(text).toContain('!channel bold second line');
    });
  });

  describe('platform', () => {
    it('seeds a Mac that connects with ?platform=macos before the first policy sync', () => {
      const ws = connect('new-mac', 'macos');
      const sync = ws.sent.find((m) => m.type === 'COMMAND' && m.command.action === 'SYNC_POLICY');
      expect(sync.command.policy.platform).toBe('macos');
      expect(sync.command.policy.appRules).toEqual(MAC_DEFAULT_APP_RULES);
    });

    it('leaves a Windows client that sends no platform as windows', () => {
      const ws = connect('win-pc');
      ws.receive({ type: 'HEARTBEAT', currentApp: 'chrome.exe', elapsedActiveDeltaSeconds: 3 });
      expect(store.getPolicy('win-pc').platform).toBe('windows');
      expect(ws.sent.some((m) => m.type === 'HEARTBEAT_ACK')).toBe(true);
    });

    it('takes the platform and display name from a heartbeat, ignoring unknown platforms', () => {
      const ws = connect('hb-mac');
      ws.receive({ type: 'HEARTBEAT', currentApp: 'com.apple.Safari', platform: 'linux', elapsedActiveDeltaSeconds: 3 });
      expect(ws.sent.filter((m) => m.type === 'HEARTBEAT_ACK')).toHaveLength(1);
      expect(store.getPolicy('hb-mac').platform).toBe('windows');

      ws.receive({
        type: 'HEARTBEAT',
        currentApp: 'com.apple.Safari',
        appDisplayName: 'Safari',
        platform: 'macos',
        elapsedActiveDeltaSeconds: 3
      });
      expect(store.getPolicy('hb-mac').platform).toBe('macos');
      expect(store.getActiveSession('hb-mac')?.appDisplayName).toBe('Safari');
      expect(store.getActiveSession('hb-mac')?.category).toBe('Browsers');
    });

    it('rejects a heartbeat whose display name is over the cap', () => {
      const ws = connect('long-name');
      ws.receive({ type: 'HEARTBEAT', currentApp: 'com.apple.Safari', appDisplayName: 'x'.repeat(129) });
      expect(ws.sent.some((m) => m.type === 'HEARTBEAT_ACK')).toBe(false);
    });
  });

  describe('up-to-date check', () => {
    const connectedNotices = () => slack.mock.calls.filter(([text]) => text.includes('device connected'));

    it('compares a Mac with the macOS release asset and a PC with watchtower.exe', async () => {
      const latest = vi.mocked(getLatestBinaryHash);
      latest.mockClear();
      vi.mocked(compareToLatest).mockReturnValue(false);

      connect('kid-mac', 'macos').receive({ type: 'HEARTBEAT', currentApp: 'com.apple.Safari', binaryHash: 'a'.repeat(64) });
      connect('kid-pc').receive({ type: 'HEARTBEAT', currentApp: 'chrome.exe', binaryHash: 'b'.repeat(64) });
      await vi.waitFor(() => expect(connectedNotices()).toHaveLength(2));

      expect(latest.mock.calls).toEqual([['macos'], ['windows']]);
      const [mac, pc] = connectedNotices().map(([text]) => text);
      expect(mac).toContain('kid-mac');
      expect(mac).toContain('within ~6h');
      expect(pc).toContain('kid-pc');
      expect(pc).toContain('within ~30m');
      vi.mocked(compareToLatest).mockReturnValue(null);
    });
  });
});
