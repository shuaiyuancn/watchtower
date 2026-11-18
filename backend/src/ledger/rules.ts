import { 
  AppCategory, 
  AppRule,
  BedtimeWindow,
  DevicePolicy,
  DailyUsageSummary, 
  EnforcementDecision,
  Platform
} from '../types.js';

/**
 * Read a platform from untrusted input (WebSocket query or HEARTBEAT field).
 * Anything other than the two known values is treated as absent.
 */
export function parsePlatform(v: unknown): Platform | undefined {
  return v === 'windows' || v === 'macos' ? v : undefined;
}

/** A policy's platform; policies stored before macOS support are Windows. */
export function policyPlatform(policy: Pick<DevicePolicy, 'platform'>): Platform {
  return policy.platform === 'macos' ? 'macos' : 'windows';
}

/**
 * Common default app category mappings for Windows devices, by executable name.
 */
export const DEFAULT_APP_RULES: AppRule[] = [
  // Games
  { executableName: 'RobloxPlayerBeta.exe', displayName: 'Roblox', category: 'Games' },
  { executableName: 'Minecraft.exe', displayName: 'Minecraft', category: 'Games' },
  { executableName: 'javaw.exe', displayName: 'Minecraft (Java)', category: 'Games' },
  { executableName: 'FortniteClient-Win64-Shipping.exe', displayName: 'Fortnite', category: 'Games' },
  { executableName: 'Steam.exe', displayName: 'Steam Client', category: 'Games' },
  { executableName: 'GenshinImpact.exe', displayName: 'Genshin Impact', category: 'Games' },
  { executableName: 'VALORANT-Win64-Shipping.exe', displayName: 'Valorant', category: 'Games' },
  { executableName: 'LeagueClientUx.exe', displayName: 'League of Legends', category: 'Games' },
  
  // Browsers
  { executableName: 'chrome.exe', displayName: 'Google Chrome', category: 'Browsers' },
  { executableName: 'msedge.exe', displayName: 'Microsoft Edge', category: 'Browsers' },
  { executableName: 'firefox.exe', displayName: 'Mozilla Firefox', category: 'Browsers' },
  { executableName: 'brave.exe', displayName: 'Brave Browser', category: 'Browsers' },
  { executableName: 'zen.exe', displayName: 'Zen Browser', category: 'Browsers' },
  { executableName: 'opera.exe', displayName: 'Opera', category: 'Browsers' },
  { executableName: 'vivaldi.exe', displayName: 'Vivaldi', category: 'Browsers' },
  { executableName: 'arc.exe', displayName: 'Arc Browser', category: 'Browsers' },
  
  // Social & IM
  { executableName: 'Discord.exe', displayName: 'Discord', category: 'Social' },
  { executableName: 'Telegram.exe', displayName: 'Telegram', category: 'Social' },
  { executableName: 'WeChat.exe', displayName: 'WeChat', category: 'Social' },
  { executableName: 'WhatsApp.exe', displayName: 'WhatsApp Desktop', category: 'Social' },
  { executableName: 'QQ.exe', displayName: 'QQ', category: 'Social' },
  
  // Media
  { executableName: 'Spotify.exe', displayName: 'Spotify', category: 'Media' },
  { executableName: 'vlc.exe', displayName: 'VLC Media Player', category: 'Media' },
  
  // Productivity / Education
  { executableName: 'Code.exe', displayName: 'Visual Studio Code', category: 'Productivity' },
  { executableName: 'WINWORD.EXE', displayName: 'Microsoft Word', category: 'Education' },
  { executableName: 'POWERPNT.EXE', displayName: 'Microsoft PowerPoint', category: 'Education' },
  { executableName: 'EXCEL.EXE', displayName: 'Microsoft Excel', category: 'Education' },
  { executableName: 'Anki.exe', displayName: 'Anki', category: 'Education' }
];

/**
 * Default app category mappings for macOS devices, by bundle identifier. Same
 * categories as the Windows list, with well-known Mac apps.
 */
