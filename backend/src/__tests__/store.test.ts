import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WatchtowerStore } from '../ledger/store.js';
import { ClientHeartbeatPayload } from '../types.js';

describe('Watchtower SQLite Store', () => {
  let tempDir: string;
  let store: WatchtowerStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-test-'));
    store = new WatchtowerStore(tempDir);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('creates watchtower.db file in target directory', () => {
    const dbFile = path.join(tempDir, 'watchtower.db');
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it('creates and persists default policy on first access', () => {
    const policy = store.getPolicy('child-pc');
    expect(policy.deviceId).toBe('child-pc');
    expect(policy.dailyGlobalLimitSeconds).toBe(86400);
    expect(policy.categoryLimits).toEqual([]);
    expect(policy.bedtime?.enabled).toBe(false);

    store.close();

    // Reopen store from disk and verify persistence
    const newStore = new WatchtowerStore(tempDir);
    const persisted = newStore.getPolicy('child-pc');
    expect(persisted.deviceId).toBe('child-pc');
    expect(persisted.dailyGlobalLimitSeconds).toBe(86400);
    expect(persisted.categoryLimits).toEqual([]);
    expect(persisted.bedtime?.enabled).toBe(false);
    newStore.close();
  });

  it('updates policy and persists changes across instances', () => {
    const policy = store.getPolicy('child-pc');
    policy.dailyGlobalLimitSeconds = 3600;
    policy.emergencyLock = true;
    store.updatePolicy(policy);
    store.close();

    const newStore = new WatchtowerStore(tempDir);
    const persisted = newStore.getPolicy('child-pc');
    expect(persisted.dailyGlobalLimitSeconds).toBe(3600);
    expect(persisted.emergencyLock).toBe(true);
    newStore.close();
  });

  it('records heartbeats and accumulates active time in SQLite', () => {
    const heartbeat: ClientHeartbeatPayload = {
      deviceId: 'child-pc',
      hostname: 'child-pc-host',
      currentApp: 'RobloxPlayerBeta.exe',
      windowTitle: 'Roblox',
      isIdle: false,
      idleSeconds: 0,
      elapsedActiveDeltaSeconds: 15
    };

    const result = store.recordHeartbeat(heartbeat);
    expect(result.usage.totalActiveSeconds).toBe(15);
    expect(result.usage.categorySeconds['Games']).toBe(15);
    expect(result.usage.appSeconds['robloxplayerbeta.exe']).toBe(15);

    // Verify session
    const session = store.getActiveSession('child-pc');
    expect(session?.currentApp).toBe('RobloxPlayerBeta.exe');
    expect(session?.category).toBe('Games');

    store.close();

    // Reopen store from disk
    const newStore = new WatchtowerStore(tempDir);
    const usage = newStore.getDailyUsage('child-pc');
    expect(usage.totalActiveSeconds).toBe(15);
    expect(usage.categorySeconds['Games']).toBe(15);
    newStore.close();
  });

  it('records and queries telemetry events', () => {
    store.recordTelemetry({
      deviceId: 'child-pc',
      timestamp: new Date().toISOString(),
      type: 'YOUTUBE',
      app: 'chrome.exe',
      titleOrText: 'Math Tutorial - Khan Academy',
      details: { channel: 'Khan Academy' }
    });

    // Record telemetry for another machine
    store.recordTelemetry({
      deviceId: 'laptop-pc',
      timestamp: '2026-09-01T10:00:00.000Z',
      type: 'IM_MESSAGE',
      app: 'discord.exe',
      titleOrText: 'Hello from laptop',
      details: {}
    });

    // child-pc query should NOT include laptop-pc events
    const childLogs = store.getTelemetry('child-pc', 10);
    expect(childLogs.length).toBe(1);
    expect(childLogs[0].deviceId).toBe('child-pc');

    // laptop-pc query should only return its own event
    const laptopLogs = store.getTelemetry('laptop-pc', 10);
    expect(laptopLogs.length).toBe(1);
    expect(laptopLogs[0].deviceId).toBe('laptop-pc');
    expect(laptopLogs[0].type).toBe('IM_MESSAGE');

    // Date filtering test
    const pastDateLogs = store.getTelemetry('laptop-pc', 10, '2026-09-01');
    expect(pastDateLogs.length).toBe(1);
    const nonExistentDateLogs = store.getTelemetry('laptop-pc', 10, '2025-01-01');
    expect(nonExistentDateLogs.length).toBe(0);

    store.close();

    // Reopen store from disk
    const newStore = new WatchtowerStore(tempDir);
    const persistedLogs = newStore.getTelemetry('child-pc', 10);
    expect(persistedLogs.length).toBe(1);
    expect(persistedLogs[0].titleOrText).toBe('Math Tutorial - Khan Academy');
    expect(persistedLogs[0].deviceId).toBe('child-pc');
    newStore.close();
  });

  it('adjusts today-only bonus (may go negative) without changing the base limit', () => {
    const daily = store.getPolicy('child-pc').dailyGlobalLimitSeconds;
    store.adjustTime('child-pc', 1800); // +30m today
    expect(store.getPolicy('child-pc').bonusSecondsToday).toBe(1800);

    // Remove 60m: today's adjustment goes negative; base limit unchanged.
    store.adjustTime('child-pc', -3600);
    expect(store.getPolicy('child-pc').bonusSecondsToday).toBe(-1800);
    expect(store.getPolicy('child-pc').dailyGlobalLimitSeconds).toBe(daily);

    store.setEmergencyLock('child-pc', true);
    expect(store.getPolicy('child-pc').emergencyLock).toBe(true);

    store.close();

    const newStore = new WatchtowerStore(tempDir);
    expect(newStore.getPolicy('child-pc').bonusSecondsToday).toBe(-1800);
    expect(newStore.getPolicy('child-pc').emergencyLock).toBe(true);
    newStore.close();
  });

  it('auto-migrates existing JSON database file if found', () => {
    // Create legacy JSON file before initializing store
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-legacy-'));
    const jsonPath = path.join(legacyDir, 'watchtower_data.json');

    const legacyData = {
      policies: {
        'legacy-pc': {
          deviceId: 'legacy-pc',
          dailyGlobalLimitSeconds: 5400,
          warningThresholdSeconds: 300,
          emergencyLock: false,
          bonusSecondsToday: 600,
          bedtime: { enabled: true, startHour: 20, startMinute: 30, endHour: 7, endMinute: 0 },
          categoryLimits: [],
          appRules: []
        }
      },
      dailyUsage: {
        'legacy-pc_2026-08-23': {
          date: '2026-08-23',
          deviceId: 'legacy-pc',
          totalActiveSeconds: 1200,
          categorySeconds: { Games: 1200, Browsers: 0, Social: 0, Media: 0, Education: 0, Productivity: 0, System: 0, Other: 0 },
          appSeconds: { 'minecraft.exe': 1200 }
        }
      },
      telemetry: []
    };

    fs.writeFileSync(jsonPath, JSON.stringify(legacyData), 'utf-8');

    const migratedStore = new WatchtowerStore(legacyDir);
    const policy = migratedStore.getPolicy('legacy-pc');
    expect(policy.dailyGlobalLimitSeconds).toBe(5400);
    expect(policy.bonusSecondsToday).toBe(600);

    const usage = migratedStore.getDailyUsage('legacy-pc', '2026-08-23');
    expect(usage.totalActiveSeconds).toBe(1200);

    // Verify backup file exists
    expect(fs.existsSync(`${jsonPath}.migrated`)).toBe(true);

    migratedStore.close();

    try {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    } catch {}
  });

  it('records timeline events and retrieves hourly breakdown', () => {
    const today = new Date().toISOString().split('T')[0];

    // Record heartbeats for Chrome and VS Code
    store.recordHeartbeat({
      deviceId: 'child-pc',
      hostname: 'child-pc-host',
      currentApp: 'chrome.exe',
      windowTitle: 'Google Search',
      isIdle: false,
      idleSeconds: 0,
      elapsedActiveDeltaSeconds: 30
    });

    store.recordHeartbeat({
      deviceId: 'child-pc',
      hostname: 'child-pc-host',
      currentApp: 'Code.exe',
      windowTitle: 'store.ts - watchtower',
      isIdle: false,
      idleSeconds: 0,
      elapsedActiveDeltaSeconds: 20
    });

    // 1. Test getTimeline
    const timeline = store.getTimeline('child-pc', today);
    expect(timeline.length).toBe(2);
    expect(timeline[0].app).toBe('code.exe');
    expect(timeline[0].windowTitle).toBe('store.ts - watchtower');
    expect(timeline[0].category).toBe('Productivity');
    expect(timeline[0].durationSeconds).toBe(20);

    expect(timeline[1].app).toBe('chrome.exe');
    expect(timeline[1].category).toBe('Browsers');
    expect(timeline[1].durationSeconds).toBe(30);

    // 2. Test getHourlyBreakdown
    const hourly = store.getHourlyBreakdown('child-pc', today);
    expect(hourly.length).toBe(24);
    // Heartbeats without an explicit offset are bucketed in UTC.
    const currentHour = new Date().getUTCHours();
    const currentBucket = hourly[currentHour];
    expect(currentBucket.totalSeconds).toBe(50);
    expect(currentBucket.categorySeconds['Browsers']).toBe(30);
    expect(currentBucket.categorySeconds['Productivity']).toBe(20);
    expect(currentBucket.appSeconds['chrome.exe']).toBe(30);
    expect(currentBucket.appSeconds['code.exe']).toBe(20);

    // 3. Test getDailyHistory
    const history = store.getDailyHistory('child-pc', 7);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].totalActiveSeconds).toBe(50);

    // 4. Test getTimeline with hour filter
    const timelineThisHour = store.getTimeline('child-pc', today, 1000, currentHour);
    expect(timelineThisHour.length).toBe(2);

    const otherHour = (currentHour + 5) % 24;
    const timelineOtherHour = store.getTimeline('child-pc', today, 1000, otherHour);
    expect(timelineOtherHour.length).toBe(0);
  });

  it('groups continuing app heartbeats together in timeline rather than creating duplicate 3s rows', () => {
    const today = new Date().toISOString().split('T')[0];

    // Simulate 5 consecutive 3s heartbeats in zen.exe
    for (let i = 0; i < 5; i++) {
      store.recordHeartbeat({
        deviceId: 'grouped-pc',
        hostname: 'grouped-host',
        currentApp: 'zen.exe',
        windowTitle: `Tab ${i} - YouTube — Zen Browser`,
        isIdle: false,
        idleSeconds: 0,
        elapsedActiveDeltaSeconds: 3
      });
    }

    // Timeline should have only 1 merged entry with total duration 15s
    const timeline1 = store.getTimeline('grouped-pc', today);
    expect(timeline1.length).toBe(1);
    expect(timeline1[0].app).toBe('zen.exe');
    expect(timeline1[0].durationSeconds).toBe(15);
    expect(timeline1[0].category).toBe('Browsers');

    // Now switch to Code.exe for 3 consecutive 3s heartbeats
    for (let i = 0; i < 3; i++) {
      store.recordHeartbeat({
        deviceId: 'grouped-pc',
        hostname: 'grouped-host',
        currentApp: 'Code.exe',
        windowTitle: 'main.rs - watchtower',
        isIdle: false,
        idleSeconds: 0,
        elapsedActiveDeltaSeconds: 3
      });
    }

    const timeline2 = store.getTimeline('grouped-pc', today);
    expect(timeline2.length).toBe(2);
    // Newest is Code.exe (9s), previous is zen.exe (15s)
    expect(timeline2[0].app).toBe('code.exe');
    expect(timeline2[0].durationSeconds).toBe(9);
    expect(timeline2[1].app).toBe('zen.exe');
    expect(timeline2[1].durationSeconds).toBe(15);
  });

  it('reassigns an app category, persists the rule, and re-labels history/usage', () => {
    const today = new Date().toISOString().split('T')[0];
    // chrome.exe defaults to Browsers.
    for (let i = 0; i < 3; i++) {
      store.recordHeartbeat({
        deviceId: 'cat-pc',
        hostname: 'cat-pc',
        currentApp: 'chrome.exe',
        windowTitle: 'YouTube',
        isIdle: false,
        idleSeconds: 0,
        elapsedActiveDeltaSeconds: 10
      });
    }
    const before = store.getDailyUsage('cat-pc', today);
    expect(before.categorySeconds.Browsers).toBeGreaterThan(0);
    const chromeSecs = before.appSeconds['chrome.exe'];
    expect(chromeSecs).toBeGreaterThan(0);

    // Reassign to Games.
    const policy = store.reassignAppCategory('cat-pc', 'chrome.exe', 'Games');
    expect(policy.appRules.find(r => r.executableName.toLowerCase() === 'chrome.exe')?.category).toBe('Games');

    // Persisted rule now resolves chrome.exe to Games for future categorization.
    const reopened = new WatchtowerStore(tempDir);
    // Timeline rows are re-labelled.
    const timeline = reopened.getTimeline('cat-pc', today);
    expect(timeline.every(r => r.app !== 'chrome.exe' || r.category === 'Games')).toBe(true);
    // Category seconds moved from Browsers to Games.
    const after = reopened.getDailyUsage('cat-pc', today);
    expect(after.categorySeconds.Games).toBeGreaterThanOrEqual(chromeSecs);
    expect(after.categorySeconds.Browsers || 0).toBe(0);
    reopened.close();
  });

  it('rejects retroactive move when category is unchanged (idempotent)', () => {
    expect(WatchtowerStore.isValidCategory('Games')).toBe(true);
    expect(WatchtowerStore.isValidCategory('Nonsense')).toBe(false);
  });

  it('evaluates bedtime in the device local timezone via utcOffsetMinutes', () => {
    vi.useFakeTimers();
    try {
      // Fix the wall clock at 14:30 UTC.
      vi.setSystemTime(new Date('2026-08-23T14:30:00Z'));

      const policy = store.getPolicy('tz-pc');
      policy.bedtime = { enabled: true, startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 };
      store.updatePolicy(policy);

      const base = {
        deviceId: 'tz-pc',
        hostname: 'tz-pc',
        currentApp: 'chrome.exe',
        windowTitle: '',
        isIdle: false,
        idleSeconds: 0,
        elapsedActiveDeltaSeconds: 3
      };

      // UTC+8: local time is 22:30 -> inside 22:00–07:00 curfew.
      const inCurfew = store.recordHeartbeat({ ...base, utcOffsetMinutes: 480 });
      expect(inCurfew.decision.shouldLogoffUser).toBe(true);
      expect(inCurfew.decision.reason).toBe('BEDTIME_CURFEW');

      // Same instant, UTC (offset 0): local time is 14:30 -> not curfew.
      const notCurfew = store.recordHeartbeat({ ...base, utcOffsetMinutes: 0 });
      expect(notCurfew.decision.shouldLogoffUser).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

