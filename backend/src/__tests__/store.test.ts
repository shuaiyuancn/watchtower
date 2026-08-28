import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    const logs = store.getTelemetry('child-pc', 10);
    expect(logs.length).toBe(1);
    expect(logs[0].type).toBe('YOUTUBE');
    expect(logs[0].titleOrText).toContain('Math Tutorial');

    store.close();

    // Reopen store from disk
    const newStore = new WatchtowerStore(tempDir);
    const persistedLogs = newStore.getTelemetry('child-pc', 10);
    expect(persistedLogs.length).toBe(1);
    expect(persistedLogs[0].titleOrText).toBe('Math Tutorial - Khan Academy');
    newStore.close();
  });

  it('adds bonus time and toggles emergency lock', () => {
    store.addBonusTime('child-pc', 1800);
    expect(store.getPolicy('child-pc').bonusSecondsToday).toBe(1800);

    store.setEmergencyLock('child-pc', true);
    expect(store.getPolicy('child-pc').emergencyLock).toBe(true);

    store.close();

    const newStore = new WatchtowerStore(tempDir);
    expect(newStore.getPolicy('child-pc').bonusSecondsToday).toBe(1800);
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
    const currentHour = new Date().getHours();
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
  });
});