export const MAC_DEFAULT_APP_RULES: AppRule[] = [
  // Games
  { executableName: 'com.roblox.RobloxPlayer', displayName: 'Roblox', category: 'Games' },
  { executableName: 'com.mojang.minecraftlauncher', displayName: 'Minecraft Launcher', category: 'Games' },
  { executableName: 'com.valvesoftware.steam', displayName: 'Steam Client', category: 'Games' },

  // Browsers
  { executableName: 'com.apple.Safari', displayName: 'Safari', category: 'Browsers' },
  { executableName: 'com.google.Chrome', displayName: 'Google Chrome', category: 'Browsers' },
  { executableName: 'org.mozilla.firefox', displayName: 'Mozilla Firefox', category: 'Browsers' },
  { executableName: 'com.microsoft.edgemac', displayName: 'Microsoft Edge', category: 'Browsers' },
  { executableName: 'com.brave.Browser', displayName: 'Brave Browser', category: 'Browsers' },
  { executableName: 'com.operasoftware.Opera', displayName: 'Opera', category: 'Browsers' },
  { executableName: 'com.vivaldi.Vivaldi', displayName: 'Vivaldi', category: 'Browsers' },
  { executableName: 'company.thebrowser.Browser', displayName: 'Arc Browser', category: 'Browsers' },

  // Social & IM
  { executableName: 'com.hnc.Discord', displayName: 'Discord', category: 'Social' },
  { executableName: 'net.whatsapp.WhatsApp', displayName: 'WhatsApp', category: 'Social' },
  { executableName: 'com.apple.MobileSMS', displayName: 'Messages', category: 'Social' },
  { executableName: 'com.apple.FaceTime', displayName: 'FaceTime', category: 'Social' },
  { executableName: 'com.tencent.xinWeChat', displayName: 'WeChat', category: 'Social' },

  // Media
  { executableName: 'com.spotify.client', displayName: 'Spotify', category: 'Media' },
  { executableName: 'com.apple.Music', displayName: 'Music', category: 'Media' },
  { executableName: 'com.apple.TV', displayName: 'TV', category: 'Media' },
  { executableName: 'org.videolan.vlc', displayName: 'VLC Media Player', category: 'Media' },

  // Productivity / Education
  { executableName: 'com.microsoft.VSCode', displayName: 'Visual Studio Code', category: 'Productivity' },
  { executableName: 'com.apple.Terminal', displayName: 'Terminal', category: 'Productivity' },
  { executableName: 'com.microsoft.Word', displayName: 'Microsoft Word', category: 'Education' },
  { executableName: 'com.microsoft.Powerpoint', displayName: 'Microsoft PowerPoint', category: 'Education' },
  { executableName: 'com.microsoft.Excel', displayName: 'Microsoft Excel', category: 'Education' },
  { executableName: 'com.apple.iWork.Pages', displayName: 'Pages', category: 'Education' },
  { executableName: 'com.apple.iWork.Numbers', displayName: 'Numbers', category: 'Education' },
  { executableName: 'com.apple.iWork.Keynote', displayName: 'Keynote', category: 'Education' },

  // System
  { executableName: 'com.apple.systempreferences', displayName: 'System Settings', category: 'System' }
];

/** The built-in app rules for a platform (shared; copy before storing). */
export function defaultAppRulesFor(platform: Platform | undefined): AppRule[] {
  return platform === 'macos' ? MAC_DEFAULT_APP_RULES : DEFAULT_APP_RULES;
}

/** A fresh copy of a platform's default rules, safe to store on a policy. */
export function seedAppRules(platform: Platform | undefined): AppRule[] {
  return defaultAppRulesFor(platform).map((r) => ({ ...r }));
}

function canonicalRule(r: AppRule): string {
  return JSON.stringify([
    r.executableName,
    r.displayName,
    r.category,
    r.dailyLimitSeconds ?? null,
    r.isBlockedAlways ?? null,
    Object.keys(r).length
  ]);
}

