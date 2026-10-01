import { describe, it, expect } from 'vitest';
import { 
  evaluateEnforcement, 
  isBedtimeActive, 
  resolveAppCategory 
} from '../ledger/rules.js';
import { DevicePolicy, DailyUsageSummary } from '../types.js';

describe('Watchtower Rules Engine', () => {
  const mockPolicy: DevicePolicy = {
    deviceId: 'test-pc',
    dailyGlobalLimitSeconds: 7200, // 2 hours
    warningThresholdSeconds: 300, // 5 minutes
    emergencyLock: false,
    bonusSecondsToday: 0,
    bedtime: {
      enabled: false,
      startHour: 21,
      startMinute: 0,
      endHour: 7,
      endMinute: 0
    },
    categoryLimits: [
      { category: 'Games', dailyLimitSeconds: 3600 } // 1 hour for games
    ],
    appRules: [
      { executableName: 'RobloxPlayerBeta.exe', displayName: 'Roblox', category: 'Games', dailyLimitSeconds: 1800 }, // 30 mins
      { executableName: 'BlockedGame.exe', displayName: 'Blocked Game', category: 'Games', isBlockedAlways: true }
    ]
  };

  const emptyUsage: DailyUsageSummary = {
    date: '2026-08-23',
    deviceId: 'test-pc',
    totalActiveSeconds: 0,
    categorySeconds: {
      Games: 0,
      Browsers: 0,
      Social: 0,
      Media: 0,
      Education: 0,
      Productivity: 0,
      System: 0,
      Other: 0
    },
    appSeconds: {}
  };

  it('correctly categorizes known applications', () => {
    expect(resolveAppCategory('chrome.exe', mockPolicy).category).toBe('Browsers');
    expect(resolveAppCategory('zen.exe', mockPolicy).category).toBe('Browsers');
    expect(resolveAppCategory('RobloxPlayerBeta.exe', mockPolicy).category).toBe('Games');
    expect(resolveAppCategory('unknown_custom_tool.exe', mockPolicy).category).toBe('Other');
  });

  it('blocks always-blocked applications immediately', () => {
    const decision = evaluateEnforcement(mockPolicy, emptyUsage, 'BlockedGame.exe');
    expect(decision.shouldKillApp).toBe(true);
    expect(decision.shouldLogoffUser).toBe(false);
    expect(decision.reason).toBe('APP_BLOCKED_ALWAYS');
  });

  it('triggers 5-minute warning when within threshold', () => {
    const nearLimitUsage: DailyUsageSummary = {
      ...emptyUsage,
      totalActiveSeconds: 7000 // 200s remaining (< 300s warning threshold)
    };
    const decision = evaluateEnforcement(mockPolicy, nearLimitUsage, 'Code.exe');
    expect(decision.shouldKillApp).toBe(false);
    expect(decision.shouldWarn).toBe(true);
    expect(decision.warningMessage).toContain('minute');
  });

  it('kills app when app-specific limit is exhausted', () => {
    const appExhaustedUsage: DailyUsageSummary = {
      ...emptyUsage,
      appSeconds: {
        'robloxplayerbeta.exe': 1800 // hit 30 min limit
      }
    };
    const decision = evaluateEnforcement(mockPolicy, appExhaustedUsage, 'RobloxPlayerBeta.exe');
    expect(decision.shouldKillApp).toBe(true);
    expect(decision.shouldLogoffUser).toBe(false);
    expect(decision.reason).toBe('APP_LIMIT_EXHAUSTED');
  });

  it('kills app when category limit is exhausted', () => {
    const catExhaustedUsage: DailyUsageSummary = {
      ...emptyUsage,
      categorySeconds: {
        ...emptyUsage.categorySeconds,
        Games: 3600 // hit 1 hr game limit
      }
    };
    const decision = evaluateEnforcement(mockPolicy, catExhaustedUsage, 'Minecraft.exe');
    expect(decision.shouldKillApp).toBe(true);
    expect(decision.shouldLogoffUser).toBe(false);
    expect(decision.reason).toBe('CATEGORY_LIMIT_EXHAUSTED');
  });

  it('forces user logoff when global machine limit is reached', () => {
    const globalExhaustedUsage: DailyUsageSummary = {
      ...emptyUsage,
      totalActiveSeconds: 7200 // hit 2 hr global limit
    };
    const decision = evaluateEnforcement(mockPolicy, globalExhaustedUsage, 'chrome.exe');
    expect(decision.shouldKillApp).toBe(true);
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('GLOBAL_LIMIT_EXHAUSTED');
  });

  it('enforces bedtime schedule lock', () => {
    const bedtimePolicy: DevicePolicy = {
      ...mockPolicy,
      bedtime: {
        enabled: true,
        startHour: 21,
        startMinute: 0,
        endHour: 7,
        endMinute: 0
      }
    };

    // isBedtimeActive reads wall-clock via UTC getters; pass explicit UTC instants.
    const nightTime = new Date('2026-08-23T22:30:00Z'); // 10:30 PM local
    expect(isBedtimeActive(bedtimePolicy, nightTime)).toBe(true);

    const dayTime = new Date('2026-08-23T14:00:00Z'); // 2:00 PM local
    expect(isBedtimeActive(bedtimePolicy, dayTime)).toBe(false);

    const decision = evaluateEnforcement(bedtimePolicy, emptyUsage, 'chrome.exe', nightTime);
    expect(decision.shouldKillApp).toBe(true);
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('BEDTIME_CURFEW');
  });

  it('enforces session controls even on the desktop / lock screen / no window', () => {
    const bedtimePolicy: DevicePolicy = {
      ...mockPolicy,
      bedtime: { enabled: true, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 }
    };
    const nightTime = new Date('2026-08-23T22:30:00Z');

    for (const surface of ['explorer.exe', 'lockapp.exe', '', '   ']) {
      // Curfew: logs off regardless of foreground, but does not kill the shell.
      const curfew = evaluateEnforcement(bedtimePolicy, emptyUsage, surface, nightTime);
      expect(curfew.shouldLogoffUser).toBe(true);
      expect(curfew.reason).toBe('BEDTIME_CURFEW');
      expect(curfew.shouldKillApp).toBe(false);

      // Emergency lock applies at the desktop too.
      const locked = evaluateEnforcement({ ...mockPolicy, emergencyLock: true }, emptyUsage, surface);
      expect(locked.shouldLogoffUser).toBe(true);
      expect(locked.reason).toBe('EMERGENCY_LOCK');

      // Global limit applies at the desktop too.
      const exhausted: DailyUsageSummary = { ...emptyUsage, totalActiveSeconds: 999999 };
      const overLimit = evaluateEnforcement(mockPolicy, exhausted, surface);
      expect(overLimit.shouldLogoffUser).toBe(true);
      expect(overLimit.reason).toBe('GLOBAL_LIMIT_EXHAUSTED');
    }

    // With no session control active, a bare desktop does nothing.
    const idleDesktop = evaluateEnforcement(mockPolicy, emptyUsage, 'explorer.exe');
    expect(idleDesktop.shouldLogoffUser).toBe(false);
    expect(idleDesktop.shouldKillApp).toBe(false);
  });
});
