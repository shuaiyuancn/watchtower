import { WebSocket } from 'ws';
import { z } from 'zod';
import { WatchtowerStore } from '../ledger/store.js';
import { notifySlack } from '../notify/slack.js';
import { getLatestBinaryHash, compareToLatest } from '../release/latest.js';
import {
  ClientHeartbeatPayload,
  ServerCommand,
  TelemetryEvent,
  DevicePolicy,
  Platform
} from '../types.js';
import { parsePlatform } from '../ledger/rules.js';

// Bound every field a client can send so a malicious or buggy client cannot
// exhaust storage or memory (M2).
const STR = (max: number) => z.string().max(max);

const HeartbeatSchema = z.object({
  type: z.literal('HEARTBEAT'),
  hostname: STR(128).optional(),
  currentApp: STR(260).optional(),
  windowTitle: STR(512).optional(),
  isIdle: z.boolean().optional(),
  idleSeconds: z.number().finite().min(0).max(86400).optional(),
  elapsedActiveDeltaSeconds: z.number().finite().min(0).max(86400).optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  autoUpdate: z.boolean().optional(),
  version: STR(32).optional(),
  binaryHash: STR(64).optional(),
  // 'windows' | 'macos'. Any other value is ignored (treated as absent) by
  // parsePlatform rather than rejecting the whole heartbeat.
  platform: z.unknown().optional(),
  // Display name of currentApp (macOS clients). Shown to the parent only.
  appDisplayName: STR(128).optional()
}).passthrough();

// Sent by a client that tried to lock the screen and found it did not lock
// (the macOS client verifies every lock).
const LockFailedSchema = z.object({
  type: z.literal('LOCK_FAILED'),
  reason: STR(256).optional()
}).passthrough();

// At most one lock-failure Slack alert per device in this window.
export const LOCK_FAILED_ALERT_INTERVAL_MS = 10 * 60 * 1000;

