export type AppCategory = 
  | 'Games' 
  | 'Browsers' 
  | 'Social' 
  | 'Media' 
  | 'Education' 
  | 'Productivity' 
  | 'System' 
  | 'Other';

/**
 * The operating system family a device runs. A device that reports none is
 * Windows (installed Windows clients predate this field).
 */
export type Platform = 'windows' | 'macos';

export interface AppRule {
  // The app identifier, matched lowercased and exact: the executable name on
  // Windows (e.g. "RobloxPlayerBeta.exe"), the bundle identifier on macOS
  // (e.g. "com.roblox.RobloxPlayer"). The field name predates macOS support.
  executableName: string;
  displayName: string;
  category: AppCategory;
  dailyLimitSeconds?: number; // custom override for this specific app
  isBlockedAlways?: boolean;
}

export interface CategoryLimit {
  category: AppCategory;
  dailyLimitSeconds: number; // e.g. 7200 for 2 hours
  weekendOnly?: boolean; // blocked Mon-Fri (device-local); dailyLimitSeconds still applies on weekends
}

export interface BedtimeWindow {
  startHour: number; // 0-23, e.g. 21 (9 PM)
  startMinute: number; // 0-59
  endHour: number; // 0-23, e.g. 7 (7 AM)
  endMinute: number;
}

export interface BedtimeSchedule extends BedtimeWindow {
  enabled: boolean;
  // Optional per-weekday curfew (7 entries, 0=Sunday, device-local); null = use
  // the default window above. Each entry is the curfew that STARTS on that day,
  // so Friday's 22:00-08:00 covers Friday evening and Saturday morning.
  byWeekday?: (BedtimeWindow | null)[] | null;
}

export interface DevicePolicy {
  deviceId: string;
  dailyGlobalLimitSeconds: number; // Default max total screen time across all apps (e.g. 14400 for 4 hours)
  dailyLimitsByWeekday?: (number | null)[]; // Optional per-weekday limits (7 entries, 0=Sunday); null = use default
  warningThresholdSeconds: number; // 300 for 5 minutes
  emergencyLock: boolean; // Parent toggles instant lock
  bonusSecondsToday: number; // Today-only adjustment (may be negative); resets daily, never changes the base limit
  bonusDate?: string; // device-local YYYY-MM-DD that bonusSecondsToday belongs to; any other day reads as 0
  bedtime: BedtimeSchedule;
  categoryLimits: CategoryLimit[];
  appRules: AppRule[];
  // Device-reported platform. Optional in the type because policies stored
  // before macOS support lack it; the store fills in 'windows' on load and
  // on creation, so policies it returns always carry it. Server-owned: the
  // dashboard cannot change it.
  platform?: Platform;
  // Lowercased app identifier -> display name, learned from heartbeats so the
  // dashboard can label bundle identifiers readably. Display only, never
  // matched by rules. Server-owned and capped (see store).
  appDisplayNames?: Record<string, string>;
}

export interface ActiveSession {
  deviceId: string;
  currentApp: string; // app identifier, e.g. "chrome.exe" or "com.google.Chrome"
  appDisplayName?: string; // display name the client reported for currentApp (macOS)
  windowTitle: string;
  category: AppCategory;
  isIdle: boolean;
  idleSeconds: number;
  lastHeartbeat: string; // ISO string
  connected: boolean;
  utcOffsetMinutes?: number; // last reported device offset from UTC in minutes
  autoUpdate?: boolean; // last reported self-update state
  clientVersion?: string; // last reported client build version (e.g. "0.1.0")
  binaryHash?: string; // SHA-256 of the running client binary
  isLatest?: boolean | null; // whether binaryHash matches the latest release (null = unknown)
}

export interface DailyUsageSummary {
  date: string; // YYYY-MM-DD
  deviceId: string;
  totalActiveSeconds: number;
  categorySeconds: Record<AppCategory, number>;
  appSeconds: Record<string, number>; // lowercased app identifier -> seconds
}

export interface ClientHeartbeatPayload {
  deviceId: string;
  hostname: string;
  currentApp: string; // app identifier
  windowTitle: string;
  isIdle: boolean;
  idleSeconds: number;
  elapsedActiveDeltaSeconds: number; // seconds spent in foreground since last heartbeat
  utcOffsetMinutes?: number; // device's offset from UTC in minutes (e.g. +480 for UTC+8)
  autoUpdate?: boolean; // whether the client has self-update enabled
  clientVersion?: string; // client build version (e.g. "0.1.0")
  binaryHash?: string; // SHA-256 of the running client binary
  platform?: Platform; // validated platform from the heartbeat; absent = no information
  appDisplayName?: string; // display name of currentApp (macOS clients); display only
}

export interface TelemetryEvent {
  id: string;
  deviceId: string;
  timestamp: string;
  type: 'YOUTUBE' | 'IM_MESSAGE';
  app: string;
  titleOrText: string;
  details?: Record<string, unknown>;
}

export type ServerCommandAction = 
  | 'SYNC_POLICY'
  | 'GRANT_TIME'
  | 'LOCK_NOW'
  | 'UNLOCK'
  | 'KILL_APP'
  | 'SHOW_WARNING';

export interface ServerCommand {
  action: ServerCommandAction;
  targetApp?: string;
  extraSeconds?: number;
  message?: string;
  policy?: DevicePolicy;
}

export interface EnforcementDecision {
  shouldKillApp: boolean;
  shouldLogoffUser: boolean;
  shouldWarn: boolean;
  warningMessage?: string;
  reason?: string;
  remainingAppSeconds?: number;
  remainingGlobalSeconds?: number;
}

export interface AppActivityLog {
  id: string;
  deviceId: string;
  app: string;
  windowTitle: string;
  category: AppCategory;
  timestamp: string; // ISO 8601 (start time)
  endTime?: string; // ISO 8601 (end time of contiguous block)
  date: string; // YYYY-MM-DD
  hour: number; // 0..23
  durationSeconds: number;
}

export interface HourlyUsageSummary {
  hour: number; // 0..23
  totalSeconds: number;
  categorySeconds: Partial<Record<AppCategory, number>>;
  appSeconds: Record<string, number>;
}