/**
 * True when `rules` is still exactly the platform's untouched default list
 * (same rules in the same order, nothing edited, added or removed).
 */
export function isUntouchedDefaultRules(rules: AppRule[], platform: Platform): boolean {
  const defaults = defaultAppRulesFor(platform);
  if (!Array.isArray(rules) || rules.length !== defaults.length) return false;
  return rules.every((r, i) => canonicalRule(r) === canonicalRule(defaults[i]));
}

/**
 * App identifiers that are "system surfaces" (desktop shell, lock or login
 * screen). App and category rules are skipped for these, and for the empty
 * string (no focused app).
 */
const SYSTEM_SURFACES = new Set([
  'explorer.exe',          // Windows desktop shell
  'lockapp.exe',           // Windows lock screen
  'com.apple.finder',      // macOS Finder and desktop
  'com.apple.loginwindow'  // macOS lock and login screen
]);

export function isSystemSurface(appIdentifier: string): boolean {
  const norm = appIdentifier.trim().toLowerCase();
  return !norm || SYSTEM_SURFACES.has(norm);
}

/** The word a warning uses for the device being locked. */
function lockedNoun(policy: DevicePolicy): string {
  return policyPlatform(policy) === 'macos' ? 'Mac' : 'PC';
}

/**
 * Resolve an app identifier (executable name on Windows, bundle identifier on
 * macOS) to its category. Lowercased exact match: the policy's rules first,
 * then the platform's built-in list.
 */
export function resolveAppCategory(executableName: string, policy: DevicePolicy): { category: AppCategory; rule?: AppRule } {
  const norm = executableName.trim().toLowerCase();
  
  // Check policy-specific rules first
  const customRule = policy.appRules.find(r => r.executableName.toLowerCase() === norm);
  if (customRule) {
    return { category: customRule.category, rule: customRule };
  }
  
  // Check the platform's default knowledge base
  const defaultRule = defaultAppRulesFor(policyPlatform(policy)).find(r => r.executableName.toLowerCase() === norm);
  if (defaultRule) {
    return { category: defaultRule.category, rule: defaultRule };
  }
  
  return { category: 'Other' };
}

/**
 * The base daily screen-time limit for the given day. If the policy defines a
 * per-weekday schedule (7 entries, index 0 = Sunday), that value wins; otherwise
 * the single dailyGlobalLimitSeconds applies. `now` is the device-local instant,
 * so getUTCDay() yields the device's local weekday.
 */
export function getBaseDailyLimitSeconds(policy: DevicePolicy, now: Date = new Date()): number {
  const schedule = policy.dailyLimitsByWeekday;
  if (Array.isArray(schedule) && schedule.length === 7) {
    const v = schedule[now.getUTCDay()];
    if (typeof v === 'number' && v >= 0) return v;
  }
  return policy.dailyGlobalLimitSeconds;
}

/** Saturday or Sunday on the device-local clock (`now` is already shifted). */
export function isWeekend(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  return day === 0 || day === 6;
}

