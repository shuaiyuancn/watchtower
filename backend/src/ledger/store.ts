import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { 
  DevicePolicy, 
  DailyUsageSummary, 
  ActiveSession, 
  TelemetryEvent, 
  ClientHeartbeatPayload, 
  EnforcementDecision,
  AppActivityLog,
  HourlyUsageSummary,
  AppCategory
} from '../types.js';
import { 
  DEFAULT_APP_RULES, 
  evaluateEnforcement, 
  resolveAppCategory 
} from './rules.js';

export interface AppDatabaseLegacy {
  policies?: Record<string, DevicePolicy>;
  dailyUsage?: Record<string, DailyUsageSummary>;
  telemetry?: TelemetryEvent[];
}

export class WatchtowerStore {
  private db: DatabaseSync;
  private policies: Map<string, DevicePolicy> = new Map();
  private dailyUsage: Map<string, DailyUsageSummary> = new Map();
  private activeSessions: Map<string, ActiveSession> = new Map();
  private telemetryLogs: TelemetryEvent[] = [];

  private stmtUpsertPolicy!: StatementSync;
  private stmtUpsertDailyUsage!: StatementSync;
  private stmtInsertTelemetry!: StatementSync;
  private stmtInsertActivityLog!: StatementSync;
  private stmtGetSetting!: StatementSync;
  private stmtUpsertSetting!: StatementSync;

  constructor(storageDir?: string) {
    const dir = storageDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dbPath = path.join(dir, 'watchtower.db');
    this.db = new DatabaseSync(dbPath);

    // Performance & concurrency optimizations
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);

