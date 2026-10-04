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
import { notifySlack } from '../notify/slack.js';

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
  private stmtUpdateActivityDuration!: StatementSync;
  private stmtGetSetting!: StatementSync;
  private stmtUpsertSetting!: StatementSync;

  private lastActivityMap: Map<string, { id: string; app: string; windowTitle: string; timestampMs: number; date: string }> = new Map();

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

    this.stmtUpdateActivityDuration = this.db.prepare(`
      UPDATE app_activity_logs
      SET duration_seconds = duration_seconds + ?,
          window_title = CASE WHEN ? != '' THEN ? ELSE window_title END
      WHERE id = ?;
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
    const needsPassword = !existingHash || process.env.RESET_PASSWORD === 'true';

    if (needsPassword) {
      const fromEnv = process.env.ADMIN_PASSWORD;
      if (fromEnv && fromEnv.length >= 8) {
        this.setPassword(fromEnv);
        console.warn('[watchtower] Dashboard password set from ADMIN_PASSWORD env.');
      } else {
        if (fromEnv) {
          console.warn('[watchtower] ADMIN_PASSWORD is too short (min 8 chars) — generating a random password instead.');
        }
        const generated = crypto.randomBytes(9).toString('base64url'); // 12-char URL-safe secret
        this.setPassword(generated);
        console.warn(
          '\n==================================================================\n' +
          ' 🛡️  WATCHTOWER: generated dashboard password (shown once)\n' +
          `     ${generated}\n` +
          '     Store it now, then change it from the dashboard.\n' +
          '     Set ADMIN_PASSWORD to control this value on first boot.\n' +
          '==================================================================\n'
        );
        // Deliver the one-time password to the private Slack channel so it can
        // be retrieved without digging through host logs.
        notifySlack(`🔑 Watchtower generated a new dashboard password (first boot / reset):\n\`${generated}\`\nStore it and change it from the dashboard.`);
      }
    }

    if (!this.getSetting('session_secret')) {
      this.setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
    }
    if (!this.getSetting('session_epoch')) {
      this.setSetting('session_epoch', '1');
    }
    // DEVICE_ENROLLMENT_SECRET, when provided, is authoritative on every boot
    // so the value is predictable for operators; otherwise keep the existing
    // one or generate a random secret on first boot.
    const envSecret = process.env.DEVICE_ENROLLMENT_SECRET;
    if (envSecret && envSecret.length >= 16) {
      if (this.getSetting('device_enrollment_secret') !== envSecret) {
        this.setSetting('device_enrollment_secret', envSecret);
      }
    } else if (!this.getSetting('device_enrollment_secret')) {
      this.setSetting('device_enrollment_secret', crypto.randomBytes(24).toString('hex'));
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

  // Local "today" for a device, using the last offset it reported (UTC if none).
  private localTodayForDevice(deviceId: string): string {
    const offsetMin = this.activeSessions.get(deviceId)?.utcOffsetMinutes ?? 0;
    return new Date(Date.now() + offsetMin * 60000).toISOString().split('T')[0];
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
    // Evaluate everything in the device's local time (bedtime, daily reset,
    // hour buckets) using the offset the client reports, so it is independent
    // of the server's timezone.
    const offsetMin = typeof payload.utcOffsetMinutes === 'number' ? payload.utcOffsetMinutes : 0;
    const localNow = new Date(Date.now() + offsetMin * 60000);
    const today = localNow.toISOString().split('T')[0];
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

      // Record chronological activity log or extend continuous activity block
      try {
        const now = new Date();
        const nowMs = now.getTime();
        const last = this.lastActivityMap.get(payload.deviceId);
        const winTitle = payload.windowTitle || '';

        // If same app, same date, and last recorded heartbeat was within 30 seconds, merge duration
        if (last && last.app === normApp && last.date === today && (nowMs - last.timestampMs) < 30000) {
          this.stmtUpdateActivityDuration.run(delta, winTitle, winTitle, last.id);
          last.timestampMs = nowMs;
          if (winTitle) {
            last.windowTitle = winTitle;
          }
        } else {
          // New continuous activity block
          const activityId = `${payload.deviceId}_${nowMs}_${Math.random().toString(36).substring(2, 7)}`;
          this.stmtInsertActivityLog.run(
            activityId,
            payload.deviceId,
            normApp,
            winTitle,
            category,
            now.toISOString(),
            today,
            localNow.getUTCHours(),
            delta
          );
          this.lastActivityMap.set(payload.deviceId, {
            id: activityId,
            app: normApp,
            windowTitle: winTitle,
            timestampMs: nowMs,
            date: today
          });
        }
      } catch (err) {
        console.error('Failed to insert/update activity log:', err);
      }
    } else if (payload.isIdle) {
      // User is idle, reset continuous session for next active app
      this.lastActivityMap.delete(payload.deviceId);
    }

    // Tamper signals: compare against the previous heartbeat's reported state.
    const prevSession = this.activeSessions.get(payload.deviceId);
    if (prevSession && typeof prevSession.utcOffsetMinutes === 'number'
        && prevSession.utcOffsetMinutes !== offsetMin) {
      notifySlack(`🕗 *${payload.deviceId}*: reported timezone offset changed ${prevSession.utcOffsetMinutes} → ${offsetMin} min (possible curfew-dodge).`);
    }
    if (payload.autoUpdate === false
        && (prevSession?.autoUpdate === undefined || prevSession.autoUpdate === true)) {
      notifySlack(`⚠️ *${payload.deviceId}*: client auto-update is DISABLED (tamper signal).`);
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
      connected: true,
      utcOffsetMinutes: offsetMin,
      autoUpdate: payload.autoUpdate
    });

    const decision = evaluateEnforcement(policy, usage, payload.currentApp, localNow);
    this.persistDailyUsage(usage);

    return { decision, policy, usage };
  }

  public getTimeline(deviceId: string, date: string = this.getTodayDateString(), limit: number = 1000, hour?: number): AppActivityLog[] {
    try {
      let sql = `
        SELECT id, device_id, app, window_title, category, timestamp, date, hour, duration_seconds
        FROM app_activity_logs
        WHERE device_id = ? AND date = ?
      `;
      const params: (string | number)[] = [deviceId, date];

      if (hour !== undefined && hour !== null) {
        sql += ` AND hour = ?\n`;
        params.push(hour);
      }

      sql += ` ORDER BY timestamp ASC;`;

      const rows = this.db.prepare(sql).all(...params) as Array<{
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

      if (rows.length === 0) return [];

      const coalesced: AppActivityLog[] = [];
      let current: AppActivityLog | null = null;

      for (const r of rows) {
        const itemTime = new Date(r.timestamp).getTime();
        const durationSec = Math.max(1, Number(r.duration_seconds));
        const itemEndTime = itemTime + durationSec * 1000;

        if (current) {
          const currentTime = new Date(current.timestamp).getTime();
          const currentEndTime = current.endTime ? new Date(current.endTime).getTime() : currentTime + current.durationSeconds * 1000;
          
          const gapMs = itemTime - currentEndTime;
          const isContiguous = gapMs >= -5000 && gapMs <= 90000;

          if (current.app.toLowerCase() === r.app.toLowerCase() && isContiguous) {
            current.durationSeconds += durationSec;
            current.endTime = new Date(Math.max(currentEndTime, itemEndTime)).toISOString();
            if (r.window_title && r.window_title.trim() && (!current.windowTitle || current.windowTitle === '<No title>' || current.windowTitle.length < r.window_title.length)) {
              current.windowTitle = r.window_title;
            }
            continue;
          } else {
            coalesced.push(current);
            current = null;
          }
        }

        current = {
          id: r.id,
          deviceId: r.device_id,
          app: r.app,
          windowTitle: r.window_title,
          category: r.category as AppCategory,
          timestamp: r.timestamp,
          endTime: new Date(itemEndTime).toISOString(),
          date: r.date,
          hour: Number(r.hour),
          durationSeconds: durationSec
        };
      }

      if (current) {
        coalesced.push(current);
      }

      return coalesced.reverse().slice(0, limit);
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

  private static readonly VALID_CATEGORIES: AppCategory[] = [
    'Games', 'Browsers', 'Social', 'Media', 'Education', 'Productivity', 'System', 'Other'
  ];

  public static isValidCategory(c: string): c is AppCategory {
    return (WatchtowerStore.VALID_CATEGORIES as string[]).includes(c);
  }

  /**
   * Persist an app -> category override on the device policy and retroactively
   * re-label stored activity so the timeline and category totals reflect it.
   */
  public reassignAppCategory(deviceId: string, app: string, newCategory: AppCategory): DevicePolicy {
    const norm = app.trim().toLowerCase();
    const policy = this.getPolicy(deviceId);
    const oldCategory = resolveAppCategory(norm, policy).category;

    // Upsert a policy rule (checked before the default knowledge base).
    const existing = policy.appRules.find(r => r.executableName.toLowerCase() === norm);
    if (existing) {
      existing.category = newCategory;
    } else {
      const known = DEFAULT_APP_RULES.find(r => r.executableName.toLowerCase() === norm);
      policy.appRules.push({
        executableName: app,
        displayName: known?.displayName || app,
        category: newCategory,
        ...(known?.dailyLimitSeconds ? { dailyLimitSeconds: known.dailyLimitSeconds } : {}),
        ...(known?.isBlockedAlways ? { isBlockedAlways: known.isBlockedAlways } : {})
      });
    }
    this.updatePolicy(policy);

    if (oldCategory === newCategory) {
      return policy;
    }

    // Re-label historical activity logs for this app.
    try {
      this.db.prepare(
        'UPDATE app_activity_logs SET category = ? WHERE device_id = ? AND LOWER(app) = ?;'
      ).run(newCategory, deviceId, norm);
    } catch (err) {
      console.error('Failed to re-label activity logs during category reassign:', err);
    }

    // Move this app's seconds between category buckets in every daily summary.
    for (const [key, usage] of this.dailyUsage) {
      if (usage.deviceId !== deviceId) continue;
      const secs = usage.appSeconds[norm] || 0;
      if (secs <= 0) continue;
      usage.categorySeconds[oldCategory] = Math.max(0, (usage.categorySeconds[oldCategory] || 0) - secs);
      usage.categorySeconds[newCategory] = (usage.categorySeconds[newCategory] || 0) + secs;
      this.persistDailyUsage(usage);
    }

    // Reflect on the live session if this app is currently foreground.
    const session = this.activeSessions.get(deviceId);
    if (session && (session.currentApp || '').trim().toLowerCase() === norm) {
      session.category = newCategory;
    }

    return policy;
  }

  // Adjust TODAY's screen time only, via the per-day bonus (which may go
  // negative to remove time for the day). This never changes the configured
  // base daily limit and resets with the day.
  public adjustTime(deviceId: string, deltaSeconds: number): DevicePolicy {
    const policy = this.getPolicy(deviceId);
    policy.bonusSecondsToday = (policy.bonusSecondsToday || 0) + deltaSeconds;
    this.updatePolicy(policy);
    return policy;
  }

  public setEmergencyLock(deviceId: string, locked: boolean): DevicePolicy {
    const policy = this.getPolicy(deviceId);
    policy.emergencyLock = locked;
    this.updatePolicy(policy);
    return policy;
  }

  // Permanently remove a device and all of its stored data.
  public deleteDevice(deviceId: string): void {
    // In-memory state
    this.policies.delete(deviceId);
    this.activeSessions.delete(deviceId);
    this.lastActivityMap.delete(deviceId);
    for (const key of [...this.dailyUsage.keys()]) {
      if (this.dailyUsage.get(key)?.deviceId === deviceId) {
        this.dailyUsage.delete(key);
      }
    }
    this.telemetryLogs = this.telemetryLogs.filter((e) => e.deviceId !== deviceId);

    // Persistent state
    try {
      this.db.prepare('DELETE FROM policies WHERE device_id = ?;').run(deviceId);
      this.db.prepare('DELETE FROM daily_usage WHERE device_id = ?;').run(deviceId);
      this.db.prepare('DELETE FROM app_activity_logs WHERE device_id = ?;').run(deviceId);
      this.db.prepare('DELETE FROM telemetry_events WHERE device_id = ?;').run(deviceId);
    } catch (err) {
      console.error('Failed to delete device from SQLite:', err);
    }
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

  public getTelemetry(deviceId?: string, limit: number = 50, date?: string, type?: string): TelemetryEvent[] {
    try {
      let query = 'SELECT data FROM telemetry_events WHERE 1=1';
      const params: any[] = [];
      if (deviceId) {
        query += ' AND device_id = ?';
        params.push(deviceId);
      }
      if (date) {
        query += ' AND timestamp LIKE ?';
        params.push(`${date}%`);
      }
      if (type) {
        query += ' AND type = ?';
        params.push(type);
      }
      query += ' ORDER BY timestamp DESC LIMIT ?;';
      params.push(limit);

      const rows = this.db.prepare(query).all(...params) as Array<{ data: string }>;
      return rows.map(r => JSON.parse(r.data));
    } catch (err) {
      console.error('Error fetching telemetry from SQLite:', err);
      let list = this.telemetryLogs;
      if (deviceId) {
        list = list.filter(e => e.deviceId === deviceId);
      }
      if (date) {
        list = list.filter(e => e.timestamp.startsWith(date));
      }
      if (type) {
        list = list.filter(e => e.type === type);
      }
      return list.slice(-limit).reverse();
    }
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
        usageToday: this.getDailyUsage(deviceId, this.localTodayForDevice(deviceId))
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

  private requireSecret(key: string): string {
    const secret = this.getSetting(key);
    if (!secret) {
      // Fail closed rather than signing with a predictable constant.
      throw new Error(`[watchtower] Missing required secret "${key}". Refusing to issue/verify tokens.`);
    }
    return secret;
  }

  private getSessionTtlMs(): number {
    const hours = parseInt(process.env.SESSION_TTL_HOURS || '4', 10);
    const safe = Number.isFinite(hours) && hours > 0 ? hours : 4;
    return safe * 60 * 60 * 1000;
  }

  private getSessionEpoch(): number {
    return parseInt(this.getSetting('session_epoch') || '1', 10) || 1;
  }

  /** Invalidate every existing session token (logout-all / password change). */
  public revokeAllSessions(): void {
    this.setSetting('session_epoch', String(this.getSessionEpoch() + 1));
  }

  public createSessionToken(): string {
    const secret = this.requireSecret('session_secret');
    const epoch = this.getSessionEpoch();
    // payload: issuedAtMs.epoch.nonce
    const payload = `${Date.now()}.${epoch}.${crypto.randomBytes(16).toString('hex')}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}.${signature}`;
  }

  public verifySessionToken(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return false;
    const payload = token.slice(0, idx);
    const signature = token.slice(idx + 1);

    const fields = payload.split('.');
    if (fields.length !== 3) return false;
    const [issuedAtStr, epochStr] = fields;

    let secret: string;
    try {
      secret = this.requireSecret('session_secret');
    } catch {
      return false;
    }

    try {
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      // Reject anything that isn't exactly the expected hex signature so a
      // tampered/padded suffix can't slip past lenient hex parsing.
      if (signature.length !== expectedSig.length) return false;
      const bufA = Buffer.from(signature, 'hex');
      const bufB = Buffer.from(expectedSig, 'hex');
      if (bufA.length !== bufB.length) return false;
      if (!crypto.timingSafeEqual(bufA, bufB)) return false;
    } catch {
      return false;
    }

    // Revocation check (epoch must match current)
    if (parseInt(epochStr, 10) !== this.getSessionEpoch()) return false;

    // Expiry check
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!Number.isFinite(issuedAt)) return false;
    if (Date.now() - issuedAt > this.getSessionTtlMs()) return false;

    return true;
  }

  // ---- Device enrollment & authentication (C1) ----

  public verifyEnrollmentSecret(secret: string): boolean {
    if (!secret || typeof secret !== 'string') return false;
    const expected = this.getSetting('device_enrollment_secret');
    if (!expected) return false;
    try {
      const bufA = Buffer.from(secret);
      const bufB = Buffer.from(expected);
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /** Long-lived token bound to a specific deviceId, signed with the server secret. */
  public createDeviceToken(deviceId: string): string {
    const secret = this.requireSecret('session_secret');
    const payload = `${deviceId}.${Date.now()}.${crypto.randomBytes(12).toString('hex')}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
  }

  public verifyDeviceToken(deviceId: string, token: string): boolean {
    if (!deviceId || !token || typeof token !== 'string') return false;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return false;
    const payloadB64 = token.slice(0, idx);
    const signature = token.slice(idx + 1);

    let payload: string;
    try {
      payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    } catch {
      return false;
    }

    let secret: string;
    try {
      secret = this.requireSecret('session_secret');
    } catch {
      return false;
    }

    try {
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      if (signature.length !== expectedSig.length) return false;
      const bufA = Buffer.from(signature, 'hex');
      const bufB = Buffer.from(expectedSig, 'hex');
      if (bufA.length !== bufB.length) return false;
      if (!crypto.timingSafeEqual(bufA, bufB)) return false;
    } catch {
      return false;
    }

    // The token must be bound to this exact deviceId.
    const boundDevice = payload.split('.')[0];
    return boundDevice === deviceId;
  }

  // ---- Short-lived, single-use WebSocket tickets (H3) ----
  // The dashboard exchanges its Bearer token for a ticket, then connects the
  // WebSocket with ?ticket=... . Tickets expire in seconds and are single-use,
  // so a token never rides in a URL and a leaked ticket is useless on replay.
  private wsTickets: Map<string, number> = new Map();
  private static readonly WS_TICKET_TTL_MS = 30_000;

  public createWsTicket(): string {
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.wsTickets.set(ticket, Date.now() + WatchtowerStore.WS_TICKET_TTL_MS);
    // Opportunistic cleanup of expired tickets.
    if (this.wsTickets.size > 100) {
      const now = Date.now();
      for (const [t, exp] of this.wsTickets) {
        if (exp < now) this.wsTickets.delete(t);
      }
    }
    return ticket;
  }

  public consumeWsTicket(ticket: string): boolean {
    if (!ticket || typeof ticket !== 'string') return false;
    const exp = this.wsTickets.get(ticket);
    if (exp === undefined) return false;
    this.wsTickets.delete(ticket); // single use
    return exp >= Date.now();
  }

  public close(): void {
    this.db.close();
  }
}