function isClockValue(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/** A well-formed curfew window: whole hours 0-23 and minutes 0-59. */
export function isValidBedtimeWindow(w: unknown): w is BedtimeWindow {
  if (!w || typeof w !== 'object') return false;
  const x = w as Record<string, unknown>;
  return isClockValue(x.startHour, 23) && isClockValue(x.startMinute, 59)
    && isClockValue(x.endHour, 23) && isClockValue(x.endMinute, 59);
}

/**
 * Clean a per-weekday curfew list from untrusted input. Returns 7 entries
 * (valid window or null) or null when the list itself is unusable.
 */
export function normalizeBedtimeByWeekday(input: unknown): (BedtimeWindow | null)[] | null {
  if (!Array.isArray(input) || input.length !== 7) return null;
  return input.map((w) => (isValidBedtimeWindow(w)
    ? { startHour: w.startHour, startMinute: w.startMinute, endHour: w.endHour, endMinute: w.endMinute }
    : null));
}

/**
 * The curfew that starts on the given weekday (0 = Sunday): that day's override
 * if one is set and valid, otherwise the default window.
 */
export function getBedtimeWindow(policy: DevicePolicy, weekday: number): BedtimeWindow {
  const override = policy.bedtime.byWeekday?.[weekday];
  return isValidBedtimeWindow(override) ? override : policy.bedtime;
}

export function isBedtimeActive(policy: DevicePolicy, now: Date = new Date()): boolean {
  if (!policy.bedtime || !policy.bedtime.enabled) {
    return false;
  }

  // Read the wall-clock via UTC getters: callers pass a Date already shifted to
  // the device's local time, so this is timezone-independent of the server.
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weekday = now.getUTCDay();

  // Curfew that starts today.
  const today = getBedtimeWindow(policy, weekday);
  const start = today.startHour * 60 + today.startMinute;
  const end = today.endHour * 60 + today.endMinute;
  if (start > end) {
    // Overnight curfew (e.g. 21:00 to 07:00): tonight's part.
    if (currentMinutes >= start) return true;
  } else if (currentMinutes >= start && currentMinutes < end) {
    // Same-day curfew
    return true;
  }

  // Morning tail of the overnight curfew that started yesterday.
  const yesterday = getBedtimeWindow(policy, (weekday + 6) % 7);
  const yStart = yesterday.startHour * 60 + yesterday.startMinute;
  const yEnd = yesterday.endHour * 60 + yesterday.endMinute;
  return yStart > yEnd && currentMinutes < yEnd;
}

export function evaluateEnforcement(
  policy: DevicePolicy,
  usage: DailyUsageSummary,
  currentApp: string,
  now: Date = new Date()
): EnforcementDecision {
  const normApp = currentApp.trim().toLowerCase();
  // "System surfaces" (desktop shell, lock screen, no focused window). We skip
  // app/category-specific rules for these, but NOT the whole-session controls
  // below (emergency lock, bedtime curfew, global limit) — those must apply
  // even when the child is just sitting at the desktop.
  const onSystemSurface = isSystemSurface(normApp);

  // 1. Emergency Lock Check (applies regardless of foreground app). Lock only:
  // open apps are left running so no work is lost.
  if (policy.emergencyLock) {
    return {
      shouldKillApp: false,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: 'Screen time is currently locked by your parent.',
      reason: 'EMERGENCY_LOCK'
    };
  }

  // 2. Bedtime Curfew Check (applies regardless of foreground app). Lock only:
  // open apps are left running so no work is lost.
  if (isBedtimeActive(policy, now)) {
    return {
      shouldKillApp: false,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: `Bedtime curfew is active. ${lockedNoun(policy)} is locked.`,
      reason: 'BEDTIME_CURFEW'
    };
  }

  // 3. Global Screen Time Limit Check (applies regardless of foreground app)
  // Base limit can vary by weekday; today's bonus (which may be negative, i.e.
  // time removed for the day) adjusts only today's effective allowance and
  // never the configured base.
  const baseDailyLimit = getBaseDailyLimitSeconds(policy, now);
  const effectiveGlobalLimit = baseDailyLimit + (policy.bonusSecondsToday || 0);
  const remainingGlobalSeconds = Math.max(0, effectiveGlobalLimit - usage.totalActiveSeconds);

  // Enforce whenever a base limit is configured (even if a negative bonus has
  // pushed the effective allowance to zero). Lock only, like curfew.
  if (baseDailyLimit > 0 && remainingGlobalSeconds <= 0) {
    return {
      shouldKillApp: false,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: `Daily screen time limit reached! Locking ${lockedNoun(policy)}...`,
      reason: 'GLOBAL_LIMIT_EXHAUSTED',
      remainingGlobalSeconds: 0
    };
  }

  // Beyond here are app/category-specific checks; nothing to enforce on a bare
  // desktop or lock screen.
  if (onSystemSurface) {
    return {
      shouldKillApp: false,
      shouldLogoffUser: false,
      shouldWarn: false,
      remainingGlobalSeconds: Number.isFinite(remainingGlobalSeconds) ? remainingGlobalSeconds : undefined
    };
  }

  // 4. Resolve App and Category
  const { category, rule } = resolveAppCategory(normApp, policy);

  // 4a. Always Blocked App
  if (rule?.isBlockedAlways) {
    return {
      shouldKillApp: true,
      shouldLogoffUser: false,
      shouldWarn: true,
      warningMessage: `${rule.displayName || currentApp} is blocked.`,
      reason: 'APP_BLOCKED_ALWAYS'
    };
  }

  // 4b. Weekend-only Category (blocked Monday-Friday)
  const categoryLimitConfig = policy.categoryLimits.find(c => c.category === category);
  if (categoryLimitConfig?.weekendOnly && !isWeekend(now)) {
    return {
      shouldKillApp: true,
      shouldLogoffUser: false,
      shouldWarn: true,
      warningMessage: `${rule?.displayName || currentApp} (${category}) is only allowed on weekends.`,
      reason: 'CATEGORY_WEEKEND_ONLY'
    };
  }

  // 4c. App-Specific Limit
  let remainingAppSeconds = Infinity;
  if (rule && rule.dailyLimitSeconds && rule.dailyLimitSeconds > 0) {
    const usedAppSeconds = usage.appSeconds[normApp] || 0;
    remainingAppSeconds = Math.max(0, rule.dailyLimitSeconds - usedAppSeconds);
    if (remainingAppSeconds <= 0) {
      return {
        shouldKillApp: true,
        shouldLogoffUser: false,
        shouldWarn: true,
        warningMessage: `Daily time limit for ${rule.displayName || currentApp} reached.`,
        reason: 'APP_LIMIT_EXHAUSTED',
        remainingAppSeconds: 0
      };
    }
  }

  // 4d. Category Limit
  let remainingCategorySeconds = Infinity;
  if (categoryLimitConfig && categoryLimitConfig.dailyLimitSeconds > 0) {
    const usedCategorySeconds = usage.categorySeconds[category] || 0;
    remainingCategorySeconds = Math.max(0, categoryLimitConfig.dailyLimitSeconds - usedCategorySeconds);
    if (remainingCategorySeconds <= 0) {
      return {
        shouldKillApp: true,
        shouldLogoffUser: false,
        shouldWarn: true,
        warningMessage: `Daily limit for ${category} reached.`,
        reason: 'CATEGORY_LIMIT_EXHAUSTED',
        remainingAppSeconds: 0
      };
    }
  }

  // 5. 5-Minute Warning Thresholds (300 seconds default)
  const warnThreshold = policy.warningThresholdSeconds || 300;
  const smallestRemaining = Math.min(remainingGlobalSeconds, remainingAppSeconds, remainingCategorySeconds);

  if (smallestRemaining <= warnThreshold && smallestRemaining > 0) {
    const minsLeft = Math.ceil(smallestRemaining / 60);
    return {
      shouldKillApp: false,
      shouldLogoffUser: false,
      shouldWarn: true,
      warningMessage: `Warning: You have ${minsLeft} minute${minsLeft > 1 ? 's' : ''} of screen time remaining!`,
      reason: 'WARNING_THRESHOLD',
      remainingAppSeconds: Number.isFinite(remainingAppSeconds) ? remainingAppSeconds : undefined,
      remainingGlobalSeconds: Number.isFinite(remainingGlobalSeconds) ? remainingGlobalSeconds : undefined
    };
  }

  return {
    shouldKillApp: false,
    shouldLogoffUser: false,
    shouldWarn: false,
    remainingAppSeconds: Number.isFinite(remainingAppSeconds) ? remainingAppSeconds : undefined,
    remainingGlobalSeconds: Number.isFinite(remainingGlobalSeconds) ? remainingGlobalSeconds : undefined
  };
}
