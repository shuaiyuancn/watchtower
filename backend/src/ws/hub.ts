import { WebSocket } from 'ws';
import { WatchtowerStore } from '../ledger/store.js';
import { 
  ClientHeartbeatPayload, 
  ServerCommand, 
  TelemetryEvent,
  DevicePolicy 
} from '../types.js';

export class WebSocketHub {
  private store: WatchtowerStore;
  private clientSockets: Map<string, WebSocket> = new Map(); // deviceId -> socket
  private dashboardSockets: Set<WebSocket> = new Set(); // connected web dashboards

  constructor(store: WatchtowerStore) {
    this.store = store;
  }

  public registerClient(deviceId: string, ws: WebSocket): void {
    this.clientSockets.set(deviceId, ws);
    console.log(`[WS Hub] Device client connected: ${deviceId}`);

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

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleClientMessage(deviceId, msg, ws);
      } catch (err) {
        console.error(`[WS Hub] Invalid message from ${deviceId}:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`[WS Hub] Device client disconnected: ${deviceId}`);
      this.clientSockets.delete(deviceId);
      
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

  private handleClientMessage(deviceId: string, msg: any, ws: WebSocket): void {
    if (msg.type === 'HEARTBEAT') {
      const payload: ClientHeartbeatPayload = {
        deviceId,
        hostname: msg.hostname || 'Windows-PC',
        currentApp: msg.currentApp || '',
        windowTitle: msg.windowTitle || '',
        isIdle: Boolean(msg.isIdle),
        idleSeconds: Number(msg.idleSeconds || 0),
        elapsedActiveDeltaSeconds: Number(msg.elapsedActiveDeltaSeconds || 0)
      };

      const { decision, policy, usage } = this.store.recordHeartbeat(payload);

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

    } else if (msg.type === 'TELEMETRY') {
      const event = this.store.recordTelemetry({
        deviceId,
        timestamp: new Date().toISOString(),
        type: msg.telemetryType === 'YOUTUBE' ? 'YOUTUBE' : 'IM_MESSAGE',
        app: msg.app || 'Unknown',
        titleOrText: msg.titleOrText || '',
        details: msg.details || {}
      });

      this.broadcastToDashboards({
        type: 'TELEMETRY_EVENT',
        event
      });
    }
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
