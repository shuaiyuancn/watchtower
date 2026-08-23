import fs from 'fs';
import path from 'path';
import { 
  DevicePolicy, 
  DailyUsageSummary, 
  ActiveSession, 
  TelemetryEvent,
  ClientHeartbeatPayload,
  EnforcementDecision
} from '../types.js';
import { 
  DEFAULT_APP_RULES, 
  evaluateEnforcement, 
  resolveAppCategory 
} from './rules.js';

export interface AppDatabase {
  policies: Record<string, DevicePolicy>;
  dailyUsage: Record<string, DailyUsageSummary>; // key: `${deviceId}_${YYYY-MM-DD}`
  telemetry: TelemetryEvent[];
}

export class WatchtowerStore {
  private dataFilePath: string;
  private policies: Map<string, DevicePolicy> = new Map();
  private dailyUsage: Map<string, DailyUsageSummary> = new Map();
  private activeSessions: Map<string, ActiveSession> = new Map();
  private telemetryLogs: TelemetryEvent[] = [];

  constructor(storageDir?: string) {
    const dir = storageDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dataFilePath = path.join(dir, 'watchtower_data.json');
    this.load();
  }

  private getTodayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  private getUsageKey(deviceId: string, dateStr: string): string {
    return `${deviceId}_${dateStr}`;
  }

  private load(): void {
    if (fs.existsSync(this.dataFilePath)) {
      try {
        const raw = fs.readFileSync(this.dataFilePath, 'utf-8');
        const parsed: AppDatabase = JSON.parse(raw);
        if (parsed.policies) {
          for (const [k, v] of Object.entries(parsed.policies)) {
            this.policies.set(k, v);
          }
        }
        if (parsed.dailyUsage) {
          for (const [k, v] of Object.entries(parsed.dailyUsage)) {
            this.dailyUsage.set(k, v);
          }
        }
        if (Array.isArray(parsed.telemetry)) {
          this.telemetryLogs = parsed.telemetry.slice(-500); // keep last 500
        }
      } catch (err) {
        console.error('Failed to load database file, starting fresh:', err);
      }
    }
  }

  public save(): void {
    try {
      const db: AppDatabase = {
        policies: Object.fromEntries(this.policies.entries()),
        dailyUsage: Object.fromEntries(this.dailyUsage.entries()),
        telemetry: this.telemetryLogs.slice(-500)
      };
      fs.writeFileSync(this.dataFilePath, JSON.stringify(db, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save store to file:', err);
    }
  }

  public getPolicy(deviceId: string): DevicePolicy {
    let policy = this.policies.get(deviceId);
    if (!policy) {
      // Create default policy for new device
      policy = {
        deviceId,
        dailyGlobalLimitSeconds: 7200, // 2 hours default
        warningThresholdSeconds: 300, // 5 minutes
        emergencyLock: false,
        bonusSecondsToday: 0,
        bedtime: {
          enabled: true,
          startHour: 21,
          startMinute: 0,
          endHour: 7,
          endMinute: 0
        },
        categoryLimits: [
          { category: 'Games', dailyLimitSeconds: 3600 },
          { category: 'Social', dailyLimitSeconds: 3600 }
        ],
        appRules: [...DEFAULT_APP_RULES]
      };
      this.policies.set(deviceId, policy);
      this.save();
    }
    return policy;
  }

  public updatePolicy(policy: DevicePolicy): DevicePolicy {
    this.policies.set(policy.deviceId, policy);
    this.save();
    return policy;
  }

  public getDailyUsage(deviceId: string, dateStr: string = this.getTodayDateString()): DailyUsageSummary {
    const key = this.getUsageKey(deviceId, dateStr);
    let usage = this.dailyUsage.get(key);
    if (!usage) {
      usage = {
        date: dateStr,
        deviceId,
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
      this.dailyUsage.set(key, usage);
    }
    return usage;
  }

  public recordHeartbeat(payload: ClientHeartbeatPayload): {
    decision: EnforcementDecision;
    policy: DevicePolicy;
    usage: DailyUsageSummary;
  } {
    const today = this.getTodayDateString();
    const policy = this.getPolicy(payload.deviceId);
    const usage = this.getDailyUsage(payload.deviceId, today);

    const normApp = (payload.currentApp || '').trim().toLowerCase();
    const delta = Math.max(0, Math.min(payload.elapsedActiveDeltaSeconds || 0, 60)); // safety cap

    if (!payload.isIdle && delta > 0 && normApp) {
      // Accumulate active time
      usage.totalActiveSeconds += delta;
      
      const { category } = resolveAppCategory(normApp, policy);
      usage.categorySeconds[category] = (usage.categorySeconds[category] || 0) + delta;
      usage.appSeconds[normApp] = (usage.appSeconds[normApp] || 0) + delta;
    }

    // Update active session
    const { category } = resolveAppCategory(normApp, policy);
    this.activeSessions.set(payload.deviceId, {
      deviceId: payload.deviceId,
      currentApp: payload.currentApp,
      windowTitle: payload.windowTitle,
      category,
      isIdle: payload.isIdle,
      idleSeconds: payload.idleSeconds,
      lastHeartbeat: new Date().toISOString(),
      connected: true
    });

    const decision = evaluateEnforcement(policy, usage, payload.currentApp);
    this.save();

    return { decision, policy, usage };
  }

  public addBonusTime(deviceId: string, extraSeconds: number): DevicePolicy {
    const policy = this.getPolicy(deviceId);
    policy.bonusSecondsToday = (policy.bonusSecondsToday || 0) + extraSeconds;
    this.updatePolicy(policy);
    return policy;
  }

  public setEmergencyLock(deviceId: string, locked: boolean): DevicePolicy {
    const policy = this.getPolicy(deviceId);
    policy.emergencyLock = locked;
    this.updatePolicy(policy);
    return policy;
  }

  public recordTelemetry(event: Omit<TelemetryEvent, 'id'>): TelemetryEvent {
    const fullEvent: TelemetryEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    };
    this.telemetryLogs.push(fullEvent);
    if (this.telemetryLogs.length > 500) {
      this.telemetryLogs = this.telemetryLogs.slice(-500);
    }
    this.save();
    return fullEvent;
  }

  public getTelemetry(deviceId?: string, limit: number = 50): TelemetryEvent[] {
    let list = this.telemetryLogs;
    if (deviceId) {
      list = list.filter(e => e.deviceId === deviceId);
    }
    return list.slice(-limit).reverse();
  }

  public getActiveSession(deviceId: string): ActiveSession | undefined {
    return this.activeSessions.get(deviceId);
  }

  public getAllDevices(): Array<{
    deviceId: string;
    session?: ActiveSession;
    policy: DevicePolicy;
    usageToday: DailyUsageSummary;
  }> {
    const list: Array<{
      deviceId: string;
      session?: ActiveSession;
      policy: DevicePolicy;
      usageToday: DailyUsageSummary;
    }> = [];

    const deviceIds = new Set<string>([
      ...this.policies.keys(),
      ...this.activeSessions.keys()
    ]);

    for (const deviceId of deviceIds) {
      list.push({
        deviceId,
        session: this.activeSessions.get(deviceId),
        policy: this.getPolicy(deviceId),
        usageToday: this.getDailyUsage(deviceId)
      });
    }

    return list;
  }
}
