export type AppCategory = 
  | 'Games' 
  | 'Browsers' 
  | 'Social' 
  | 'Media' 
  | 'Education' 
  | 'Productivity' 
  | 'System' 
  | 'Other';

export interface AppRule {
  executableName: string; // e.g. "RobloxPlayerBeta.exe" (case-insensitive)
  displayName: string;
  category: AppCategory;
  dailyLimitSeconds?: number; // custom override for this specific app
  isBlockedAlways?: boolean;
}

export interface CategoryLimit {
  category: AppCategory;
  dailyLimitSeconds: number; // e.g. 7200 for 2 hours
}

export interface BedtimeSchedule {
  enabled: boolean;
  startHour: number; // 0-23, e.g. 21 (9 PM)
  startMinute: number; // 0-59
  endHour: number; // 0-23, e.g. 7 (7 AM)
  endMinute: number;
}

export interface DevicePolicy {
  deviceId: string;
  dailyGlobalLimitSeconds: number; // Maximum total screen time across all apps (e.g. 14400 for 4 hours)
  warningThresholdSeconds: number; // 300 for 5 minutes
  emergencyLock: boolean; // Parent toggles instant lock
  bonusSecondsToday: number; // Extra granted time today
  bedtime: BedtimeSchedule;
  categoryLimits: CategoryLimit[];
  appRules: AppRule[];
}

export interface ActiveSession {
  deviceId: string;
  currentApp: string; // executable name e.g. "chrome.exe"
  windowTitle: string;
  category: AppCategory;
  isIdle: boolean;
  idleSeconds: number;
  lastHeartbeat: string; // ISO string
  connected: boolean;
}

export interface DailyUsageSummary {
  date: string; // YYYY-MM-DD
  deviceId: string;
  totalActiveSeconds: number;
  categorySeconds: Record<AppCategory, number>;
  appSeconds: Record<string, number>; // executableName -> seconds
}

export interface ClientHeartbeatPayload {
  deviceId: string;
  hostname: string;
  currentApp: string;
  windowTitle: string;
  isIdle: boolean;
  idleSeconds: number;
  elapsedActiveDeltaSeconds: number; // seconds spent in foreground since last heartbeat
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
