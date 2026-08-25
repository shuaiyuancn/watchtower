import { 
  AppCategory, 
  AppRule, 
  DevicePolicy, 
  DailyUsageSummary, 
  EnforcementDecision 
} from '../types.js';

/**
 * Common default app category mappings
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

export function resolveAppCategory(executableName: string, policy: DevicePolicy): { category: AppCategory; rule?: AppRule } {
  const norm = executableName.trim().toLowerCase();
  
  // Check policy-specific rules first
  const customRule = policy.appRules.find(r => r.executableName.toLowerCase() === norm);
  if (customRule) {
    return { category: customRule.category, rule: customRule };
  }
  
  // Check default knowledge base
  const defaultRule = DEFAULT_APP_RULES.find(r => r.executableName.toLowerCase() === norm);
  if (defaultRule) {
    return { category: defaultRule.category, rule: defaultRule };
  }
  
  return { category: 'Other' };
}

export function isBedtimeActive(policy: DevicePolicy, now: Date = new Date()): boolean {
  if (!policy.bedtime || !policy.bedtime.enabled) {
    return false;
  }
  
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = policy.bedtime.startHour * 60 + policy.bedtime.startMinute;
  const endMinutes = policy.bedtime.endHour * 60 + policy.bedtime.endMinute;
  
  if (startMinutes > endMinutes) {
    // Overnight curfew (e.g. 21:00 to 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } else {
    // Same-day curfew
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
}

export function evaluateEnforcement(
  policy: DevicePolicy,
  usage: DailyUsageSummary,
  currentApp: string,
  now: Date = new Date()
): EnforcementDecision {
  const normApp = currentApp.trim().toLowerCase();
  if (!normApp || normApp === 'explorer.exe' || normApp === 'lockapp.exe') {
    return { shouldKillApp: false, shouldLogoffUser: false, shouldWarn: false };
  }

  // 1. Emergency Lock Check
  if (policy.emergencyLock) {
    return {
      shouldKillApp: true,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: 'Screen time is currently locked by your parent.',
      reason: 'EMERGENCY_LOCK'
    };
  }

  // 2. Bedtime Curfew Check
  if (isBedtimeActive(policy, now)) {
    return {
      shouldKillApp: true,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: 'Bedtime curfew is active. PC is locked.',
      reason: 'BEDTIME_CURFEW'
    };
  }

  // 3. Global Screen Time Limit Check
  const effectiveGlobalLimit = policy.dailyGlobalLimitSeconds + (policy.bonusSecondsToday || 0);
  const remainingGlobalSeconds = Math.max(0, effectiveGlobalLimit - usage.totalActiveSeconds);

  if (effectiveGlobalLimit > 0 && remainingGlobalSeconds <= 0) {
    return {
      shouldKillApp: true,
      shouldLogoffUser: true,
      shouldWarn: true,
      warningMessage: 'Daily screen time limit reached! Locking PC...',
      reason: 'GLOBAL_LIMIT_EXHAUSTED',
      remainingGlobalSeconds: 0
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

  // 4b. App-Specific Limit
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

  // 4c. Category Limit
  let remainingCategorySeconds = Infinity;
  const categoryLimitConfig = policy.categoryLimits.find(c => c.category === category);
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