// Client text going into a Slack message: one line, no mrkdwn or <!channel>
// style mentions.
function sanitizeForSlack(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[<>&*_~`|]/g, '').trim().slice(0, 200);
}

const TelemetrySchema = z.object({
  type: z.literal('TELEMETRY'),
  telemetryType: z.enum(['YOUTUBE', 'IM_MESSAGE']).optional(),
  app: STR(128).optional(),
  titleOrText: STR(1024).optional(),
  details: z.record(z.any()).optional()
}).passthrough();

// Per-connection message rate limit.
const MAX_MSGS_PER_WINDOW = 60;
const RATE_WINDOW_MS = 10_000;

interface EnforcementState {
  warn: boolean;
  kill: boolean;
  logoff: boolean;
}

export class WebSocketHub {
  private store: WatchtowerStore;
  private clientSockets: Map<string, WebSocket> = new Map(); // deviceId -> socket
  private dashboardSockets: Set<WebSocket> = new Set(); // connected web dashboards
  // Last enforcement state per device, so we log only on the rising edge
  // (limit newly reached) instead of every 3s heartbeat.
  private enfState: Map<string, EnforcementState> = new Map();
  // When each device last raised a LOCK_FAILED Slack alert (debounce).
  private lockFailedAlertAt: Map<string, number> = new Map();

  constructor(store: WatchtowerStore) {
    this.store = store;
  }

  // `platform` comes from the connect URL (?platform=macos), already validated;
  // undefined for Windows clients, which send none.
  public registerClient(deviceId: string, ws: WebSocket, platform?: Platform): void {
    this.clientSockets.set(deviceId, ws);
    console.log(`[WS Hub] Device client connected: ${deviceId}${platform ? ` (${platform})` : ''}`);
    // Record the platform before the first SYNC_POLICY so a new Mac is seeded
    // with the Mac default rules.
    const platformChanged = this.store.reportPlatform(deviceId, platform);
    // The "device connected" Slack notice is deferred to the first heartbeat so
    // it can include the client's version and whether it is up to date.
    const conn = { announced: false };

    // Send initial policy sync immediately upon connection
    const policy = this.store.getPolicy(deviceId);
    this.sendCommandToClient(deviceId, {
      action: 'SYNC_POLICY',
      policy
    });

    this.broadcastToDashboards({
      type: 'DEVICE_CONNECTED',
      deviceId
    });
    if (platformChanged) {
      this.broadcastToDashboards({ type: 'POLICY_UPDATED', policy });
    }

    let msgCount = 0;
    let windowStart = Date.now();

    ws.on('message', (raw) => {
      // Per-connection flood protection (M2).
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        msgCount = 0;
      }
      if (++msgCount > MAX_MSGS_PER_WINDOW) {
        return; // silently drop; client is exceeding the allowed rate
      }

      // Cap raw frame size before parsing (guards against oversized payloads).
      const text = raw.toString();
      if (text.length > 8192) {
        console.warn(`[WS Hub] Oversized message from ${deviceId} dropped (${text.length} bytes)`);
        return;
      }

      try {
        const msg = JSON.parse(text);
        this.handleClientMessage(deviceId, msg, ws, conn);
      } catch (err) {
        console.error(`[WS Hub] Invalid message from ${deviceId}:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`[WS Hub] Device client disconnected: ${deviceId}`);
      // Only clear if this socket is still the registered one (avoid races with
      // a reconnect that already replaced it).
      if (this.clientSockets.get(deviceId) === ws) {
        this.clientSockets.delete(deviceId);
        // Reset enforcement edge-state so a re-login during curfew alerts again.
        this.enfState.delete(deviceId);
        notifySlack(`🔴 Watchtower device disconnected: *${deviceId}*`);
      }

      const session = this.store.getActiveSession(deviceId);
      if (session) {
        session.connected = false;
      }

      this.broadcastToDashboards({
        type: 'DEVICE_DISCONNECTED',
        deviceId,
        timestamp: new Date().toISOString()
      });
    });
  }

  public registerDashboard(ws: WebSocket): void {
    this.dashboardSockets.add(ws);
    console.log(`[WS Hub] Parent dashboard connected. Total dashboards: ${this.dashboardSockets.size}`);

    // Send full system snapshot to newly connected dashboard
    ws.send(JSON.stringify({
      type: 'INIT_STATE',
      devices: this.store.getAllDevices(),
      recentTelemetry: this.store.getTelemetry(undefined, 20)
    }));

    ws.on('close', () => {
      this.dashboardSockets.delete(ws);
    });
  }

  private logEnforcementTransitions(
    deviceId: string,
    decision: { shouldWarn: boolean; shouldKillApp: boolean; shouldLogoffUser: boolean; reason?: string; warningMessage?: string },
    currentApp: string
  ): void {
    const prev = this.enfState.get(deviceId) || { warn: false, kill: false, logoff: false };

    if (decision.shouldLogoffUser && !prev.logoff) {
      if (decision.reason === 'BEDTIME_CURFEW') {
        notifySlack(`🌙 *${deviceId}*: **in use during curfew** — locking screen.${currentApp ? ` (app: ${currentApp})` : ''}`);
      } else if (decision.reason === 'EMERGENCY_LOCK') {
        notifySlack(`🔒 *${deviceId}*: activity while emergency-locked — locking screen.`);
      } else {
        notifySlack(`⛔ *${deviceId}*: daily limit reached — locking screen.${decision.reason ? ` (${decision.reason})` : ''}`);
      }
    }
    if (decision.shouldKillApp && !prev.kill) {
      notifySlack(`🛑 *${deviceId}*: app limit reached — terminating *${currentApp || 'app'}*.${decision.reason ? ` (${decision.reason})` : ''}`);
    }
    if (decision.shouldWarn && !prev.warn) {
      notifySlack(`⏳ *${deviceId}*: ${decision.warningMessage || '5-minute warning — time almost up.'}`);
    }

    this.enfState.set(deviceId, {
      warn: decision.shouldWarn,
      kill: decision.shouldKillApp,
      logoff: decision.shouldLogoffUser
    });
  }

  // Resolve whether the just-connected device runs the latest release, then
  // record it on the session and announce the connection (version + up-to-date
  // hint) to Slack and the dashboards. Best-effort; never throws.
  private async announceClientConnect(
    deviceId: string,
    clientVersion: string | undefined,
    binaryHash: string | undefined
  ): Promise<void> {
    let isLatest: boolean | null = null;
    try {
      const latest = await getLatestBinaryHash();
      isLatest = compareToLatest(latest, binaryHash);
    } catch {
      isLatest = null;
    }

    this.store.markDeviceVersionStatus(deviceId, clientVersion, binaryHash, isLatest);

    const versionLabel = clientVersion ? `v${clientVersion}` : 'unknown version';
    const hint =
      isLatest === true
        ? '✅ up to date'
        : isLatest === false
          ? '⚠️ outdated — will auto-update within ~30m'
          : 'ℹ️ version status unknown';
    notifySlack(`🟢 Watchtower device connected: *${deviceId}* — ${versionLabel} (${hint})`);

    this.broadcastToDashboards({
      type: 'DEVICE_VERSION',
      deviceId,
      clientVersion: clientVersion ?? null,
      isLatest
    });
  }

  private handleClientMessage(deviceId: string, msg: any, ws: WebSocket, conn?: { announced: boolean }): void {
    if (msg?.type === 'HEARTBEAT') {
      const parsed = HeartbeatSchema.safeParse(msg);
      if (!parsed.success) {
        console.warn(`[WS Hub] Rejected malformed HEARTBEAT from ${deviceId}`);
        return;
      }
      const m = parsed.data;
      const payload: ClientHeartbeatPayload = {
        deviceId,
        hostname: m.hostname || 'Windows-PC',
        currentApp: m.currentApp || '',
        windowTitle: m.windowTitle || '',
        isIdle: Boolean(m.isIdle),
        idleSeconds: Number(m.idleSeconds || 0),
        elapsedActiveDeltaSeconds: Number(m.elapsedActiveDeltaSeconds || 0),
        utcOffsetMinutes: typeof m.utcOffsetMinutes === 'number' ? m.utcOffsetMinutes : undefined,
        autoUpdate: typeof m.autoUpdate === 'boolean' ? m.autoUpdate : undefined,
        clientVersion: typeof m.version === 'string' ? m.version : undefined,
        binaryHash: typeof m.binaryHash === 'string' ? m.binaryHash : undefined,
        platform: parsePlatform(m.platform),
        appDisplayName: typeof m.appDisplayName === 'string' ? m.appDisplayName : undefined
      };

      const { decision, policy, usage, policyChanged } = this.store.recordHeartbeat(payload);

      // First heartbeat of this connection: announce the device (with version
      // and whether it is up to date) to Slack and the dashboards, exactly once.
      if (conn && !conn.announced) {
        conn.announced = true;
        void this.announceClientConnect(deviceId, payload.clientVersion, payload.binaryHash);
      }

      // e.g. the daily bonus rolled over at device-local midnight
      if (policyChanged) {
        this.broadcastToDashboards({ type: 'POLICY_UPDATED', policy });
      }

      // Log enforcement events on their rising edge only.
      this.logEnforcementTransitions(deviceId, decision, payload.currentApp);

      // Reply back to client with heartbeat ACK and enforcement decision
      const response = {
        type: 'HEARTBEAT_ACK',
        decision,
        policyVersion: Date.now(),
        policy: {
          dailyGlobalLimitSeconds: policy.dailyGlobalLimitSeconds,
          bonusSecondsToday: policy.bonusSecondsToday,
          warningThresholdSeconds: policy.warningThresholdSeconds,
          emergencyLock: policy.emergencyLock
        }
      };
      ws.send(JSON.stringify(response));

      // Broadcast live update to all parent dashboards
      this.broadcastToDashboards({
        type: 'DEVICE_ACTIVITY_UPDATE',
        deviceId,
        session: this.store.getActiveSession(deviceId),
        usageToday: usage,
        decision
      });

    } else if (msg?.type === 'TELEMETRY') {
      const parsed = TelemetrySchema.safeParse(msg);
      if (!parsed.success) {
        console.warn(`[WS Hub] Rejected malformed TELEMETRY from ${deviceId}`);
        return;
      }
      const m = parsed.data;
      const event = this.store.recordTelemetry({
        deviceId,
        timestamp: new Date().toISOString(),
        type: m.telemetryType === 'YOUTUBE' ? 'YOUTUBE' : 'IM_MESSAGE',
        app: m.app || 'Unknown',
        titleOrText: m.titleOrText || '',
        details: m.details || {}
      });

      this.broadcastToDashboards({
        type: 'TELEMETRY_EVENT',
        event
      });

    } else if (msg?.type === 'LOCK_FAILED') {
      const parsed = LockFailedSchema.safeParse(msg);
      if (!parsed.success) {
        console.warn(`[WS Hub] Rejected malformed LOCK_FAILED from ${deviceId}`);
        return;
      }
      this.handleLockFailed(deviceId, parsed.data.reason);
    }
  }

  // The client could not lock the device. Alert the parent on Slack, at most
  // once per device per LOCK_FAILED_ALERT_INTERVAL_MS.
  private handleLockFailed(deviceId: string, reason: string | undefined): void {
    const cleanReason = reason ? sanitizeForSlack(reason) : '';
    console.warn(`[WS Hub] Lock failed on ${deviceId}${cleanReason ? `: ${cleanReason}` : ''}`);
    const now = Date.now();
    const last = this.lockFailedAlertAt.get(deviceId);
    if (last !== undefined && now - last < LOCK_FAILED_ALERT_INTERVAL_MS) return;
    this.lockFailedAlertAt.set(deviceId, now);
    notifySlack(`🔓 *${deviceId}*: the client could not lock the screen${cleanReason ? ` (${cleanReason})` : ''}. The device may still be usable.`);
  }

  // Disconnect a device's socket (if any) and drop its in-memory hub state.
  // Used when a device is removed from the dashboard.
  public disconnectClient(deviceId: string): void {
    const ws = this.clientSockets.get(deviceId);
    if (ws) {
      try { ws.close(4003, 'Device removed'); } catch { /* ignore */ }
      this.clientSockets.delete(deviceId);
    }
    this.enfState.delete(deviceId);
    this.lockFailedAlertAt.delete(deviceId);
    this.broadcastToDashboards({ type: 'DEVICE_REMOVED', deviceId });
  }

  public sendCommandToClient(deviceId: string, command: ServerCommand): boolean {
    const ws = this.clientSockets.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'COMMAND',
        command
      }));
      return true;
    }
    return false;
  }

  public broadcastPolicyUpdate(policy: DevicePolicy): void {
    this.sendCommandToClient(policy.deviceId, {
      action: 'SYNC_POLICY',
      policy
    });

    this.broadcastToDashboards({
      type: 'POLICY_UPDATED',
      policy
    });
  }

  public broadcastToDashboards(data: any): void {
    const msg = JSON.stringify(data);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