    this.initTables();
    this.initStatements();
    this.initSettings();
    this.migrateFromJsonIfNeeded(dir);
    this.loadFromDb();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policies (
        device_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_usage (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        date TEXT NOT NULL,
        total_active_seconds INTEGER NOT NULL DEFAULT 0,
        category_seconds TEXT NOT NULL,
        app_seconds TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_daily_usage_device_date ON daily_usage(device_id, date);

      CREATE TABLE IF NOT EXISTS app_activity_logs (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        app TEXT NOT NULL,
        window_title TEXT NOT NULL,
        category TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activity_device_date ON app_activity_logs(device_id, date);
      CREATE INDEX IF NOT EXISTS idx_activity_device_date_hour ON app_activity_logs(device_id, date, hour);
      CREATE INDEX IF NOT EXISTS idx_activity_device_timestamp ON app_activity_logs(device_id, timestamp);

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry_events(device_id, timestamp);
    `);
  }

  private initStatements(): void {
    this.stmtUpsertPolicy = this.db.prepare(`
      INSERT INTO policies (device_id, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at;
    `);

    this.stmtUpsertDailyUsage = this.db.prepare(`
      INSERT INTO daily_usage (id, device_id, date, total_active_seconds, category_seconds, app_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_active_seconds = excluded.total_active_seconds,
        category_seconds = excluded.category_seconds,
        app_seconds = excluded.app_seconds,
        updated_at = excluded.updated_at;
    `);

    this.stmtInsertTelemetry = this.db.prepare(`
      INSERT INTO telemetry_events (id, device_id, type, timestamp, data)
      VALUES (?, ?, ?, ?, ?);
    `);

    this.stmtInsertActivityLog = this.db.prepare(`
      INSERT INTO app_activity_logs (id, device_id, app, window_title, category, timestamp, date, hour, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    this.stmtGetSetting = this.db.prepare(`
      SELECT value FROM system_settings WHERE key = ?;
    `);

    this.stmtUpsertSetting = this.db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at;
    `);
  }

  private initSettings(): void {
    const existingHash = this.getSetting('dashboard_password_hash');
    const resetFlag = this.getSetting('password_reset_v1');
    if (!existingHash || !resetFlag || process.env.RESET_PASSWORD === 'true') {
      this.setPassword('0000');
      this.setSetting('password_reset_v1', 'true');
    }

    if (!this.getSetting('session_secret')) {
      this.setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
    }
  }

  private migrateFromJsonIfNeeded(dir: string): void {
    const jsonPath = path.join(dir, 'watchtower_data.json');
    if (!fs.existsSync(jsonPath)) return;

    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM policies;').get() as { count: number };
    if (countRow && countRow.count > 0) return;

    try {
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const parsed: AppDatabaseLegacy = JSON.parse(raw);
      const now = new Date().toISOString();

      if (parsed.policies) {
        for (const policy of Object.values(parsed.policies)) {
          this.stmtUpsertPolicy.run(policy.deviceId, JSON.stringify(policy), now);
        }
      }

      if (parsed.dailyUsage) {
        for (const usage of Object.values(parsed.dailyUsage)) {
          const key = this.getUsageKey(usage.deviceId, usage.date);
          this.stmtUpsertDailyUsage.run(
            key,
            usage.deviceId,
            usage.date,
            usage.totalActiveSeconds,
            JSON.stringify(usage.categorySeconds || {}),
            JSON.stringify(usage.appSeconds || {}),
            now
          );
        }
      }

      if (Array.isArray(parsed.telemetry)) {
        for (const item of parsed.telemetry) {
          this.stmtInsertTelemetry.run(
            item.id,
            item.deviceId,
            item.type,
            item.timestamp,
            JSON.stringify(item)
          );
        }
      }

      fs.renameSync(jsonPath, `${jsonPath}.migrated`);
      console.log('Successfully migrated legacy JSON database to SQLite!');
    } catch (err) {
      console.error('Failed migrating legacy JSON database to SQLite:', err);
    }
  }

  private loadFromDb(): void {
    // 1. Load policies
    const policyRows = this.db.prepare('SELECT device_id, data FROM policies;').all() as Array<{
      device_id: string;
      data: string;
    }>;
    for (const row of policyRows) {
      try {
        const policy: DevicePolicy = JSON.parse(row.data);
        this.policies.set(row.device_id, policy);
      } catch (e) {
        console.error('Error parsing policy from SQLite:', e);
      }
    }

    // 2. Load today's and recent daily usage
    const usageRows = this.db.prepare('SELECT id, device_id, date, total_active_seconds, category_seconds, app_seconds FROM daily_usage;').all() as Array<{
      id: string;
      device_id: string;
      date: string;
      total_active_seconds: number;
      category_seconds: string;
      app_seconds: string;
    }>;
    for (const row of usageRows) {
      try {
        const usage: DailyUsageSummary = {
          deviceId: row.device_id,
          date: row.date,
          totalActiveSeconds: Number(row.total_active_seconds),
          categorySeconds: JSON.parse(row.category_seconds || '{}'),
          appSeconds: JSON.parse(row.app_seconds || '{}')
        };
        this.dailyUsage.set(row.id, usage);
      } catch (e) {
        console.error('Error parsing daily usage from SQLite:', e);
      }
    }

    // 3. Load latest telemetry events
    const telemetryRows = this.db.prepare('SELECT data FROM telemetry_events ORDER BY timestamp DESC LIMIT 500;').all() as Array<{
      data: string;
    }>;
    this.telemetryLogs = [];
    for (const row of telemetryRows.reverse()) {
      try {
        this.telemetryLogs.push(JSON.parse(row.data));
      } catch (e) {
        console.error('Error parsing telemetry from SQLite:', e);
      }
    }
  }

  private getTodayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  private getUsageKey(deviceId: string, dateStr: string): string {
    return `${deviceId}_${dateStr}`;
  }

  public getPolicy(deviceId: string): DevicePolicy {
    let policy = this.policies.get(deviceId);
    if (!policy) {
      // Create default policy for new device (unlimited measurement defaults)
      policy = {
        deviceId,
        dailyGlobalLimitSeconds: 86400, // 24 hours (unlimited baseline)
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
        categoryLimits: [],
        appRules: [...DEFAULT_APP_RULES]
      };
      this.updatePolicy(policy);
    }
    return policy;
  }

  public updatePolicy(policy: DevicePolicy): DevicePolicy {
    this.policies.set(policy.deviceId, policy);
    const now = new Date().toISOString();
    this.stmtUpsertPolicy.run(policy.deviceId, JSON.stringify(policy), now);
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

  private persistDailyUsage(usage: DailyUsageSummary): void {
    const key = this.getUsageKey(usage.deviceId, usage.date);
    const now = new Date().toISOString();
    this.stmtUpsertDailyUsage.run(
      key,
      usage.deviceId,
      usage.date,
      usage.totalActiveSeconds,
      JSON.stringify(usage.categorySeconds),
      JSON.stringify(usage.appSeconds),
      now
    );
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

      // Record chronological activity log
      try {
        const now = new Date();
        const activityId = `${payload.deviceId}_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`;
        this.stmtInsertActivityLog.run(
          activityId,
          payload.deviceId,
          normApp,
          payload.windowTitle || '',
          category,
          now.toISOString(),
          today,
          now.getHours(),
          delta
        );
      } catch (err) {
        console.error('Failed to insert activity log:', err);
      }
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
    this.persistDailyUsage(usage);

    return { decision, policy, usage };
  }

  public getTimeline(deviceId: string, date: string = this.getTodayDateString(), limit: number = 100): AppActivityLog[] {
    try {
      const rows = this.db.prepare(`
        SELECT id, device_id, app, window_title, category, timestamp, date, hour, duration_seconds
        FROM app_activity_logs
        WHERE device_id = ? AND date = ?
        ORDER BY timestamp DESC
        LIMIT ?;
      `).all(deviceId, date, limit) as Array<{
        id: string;
        device_id: string;
        app: string;
        window_title: string;
        category: string;
        timestamp: string;
        date: string;
        hour: number;
        duration_seconds: number;
      }>;

      return rows.map(r => ({
        id: r.id,
        deviceId: r.device_id,
        app: r.app,
        windowTitle: r.window_title,
        category: r.category as AppCategory,
        timestamp: r.timestamp,
        date: r.date,
        hour: Number(r.hour),
        durationSeconds: Number(r.duration_seconds)
      }));
    } catch (err) {
      console.error('Error fetching timeline from SQLite:', err);
      return [];
    }
  }

  public getHourlyBreakdown(deviceId: string, date: string = this.getTodayDateString()): HourlyUsageSummary[] {
    const hourlyMap = new Map<number, HourlyUsageSummary>();
    for (let h = 0; h < 24; h++) {
      hourlyMap.set(h, {
        hour: h,
        totalSeconds: 0,
        categorySeconds: {},
        appSeconds: {}
      });
    }

    try {
      const rows = this.db.prepare(`
        SELECT hour, app, category, SUM(duration_seconds) as total_seconds
        FROM app_activity_logs
        WHERE device_id = ? AND date = ?
        GROUP BY hour, app, category
        ORDER BY hour ASC;
      `).all(deviceId, date) as Array<{
        hour: number;
        app: string;
        category: string;
        total_seconds: number;
      }>;

      for (const row of rows) {
        const h = Number(row.hour);
        const entry = hourlyMap.get(h);
        if (entry) {
          const secs = Number(row.total_seconds);
          const cat = row.category as AppCategory;
          entry.totalSeconds += secs;
          entry.categorySeconds[cat] = (entry.categorySeconds[cat] || 0) + secs;
          entry.appSeconds[row.app] = (entry.appSeconds[row.app] || 0) + secs;
        }
      }
    } catch (err) {
      console.error('Error fetching hourly breakdown from SQLite:', err);
    }

    return Array.from(hourlyMap.values());
  }

  public getDailyHistory(deviceId: string, days: number = 14): DailyUsageSummary[] {
    try {
      const rows = this.db.prepare(`
        SELECT id, device_id, date, total_active_seconds, category_seconds, app_seconds
        FROM daily_usage
        WHERE device_id = ?
        ORDER BY date DESC
        LIMIT ?;
      `).all(deviceId, days) as Array<{
        id: string;
        device_id: string;
        date: string;
        total_active_seconds: number;
        category_seconds: string;
        app_seconds: string;
      }>;

      return rows.map(r => ({
        deviceId: r.device_id,
        date: r.date,
        totalActiveSeconds: Number(r.total_active_seconds),
        categorySeconds: JSON.parse(r.category_seconds || '{}'),
        appSeconds: JSON.parse(r.app_seconds || '{}')
      }));
    } catch (err) {
      console.error('Error fetching daily history from SQLite:', err);
      return [];
    }
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
    this.stmtInsertTelemetry.run(
      fullEvent.id,
      fullEvent.deviceId,
      fullEvent.type,
      fullEvent.timestamp,
      JSON.stringify(fullEvent)
    );
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

  public getSetting(key: string): string | null {
    try {
      const row = this.stmtGetSetting.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  public setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.stmtUpsertSetting.run(key, value, now);
  }

  public verifyPassword(password: string): boolean {
    if (!password || typeof password !== 'string') return false;
    const salt = this.getSetting('dashboard_password_salt');
    const hash = this.getSetting('dashboard_password_hash');
    if (!salt || !hash) return false;

    try {
      const computed = crypto.scryptSync(password, salt, 64).toString('hex');
      const bufA = Buffer.from(computed, 'hex');
      const bufB = Buffer.from(hash, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  public setPassword(newPassword: string): void {
    if (!newPassword || typeof newPassword !== 'string') {
      throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    this.setSetting('dashboard_password_salt', salt);
    this.setSetting('dashboard_password_hash', hash);
  }

  public createSessionToken(): string {
    const secret = this.getSetting('session_secret') || 'default-watchtower-secret';
    const payload = `${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}.${signature}`;
  }

  public verifySessionToken(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    const secret = this.getSetting('session_secret') || 'default-watchtower-secret';
    try {
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const bufA = Buffer.from(signature, 'hex');
      const bufB = Buffer.from(expectedSig, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  public close(): void {
    this.db.close();
  }
}

