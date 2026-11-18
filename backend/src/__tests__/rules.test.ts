import { describe, it, expect } from 'vitest';
import {
  evaluateEnforcement,
  isBedtimeActive,
  normalizeBedtimeByWeekday,
  resolveAppCategory,
  getBaseDailyLimitSeconds,
  parsePlatform,
  policyPlatform,
  defaultAppRulesFor,
  seedAppRules,
  isUntouchedDefaultRules,
  isSystemSurface,
  DEFAULT_APP_RULES,
  MAC_DEFAULT_APP_RULES
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

  it('locks the PC without killing apps when global limit is reached', () => {
    const globalExhaustedUsage: DailyUsageSummary = {
      ...emptyUsage,
      totalActiveSeconds: 7200 // hit 2 hr global limit
    };
    const decision = evaluateEnforcement(mockPolicy, globalExhaustedUsage, 'chrome.exe');
    expect(decision.shouldKillApp).toBe(false); // lock only; apps keep running
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('GLOBAL_LIMIT_EXHAUSTED');
  });

  it('enforces bedtime schedule lock without killing apps', () => {
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
    expect(decision.shouldKillApp).toBe(false); // lock only; apps keep running
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('BEDTIME_CURFEW');
  });

  it('applies a different curfew per weekday, keyed by the day the curfew starts', () => {
    const late = { startHour: 23, startMinute: 0, endHour: 9, endMinute: 0 };
    const policy: DevicePolicy = {
      ...mockPolicy,
      bedtime: {
        enabled: true,
        startHour: 21, startMinute: 0, endHour: 7, endMinute: 0, // default
        byWeekday: [null, null, null, null, null, late, late] // Fri + Sat nights
      }
    };
    const at = (iso: string) => isBedtimeActive(policy, new Date(iso));

    // 2026-08-21 is a Friday.
    expect(at('2026-08-21T06:00:00Z')).toBe(true);   // Fri morning: tail of Thursday's default curfew
    expect(at('2026-08-21T21:30:00Z')).toBe(false);  // Fri 21:30: Friday's curfew starts at 23:00
    expect(at('2026-08-21T23:30:00Z')).toBe(true);   // Fri 23:30
    expect(at('2026-08-22T08:00:00Z')).toBe(true);   // Sat 08:00: Friday's curfew runs to 09:00
    expect(at('2026-08-22T09:30:00Z')).toBe(false);  // Sat 09:30
    expect(at('2026-08-23T08:00:00Z')).toBe(true);   // Sun 08:00: tail of Saturday's curfew
    expect(at('2026-08-23T21:30:00Z')).toBe(true);   // Sun 21:30: back to the default
    expect(at('2026-08-24T08:00:00Z')).toBe(false);  // Mon 08:00: Sunday's default ended at 07:00

    expect(evaluateEnforcement(policy, emptyUsage, 'chrome.exe', new Date('2026-08-21T23:30:00Z')).reason)
      .toBe('BEDTIME_CURFEW');
  });

  it('handles same-day and malformed per-weekday curfews', () => {
    const base = { enabled: true, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 };

    // Wednesday has a daytime-only curfew, so Wednesday evening is free.
    const sameDay: DevicePolicy = {
      ...mockPolicy,
      bedtime: { ...base, byWeekday: [null, null, null, { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0 }, null, null, null] }
    };
    expect(isBedtimeActive(sameDay, new Date('2026-08-19T06:00:00Z'))).toBe(true);   // Wed 06:00: Tuesday's tail
    expect(isBedtimeActive(sameDay, new Date('2026-08-19T14:00:00Z'))).toBe(true);   // Wed 14:00
    expect(isBedtimeActive(sameDay, new Date('2026-08-19T22:00:00Z'))).toBe(false);  // Wed 22:00
    expect(isBedtimeActive(sameDay, new Date('2026-08-20T06:00:00Z'))).toBe(false);  // Thu 06:00: no overnight tail

    // A malformed entry falls back to the default window instead of disabling the curfew.
    const malformed = {
      ...mockPolicy,
      bedtime: { ...base, byWeekday: [null, null, null, null, null, { startHour: 99, startMinute: 0, endHour: 7, endMinute: 0 }, null] }
    } as DevicePolicy;
    expect(isBedtimeActive(malformed, new Date('2026-08-21T21:30:00Z'))).toBe(true);

    expect(normalizeBedtimeByWeekday('nope')).toBeNull();
    expect(normalizeBedtimeByWeekday([null, null])).toBeNull();
    expect(normalizeBedtimeByWeekday([
      null, { startHour: 22, startMinute: 30, endHour: 6, endMinute: 0, extra: 'x' }, { startHour: -1 }, 'x', null, null, null
    ])).toEqual([null, { startHour: 22, startMinute: 30, endHour: 6, endMinute: 0 }, null, null, null, null, null]);
  });

  it('emergency lock locks the PC without killing apps', () => {
    const decision = evaluateEnforcement({ ...mockPolicy, emergencyLock: true }, emptyUsage, 'chrome.exe');
    expect(decision.shouldKillApp).toBe(false); // lock only; apps keep running
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('EMERGENCY_LOCK');
  });

  it('uses a per-weekday base limit when configured', () => {
    // Sunday=0 ... Saturday=6. 2026-08-23 is a Sunday.
    const sunday = new Date('2026-08-23T12:00:00Z');
    const monday = new Date('2026-08-24T12:00:00Z');
    const weekdayPolicy: DevicePolicy = {
      ...mockPolicy,
      dailyGlobalLimitSeconds: 7200, // default 2h
      dailyLimitsByWeekday: [10800, null, null, null, null, null, 14400] // Sun 3h, Sat 4h, else default
    };
    expect(getBaseDailyLimitSeconds(weekdayPolicy, sunday)).toBe(10800);
    expect(getBaseDailyLimitSeconds(weekdayPolicy, monday)).toBe(7200); // falls back to default
    // No schedule -> always the default.
    expect(getBaseDailyLimitSeconds(mockPolicy, sunday)).toBe(7200);
  });

  it('removes time for the day via a negative bonus (base limit untouched)', () => {
    // 1h used, default base 2h, but today's bonus is -90m => effective 30m < used 60m.
    const usage: DailyUsageSummary = { ...emptyUsage, totalActiveSeconds: 3600 };
    const policy: DevicePolicy = { ...mockPolicy, bonusSecondsToday: -5400 };
    const decision = evaluateEnforcement(policy, usage, 'chrome.exe');
    expect(decision.shouldLogoffUser).toBe(true);
    expect(decision.reason).toBe('GLOBAL_LIMIT_EXHAUSTED');
  });

  it('enforces session controls even on the desktop / lock screen / no window', () => {
    const bedtimePolicy: DevicePolicy = {
      ...mockPolicy,
      bedtime: { enabled: true, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 }
    };
    const nightTime = new Date('2026-08-23T22:30:00Z');

    for (const surface of ['explorer.exe', 'lockapp.exe', '', '   ']) {
      // Curfew: locks regardless of foreground, without killing anything.
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
  it('blocks weekend-only categories Monday-Friday (device-local) and allows them on weekends', () => {
    const weekendPolicy: DevicePolicy = {
      ...mockPolicy,
      categoryLimits: [{ category: 'Games', dailyLimitSeconds: 3600, weekendOnly: true }]
    };
    const friday = new Date('2026-08-21T15:00:00Z');
    const saturday = new Date('2026-08-22T15:00:00Z');
    const sunday = new Date('2026-08-23T23:59:00Z');

    const blocked = evaluateEnforcement(weekendPolicy, emptyUsage, 'Minecraft.exe', friday);
    expect(blocked.shouldKillApp).toBe(true);
    expect(blocked.shouldLogoffUser).toBe(false);
    expect(blocked.reason).toBe('CATEGORY_WEEKEND_ONLY');
    expect(blocked.warningMessage).toContain('weekends');

    expect(evaluateEnforcement(weekendPolicy, emptyUsage, 'Minecraft.exe', saturday).shouldKillApp).toBe(false);
    expect(evaluateEnforcement(weekendPolicy, emptyUsage, 'Minecraft.exe', sunday).shouldKillApp).toBe(false);

    // The category's daily limit still applies on weekends.
    const gamesExhausted: DailyUsageSummary = { ...emptyUsage, categorySeconds: { ...emptyUsage.categorySeconds, Games: 3600 } };
    expect(evaluateEnforcement(weekendPolicy, gamesExhausted, 'Minecraft.exe', saturday).reason).toBe('CATEGORY_LIMIT_EXHAUSTED');

    // Other categories and the bare desktop are unaffected on weekdays.
    expect(evaluateEnforcement(weekendPolicy, emptyUsage, 'Code.exe', friday).shouldKillApp).toBe(false);
    expect(evaluateEnforcement(weekendPolicy, emptyUsage, 'explorer.exe', friday).shouldKillApp).toBe(false);
  });
});

describe('Platform and app identifiers', () => {
  const macPolicy: DevicePolicy = {
    deviceId: 'test-mac',
    platform: 'macos',
    dailyGlobalLimitSeconds: 7200,
    warningThresholdSeconds: 300,
    emergencyLock: false,
    bonusSecondsToday: 0,
    bedtime: { enabled: false, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 },
    categoryLimits: [{ category: 'Games', dailyLimitSeconds: 3600 }],
    appRules: [
      { executableName: 'com.roblox.RobloxPlayer', displayName: 'Roblox', category: 'Games', dailyLimitSeconds: 1800 },
      { executableName: 'com.example.BlockedGame', displayName: 'Blocked Game', category: 'Games', isBlockedAlways: true }
    ]
  };

  const usage = (over: Partial<DailyUsageSummary> = {}): DailyUsageSummary => ({
    date: '2026-08-23',
    deviceId: 'test-mac',
    totalActiveSeconds: 0,
    categorySeconds: { Games: 0, Browsers: 0, Social: 0, Media: 0, Education: 0, Productivity: 0, System: 0, Other: 0 },
    appSeconds: {},
    ...over
  });

  it('parses only the two known platforms', () => {
    expect(parsePlatform('windows')).toBe('windows');
    expect(parsePlatform('macos')).toBe('macos');
    for (const bad of ['MacOS', 'darwin', 'linux', '', ' macos', 1, null, undefined, {}, ['macos']]) {
      expect(parsePlatform(bad)).toBeUndefined();
    }
  });

  it('defaults a policy without a platform to windows', () => {
    expect(policyPlatform({})).toBe('windows');
    expect(policyPlatform({ platform: 'windows' })).toBe('windows');
    expect(policyPlatform({ platform: 'macos' })).toBe('macos');
    // A corrupt stored value is not trusted.
    expect(policyPlatform({ platform: 'beos' as never })).toBe('windows');
  });

  it('picks the default rule list by platform', () => {
    expect(defaultAppRulesFor(undefined)).toBe(DEFAULT_APP_RULES);
    expect(defaultAppRulesFor('windows')).toBe(DEFAULT_APP_RULES);
    expect(defaultAppRulesFor('macos')).toBe(MAC_DEFAULT_APP_RULES);
    // The Mac list is keyed by bundle identifier, with no executables in it.
    expect(MAC_DEFAULT_APP_RULES.some((r) => r.executableName.toLowerCase().endsWith('.exe'))).toBe(false);
    const ids = MAC_DEFAULT_APP_RULES.map((r) => r.executableName.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('seeds copies, so editing a seeded rule leaves the defaults alone', () => {
    const seeded = seedAppRules('macos');
    expect(seeded).toEqual(MAC_DEFAULT_APP_RULES);
    seeded[0].category = 'Other';
    expect(MAC_DEFAULT_APP_RULES[0].category).toBe('Games');
  });

  it('recognises untouched default rules and nothing else', () => {
    expect(isUntouchedDefaultRules(seedAppRules('windows'), 'windows')).toBe(true);
    expect(isUntouchedDefaultRules(seedAppRules('macos'), 'macos')).toBe(true);
    expect(isUntouchedDefaultRules(seedAppRules('macos'), 'windows')).toBe(false);

    const edited = seedAppRules('windows');
    edited[0] = { ...edited[0], dailyLimitSeconds: 600 };
    expect(isUntouchedDefaultRules(edited, 'windows')).toBe(false);

    expect(isUntouchedDefaultRules(seedAppRules('windows').slice(1), 'windows')).toBe(false);
    expect(isUntouchedDefaultRules([...seedAppRules('windows'), { executableName: 'x.exe', displayName: 'X', category: 'Other' }], 'windows')).toBe(false);
    expect(isUntouchedDefaultRules(seedAppRules('windows').reverse(), 'windows')).toBe(false);
    expect(isUntouchedDefaultRules([], 'windows')).toBe(false);
  });

  it('resolves a bundle identifier case-insensitively against the Mac defaults', () => {
    const p = { ...macPolicy, appRules: [] };
    expect(resolveAppCategory('com.google.chrome', p).category).toBe('Browsers');
    expect(resolveAppCategory('COM.APPLE.SAFARI', p).category).toBe('Browsers');
    expect(resolveAppCategory('com.hnc.Discord', p).category).toBe('Social');
    // Windows executables are not in a Mac device's knowledge base, and vice versa.
    expect(resolveAppCategory('chrome.exe', p).category).toBe('Other');
    expect(resolveAppCategory('com.google.Chrome', { ...p, platform: undefined }).category).toBe('Other');
    expect(resolveAppCategory('chrome.exe', { ...p, platform: undefined }).category).toBe('Browsers');
  });

  it('enforces rules on a bundle identifier with an exact lowercased match', () => {
    const blocked = evaluateEnforcement(macPolicy, usage(), 'com.example.blockedgame');
    expect(blocked.shouldKillApp).toBe(true);
    expect(blocked.reason).toBe('APP_BLOCKED_ALWAYS');

    // Usage is keyed by the lowercased identifier.
    const robloxDone = evaluateEnforcement(
      macPolicy,
      usage({ totalActiveSeconds: 1800, appSeconds: { 'com.roblox.robloxplayer': 1800 } }),
      'com.roblox.RobloxPlayer'
    );
    expect(robloxDone.reason).toBe('APP_LIMIT_EXHAUSTED');

    // A longer or shorter identifier does not match.
    expect(evaluateEnforcement(macPolicy, usage(), 'com.example.BlockedGame.helper').shouldKillApp).toBe(false);
    expect(evaluateEnforcement(macPolicy, usage(), 'com.example').shouldKillApp).toBe(false);
  });

  it('treats Finder and loginwindow as system surfaces, like explorer.exe and lockapp.exe', () => {
    for (const app of ['', '   ', 'explorer.exe', 'LockApp.exe', 'com.apple.finder', 'com.apple.Finder', 'com.apple.loginwindow']) {
      expect(isSystemSurface(app)).toBe(true);
    }
    expect(isSystemSurface('com.apple.Safari')).toBe(false);

    // A rule naming a system surface is not enforced on it...
    const p: DevicePolicy = {
      ...macPolicy,
      appRules: [{ executableName: 'com.apple.finder', displayName: 'Finder', category: 'Games', isBlockedAlways: true }]
    };
    expect(evaluateEnforcement(p, usage(), 'com.apple.finder').shouldKillApp).toBe(false);
    expect(evaluateEnforcement(p, usage(), 'com.apple.loginwindow').shouldKillApp).toBe(false);
    // ...but whole-device controls still lock it.
    expect(evaluateEnforcement({ ...p, emergencyLock: true }, usage(), 'com.apple.finder').shouldLogoffUser).toBe(true);
    expect(evaluateEnforcement(p, usage({ totalActiveSeconds: 7200 }), 'com.apple.loginwindow').shouldLogoffUser).toBe(true);
  });

  it('names the device in lock warnings by platform, keeping the Windows wording', () => {
    const exhausted = usage({ totalActiveSeconds: 7200 });
    expect(evaluateEnforcement(macPolicy, exhausted, 'com.apple.Safari').warningMessage)
      .toBe('Daily screen time limit reached! Locking Mac...');
    expect(evaluateEnforcement({ ...macPolicy, platform: undefined }, exhausted, 'chrome.exe').warningMessage)
      .toBe('Daily screen time limit reached! Locking PC...');

    const bedtime = { enabled: true, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 };
    const night = new Date('2026-08-24T22:00:00Z');
    expect(evaluateEnforcement({ ...macPolicy, bedtime }, usage(), 'com.apple.Safari', night).warningMessage)
      .toBe('Bedtime curfew is active. Mac is locked.');
    expect(evaluateEnforcement({ ...macPolicy, platform: 'windows', bedtime }, usage(), 'chrome.exe', night).warningMessage)
      .toBe('Bedtime curfew is active. PC is locked.');
  });
});
