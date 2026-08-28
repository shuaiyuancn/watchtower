import { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  Monitor, 
  Clock, 
  Lock, 
  Unlock, 
  PlusCircle, 
  Gamepad2, 
  Globe, 
  MessageSquare, 
  Film, 
  BookOpen, 
  Settings, 
  Activity, 
  Youtube, 
  Send, 
  XOctagon, 
  Sliders,
  CheckCircle2,
  Trash2,
  BarChart3,
  Calendar,
  History,
  TrendingUp,
  Search,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

interface AppRule {
  executableName: string;
  displayName: string;
  category: string;
  dailyLimitSeconds?: number;
  isBlockedAlways?: boolean;
}

interface CategoryLimit {
  category: string;
  dailyLimitSeconds: number;
}

interface BedtimeSchedule {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

interface DevicePolicy {
  deviceId: string;
  dailyGlobalLimitSeconds: number;
  warningThresholdSeconds: number;
  emergencyLock: boolean;
  bonusSecondsToday: number;
  bedtime: BedtimeSchedule;
  categoryLimits: CategoryLimit[];
  appRules: AppRule[];
}

interface ActiveSession {
  deviceId: string;
  currentApp: string;
  windowTitle: string;
  category: string;
  isIdle: boolean;
  idleSeconds: number;
  lastHeartbeat: string;
  connected: boolean;
}

interface DailyUsageSummary {
  date: string;
  deviceId: string;
  totalActiveSeconds: number;
  categorySeconds: Record<string, number>;
  appSeconds: Record<string, number>;
}

interface DeviceEntry {
  deviceId: string;
  session?: ActiveSession;
  policy: DevicePolicy;
  usageToday: DailyUsageSummary;
}

interface TelemetryEvent {
  id: string;
  deviceId: string;
  timestamp: string;
  type: 'YOUTUBE' | 'IM_MESSAGE';
  app: string;
  titleOrText: string;
  details?: Record<string, any>;
}

interface AppActivityLog {
  id: string;
  deviceId: string;
  app: string;
  windowTitle: string;
  category: string;
  timestamp: string;
  date: string;
  hour: number;
  durationSeconds: number;
}

interface HourlyUsageSummary {
  hour: number;
  totalSeconds: number;
  categorySeconds: Record<string, number>;
  appSeconds: Record<string, number>;
}

export default function App() {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('windows-pc');
  const [telemetry, setTelemetry] = useState<TelemetryEvent[]>([]);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'monitor' | 'analytics' | 'limits' | 'apps' | 'telemetry'>('monitor');
  const [notification, setNotification] = useState<string | null>(null);

  // Analytics & Timeline state
  const todayStr = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [hourlyData, setHourlyData] = useState<HourlyUsageSummary[]>([]);
  const [timelineData, setTimelineData] = useState<AppActivityLog[]>([]);
  const [dailyHistory, setDailyHistory] = useState<DailyUsageSummary[]>([]);
  const [timelineSearch, setTimelineSearch] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [selectedHour, setSelectedHour] = useState<number | null>(null);


  // New app rule form state
  const [newAppExe, setNewAppExe] = useState('');
  const [newAppDisplayName, setNewAppDisplayName] = useState('');
  const [newAppCategory, setNewAppCategory] = useState('Games');
  const [newAppLimitMinutes, setNewAppLimitMinutes] = useState<number | ''>('');

  const wsRef = useRef<WebSocket | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 4000);
  };

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/dashboard`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      console.log('Connected to Watchtower WebSocket Hub');
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'INIT_STATE') {
          const list: DeviceEntry[] = data.devices || [];
          setDevices(list);
          if (list.length > 0) {
            setSelectedDeviceId((curr) => {
              const match = list.find((d) => d.deviceId === curr);
              return match ? curr : list[0].deviceId;
            });
          }
          if (data.recentTelemetry) {
            setTelemetry(data.recentTelemetry);
          }
        } else if (data.type === 'DEVICE_ACTIVITY_UPDATE') {
          setDevices((prev) => {
            const idx = prev.findIndex((d) => d.deviceId === data.deviceId);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = {
                ...updated[idx],
                session: data.session,
                usageToday: data.usageToday
              };
              return updated;
            } else {
              return [...prev, {
                deviceId: data.deviceId,
                session: data.session,
                usageToday: data.usageToday,
                policy: data.policy
              }];
            }
          });
          setSelectedDeviceId((curr) => {
            if (curr === 'windows-pc' && data.deviceId !== 'windows-pc') {
              return data.deviceId;
            }
            return curr;
          });
        } else if (data.type === 'POLICY_UPDATED') {
          setDevices((prev) => {
            const idx = prev.findIndex((d) => d.deviceId === data.policy.deviceId);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], policy: data.policy };
              return updated;
            }
            return prev;
          });
        } else if (data.type === 'TELEMETRY_EVENT') {
          setTelemetry((prev) => [data.event, ...prev.slice(0, 99)]);
        } else if (data.type === 'DEVICE_DISCONNECTED') {
          setDevices((prev) =>
            prev.map((d) =>
              d.deviceId === data.deviceId
                ? { ...d, session: d.session ? { ...d.session, connected: false } : undefined }
                : d
            )
          );
        }
      } catch (err) {
        console.error('Error parsing WS message:', err);
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      setTimeout(connectWebSocket, 3000);
    };
  };

  const fetchAnalyticsData = (deviceId: string, date: string) => {
    if (!deviceId) return;
    
    // 1. Fetch Hourly breakdown
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/hourly?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.hourly) setHourlyData(d.hourly);
      })
      .catch(() => {});

    // 2. Fetch Timeline records
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/timeline?date=${date}&limit=200`)
      .then((r) => r.json())
      .then((d) => {
        if (d.timeline) setTimelineData(d.timeline);
      })
      .catch(() => {});

    // 3. Fetch 14-day history
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/history?days=14`)
      .then((r) => r.json())
      .then((d) => {
        if (d.history) setDailyHistory(d.history);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch('/api/devices')
      .then((r) => r.json())
      .then((d) => {
        if (d.devices && d.devices.length > 0) {
          setDevices(d.devices);
          setSelectedDeviceId((curr) => {
            const match = d.devices.find((dev: DeviceEntry) => dev.deviceId === curr);
            return match ? curr : d.devices[0].deviceId;
          });
        }
      })
      .catch(() => {});

    fetch('/api/devices/windows-pc/telemetry?limit=50')
      .then((r) => r.json())
      .then((d) => {
        if (d.telemetry) setTelemetry(d.telemetry);
      })
      .catch(() => {});

    connectWebSocket();

    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (selectedDeviceId) {
      fetchAnalyticsData(selectedDeviceId, selectedDate);
    }
  }, [selectedDeviceId, selectedDate, activeTab]);

  const currentDevice = devices.find((d) => d.deviceId === selectedDeviceId) || devices[0] || {
    deviceId: selectedDeviceId,
    policy: {
      deviceId: selectedDeviceId,
      dailyGlobalLimitSeconds: 86400,
      warningThresholdSeconds: 300,
      emergencyLock: false,
      bonusSecondsToday: 0,
      bedtime: { enabled: false, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0 },
      categoryLimits: [],
      appRules: []
    },
    usageToday: {
      date: new Date().toISOString().split('T')[0],
      deviceId: selectedDeviceId,
      totalActiveSeconds: 0,
      categorySeconds: {},
      appSeconds: {}
    }
  };

  const formatSeconds = (sec: number) => {
    if (sec >= 86400) {
      return '24h (Unlimited)';
    }
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${s}s`;
    return `${s}s`;
  };

  const formatSecondsShort = (sec: number) => {
    const m = Math.round(sec / 60);
    if (m >= 60) {
      const h = (sec / 3600).toFixed(1);
      return `${h}h`;
    }
    return `${m}m`;
  };

  const handleGrantTime = async (minutes: number) => {
    try {
      const res = await fetch(`/api/devices/${currentDevice.deviceId}/grant-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraMinutes: minutes })
      });
      if (res.ok) {
        showNotification(`Granted +${minutes} minutes to ${currentDevice.deviceId}`);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleEmergencyLock = async () => {
    const newLockState = !currentDevice.policy.emergencyLock;
    try {
      const res = await fetch(`/api/devices/${currentDevice.deviceId}/emergency-lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: newLockState })
      });
      if (res.ok) {
        showNotification(newLockState ? '🚨 PC Locked Immediately' : '🔓 PC Unlocked');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleKillActiveApp = async () => {
    if (!currentDevice.session?.currentApp) return;
    try {
      const res = await fetch(`/api/devices/${currentDevice.deviceId}/kill-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executableName: currentDevice.session.currentApp })
      });
      if (res.ok) {
        showNotification(`Sent command to close ${currentDevice.session.currentApp}`);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSavePolicy = async (updatedPolicy: DevicePolicy) => {
    try {
      const res = await fetch(`/api/devices/${currentDevice.deviceId}/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedPolicy)
      });
      if (res.ok) {
        showNotification('Policy updated & pushed to client');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddAppRule = () => {
    if (!newAppExe.trim()) return;
    const cleanExe = newAppExe.trim().endsWith('.exe') ? newAppExe.trim() : `${newAppExe.trim()}.exe`;
    const newRule: AppRule = {
      executableName: cleanExe,
      displayName: newAppDisplayName.trim() || cleanExe,
      category: newAppCategory,
      dailyLimitSeconds: newAppLimitMinutes ? Number(newAppLimitMinutes) * 60 : undefined
    };

    const existingIdx = currentDevice.policy.appRules.findIndex(
      (r) => r.executableName.toLowerCase() === cleanExe.toLowerCase()
    );

    let updatedRules = [...currentDevice.policy.appRules];
    if (existingIdx >= 0) {
      updatedRules[existingIdx] = newRule;
    } else {
      updatedRules.push(newRule);
    }

    const updatedPolicy: DevicePolicy = {
      ...currentDevice.policy,
      appRules: updatedRules
    };

    handleSavePolicy(updatedPolicy);
    setNewAppExe('');
    setNewAppDisplayName('');
    setNewAppLimitMinutes('');
  };

  const handleDeleteAppRule = (exeName: string) => {
    const updatedRules = currentDevice.policy.appRules.filter(
      (r) => r.executableName.toLowerCase() !== exeName.toLowerCase()
    );
    handleSavePolicy({ ...currentDevice.policy, appRules: updatedRules });
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'Games':
        return <Gamepad2 className="w-5 h-5 text-indigo-400" />;
      case 'Browsers':
        return <Globe className="w-5 h-5 text-blue-400" />;
      case 'Social':
        return <MessageSquare className="w-5 h-5 text-emerald-400" />;
      case 'Media':
        return <Film className="w-5 h-5 text-amber-400" />;
      case 'Education':
      case 'Productivity':
        return <BookOpen className="w-5 h-5 text-teal-400" />;
      default:
        return <Activity className="w-5 h-5 text-slate-400" />;
    }
  };

  const getCategoryBadgeClass = (category: string) => {
    switch (category) {
      case 'Games':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      case 'Browsers':
        return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
      case 'Social':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'Media':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'Education':
      case 'Productivity':
        return 'bg-teal-500/10 text-teal-400 border-teal-500/20';
      default:
        return 'bg-slate-800 text-slate-300 border-slate-700';
    }
  };

  const totalUsed = currentDevice.usageToday?.totalActiveSeconds || 0;
  const totalLimit = (currentDevice.policy?.dailyGlobalLimitSeconds || 86400) + (currentDevice.policy?.bonusSecondsToday || 0);
  const percentUsed = Math.min(100, Math.round((totalUsed / (totalLimit || 1)) * 100));

  // Analytics computed metrics for the selected date
  const selectedDateTotalSeconds = hourlyData.reduce((acc, h) => acc + h.totalSeconds, 0);
  const peakHourEntry = [...hourlyData].sort((a, b) => b.totalSeconds - a.totalSeconds)[0];
  
  const appTotals: Record<string, number> = {};
  for (const h of hourlyData) {
    for (const [app, sec] of Object.entries(h.appSeconds || {})) {
      appTotals[app] = (appTotals[app] || 0) + sec;
    }
  }
  const topApp = Object.entries(appTotals).sort((a, b) => b[1] - a[1])[0];
  const maxHourlySeconds = Math.max(3600, ...hourlyData.map(h => h.totalSeconds));

  const filteredTimeline = timelineData.filter((item) => {
    if (categoryFilter !== 'All' && item.category !== categoryFilter) return false;
    if (selectedHour !== null && item.hour !== selectedHour) return false;
    if (timelineSearch.trim()) {
      const q = timelineSearch.toLowerCase();
      return (
        item.app.toLowerCase().includes(q) ||
        (item.windowTitle && item.windowTitle.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Toast Notification */}
      {notification && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 border border-blue-500/50 text-blue-100 px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-fade-in">
          <CheckCircle2 className="w-5 h-5 text-blue-400" />
          <span className="text-sm font-medium">{notification}</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 border border-blue-500/30 rounded-xl text-blue-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                WATCHTOWER
                <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  Control Center
                </span>
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Device Selector */}
            {devices.length > 0 && (
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="bg-slate-800/80 border border-slate-700/80 text-slate-200 text-xs rounded-xl px-3 py-1.5 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId} className="bg-slate-900 text-slate-200">
                    🖥️ {d.deviceId} {d.session?.connected ? '● (Online)' : '(Offline)'}
                  </option>
                ))}
              </select>
            )}

            {/* Live connection badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/70 border border-slate-700/60 text-xs">
              <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              <span className="text-slate-300 font-medium">{wsConnected ? 'Live Sync' : 'Reconnecting...'}</span>
            </div>

            {/* Emergency Lock Toggle */}
            <button
              onClick={handleToggleEmergencyLock}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold tracking-wide transition-all shadow-lg ${
                currentDevice.policy.emergencyLock
                  ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-900/30 ring-2 ring-red-400'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
              }`}
            >
              {currentDevice.policy.emergencyLock ? (
                <>
                  <Lock className="w-4 h-4" />
                  LOCKED (Click to Unlock)
                </>
              ) : (
                <>
                  <Unlock className="w-4 h-4 text-emerald-400" />
                  Lock PC Now
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex-1 w-full flex flex-col gap-6">
        
        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveTab('monitor')}
            className={`pb-3 px-4 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'monitor'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Monitor className="w-4 h-4" /> Live Monitor
          </button>
          <button
            onClick={() => setActiveTab('analytics')}
            className={`pb-3 px-4 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'analytics'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart3 className="w-4 h-4" /> Usage History & Timeline
          </button>
          <button
            onClick={() => setActiveTab('limits')}
            className={`pb-3 px-4 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'limits'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders className="w-4 h-4" /> Time Quotas & Bedtime
          </button>
          <button
            onClick={() => setActiveTab('apps')}
            className={`pb-3 px-4 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'apps'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Settings className="w-4 h-4" /> App Rules
          </button>
          <button
            onClick={() => setActiveTab('telemetry')}
            className={`pb-3 px-4 text-sm font-semibold flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'telemetry'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="w-4 h-4" /> Deep Telemetry (YouTube & IM)
          </button>
        </div>

        {/* TAB 1: LIVE MONITOR */}
        {activeTab === 'monitor' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Live Foreground Status Card */}
            <div className="lg:col-span-2 bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Monitor className="w-5 h-5 text-blue-400" />
                    <h2 className="text-base font-semibold text-slate-100">Active Window & Activity</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      currentDevice.session?.connected
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {currentDevice.session?.connected ? 'Online' : 'Offline / Standby'}
                    </span>
                    {currentDevice.session?.isIdle && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        Idle ({Math.floor((currentDevice.session.idleSeconds || 0) / 60)}m)
                      </span>
                    )}
                  </div>
                </div>

                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-5 mb-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="p-3 bg-slate-800 rounded-xl mt-0.5">
                        {getCategoryIcon(currentDevice.session?.category || 'Other')}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-bold text-white">
                            {currentDevice.session?.currentApp || 'No active app reported yet'}
                          </h3>
                          {currentDevice.session?.category && (
                            <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                              {currentDevice.session.category}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 line-clamp-2 mt-1">
                          {currentDevice.session?.windowTitle || 'Client waiting for active user session...'}
                        </p>
                      </div>
                    </div>

                    {currentDevice.session?.currentApp && (
                      <button
                        onClick={handleKillActiveApp}
                        className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <XOctagon className="w-4 h-4" /> Close App
                      </button>
                    )}
                  </div>
                </div>

                {/* Quick Bonus Time Grant Bar */}
                <div className="flex items-center justify-between p-4 bg-slate-800/40 rounded-xl border border-slate-800">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-blue-400" />
                    <span className="text-sm font-medium text-slate-300">Quick Grant Time:</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleGrantTime(15)}
                      className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded-lg text-xs font-semibold transition"
                    >
                      +15 Mins
                    </button>
                    <button
                      onClick={() => handleGrantTime(30)}
                      className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded-lg text-xs font-semibold transition"
                    >
                      +30 Mins
                    </button>
                    <button
                      onClick={() => handleGrantTime(60)}
                      className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded-lg text-xs font-semibold transition"
                    >
                      +1 Hour
                    </button>
                  </div>
                </div>
              </div>

              <div className="text-xs text-slate-500 flex items-center justify-between pt-4 border-t border-slate-800/60 mt-4">
                <span>Device ID: <span className="text-slate-400 font-mono">{currentDevice.deviceId}</span></span>
                <span>Last Activity: {currentDevice.session?.lastHeartbeat ? new Date(currentDevice.session.lastHeartbeat).toLocaleTimeString() : 'Never'}</span>
              </div>
            </div>

            {/* Global Screen Time Meter Card */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2 mb-4">
                  <Clock className="w-5 h-5 text-indigo-400" /> Daily Screen Allowance
                </h2>

                <div className="text-center py-4">
                  <div className="text-4xl font-extrabold text-white tracking-tight mb-1">
                    {formatSeconds(totalUsed)}
                  </div>
                  <div className="text-xs text-slate-400 font-medium">
                    of {formatSeconds(totalLimit)} daily limit
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden mb-4">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      percentUsed >= 90
                        ? 'bg-red-500'
                        : percentUsed >= 70
                        ? 'bg-amber-500'
                        : 'bg-blue-500'
                    }`}
                    style={{ width: `${percentUsed}%` }}
                  />
                </div>

                <div className="flex justify-between text-xs text-slate-400 mb-6">
                  <span>{percentUsed}% Used</span>
                  <span>{formatSeconds(Math.max(0, totalLimit - totalUsed))} Remaining</span>
                </div>

                {/* Category Usage List */}
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                  Category Breakdown Today
                </h3>
                <div className="flex flex-col gap-2">
                  {Object.entries(currentDevice.usageToday?.categorySeconds || {}).map(([cat, sec]) => (
                    <div key={cat} className="flex items-center justify-between text-sm py-1 border-b border-slate-800/60">
                      <div className="flex items-center gap-2">
                        {getCategoryIcon(cat)}
                        <span className="text-slate-300 font-medium">{cat}</span>
                      </div>
                      <span className="text-slate-400 font-mono text-xs">{formatSeconds(sec)}</span>
                    </div>
                  ))}
                  {Object.keys(currentDevice.usageToday?.categorySeconds || {}).length === 0 && (
                    <div className="text-xs text-slate-500 italic py-2">No category activity recorded today yet.</div>
                  )}
                </div>
              </div>

              {currentDevice.policy.bonusSecondsToday > 0 && (
                <div className="mt-4 p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs text-center font-medium">
                  +{Math.round(currentDevice.policy.bonusSecondsToday / 60)} mins bonus screen time active today
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: USAGE HISTORY & HOURLY TIMELINE ANALYTICS */}
        {activeTab === 'analytics' && (
          <div className="flex flex-col gap-6">
            {/* Top Toolbar: Date Selector & Quick Stats */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-5 h-5 text-blue-400" />
                  <h2 className="text-lg font-bold text-white">Usage Analytics & Timeline</h2>
                </div>
                <p className="text-xs text-slate-400">
                  Granular chronological history of app and window activity, hourly distributions, and multi-day lookback.
                </p>
              </div>

              {/* Date picker controls */}
              <div className="flex items-center gap-2 bg-slate-950/80 p-1.5 rounded-xl border border-slate-800">
                <button
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() - 1);
                    setSelectedDate(d.toISOString().split('T')[0]);
                    setSelectedHour(null);
                  }}
                  className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                  title="Previous Day"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedHour(null);
                  }}
                  className="bg-transparent text-sm text-slate-200 font-semibold px-2 py-1 focus:outline-none cursor-pointer"
                />

                <button
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() + 1);
                    setSelectedDate(d.toISOString().split('T')[0]);
                    setSelectedHour(null);
                  }}
                  className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                  title="Next Day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                {selectedDate !== todayStr && (
                  <button
                    onClick={() => {
                      setSelectedDate(todayStr);
                      setSelectedHour(null);
                    }}
                    className="ml-2 px-2.5 py-1 text-xs font-semibold bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg border border-blue-500/30 transition-colors"
                  >
                    Today
                  </button>
                )}
              </div>
            </div>

            {/* Metrics Overview Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
                <div className="p-3 bg-blue-600/10 border border-blue-500/20 rounded-xl text-blue-400">
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-400 font-medium">Total Screen Time</div>
                  <div className="text-xl font-bold text-white mt-0.5">{formatSeconds(selectedDateTotalSeconds)}</div>
                </div>
              </div>

              <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
                <div className="p-3 bg-indigo-600/10 border border-indigo-500/20 rounded-xl text-indigo-400">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-400 font-medium">Peak Active Hour</div>
                  <div className="text-xl font-bold text-white mt-0.5">
                    {peakHourEntry && peakHourEntry.totalSeconds > 0
                      ? `${String(peakHourEntry.hour).padStart(2, '0')}:00 (${formatSecondsShort(peakHourEntry.totalSeconds)})`
                      : 'None'}
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
                <div className="p-3 bg-purple-600/10 border border-purple-500/20 rounded-xl text-purple-400">
                  <Gamepad2 className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-400 font-medium">Top App Used</div>
                  <div className="text-xl font-bold text-white mt-0.5 truncate max-w-[150px]">
                    {topApp ? topApp[0] : 'None'}
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
                <div className="p-3 bg-emerald-600/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-400 font-medium">Recorded Log Events</div>
                  <div className="text-xl font-bold text-white mt-0.5">{timelineData.length} events</div>
                </div>
              </div>
            </div>

            {/* 24-Hour Distribution Chart */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                  <h3 className="text-base font-semibold text-white">24-Hour Usage Distribution</h3>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {selectedHour !== null && (
                    <button
                      onClick={() => setSelectedHour(null)}
                      className="text-blue-400 hover:underline font-medium"
                    >
                      Showing {String(selectedHour).padStart(2, '0')}:00 only (Click to Reset)
                    </button>
                  )}
                  <span className="text-slate-500">Click any bar to filter timeline</span>
                </div>
              </div>

              <div className="h-44 flex items-end gap-1.5 pt-6 pb-2 px-2 bg-slate-950/60 rounded-xl border border-slate-800/60 overflow-x-auto">
                {Array.from({ length: 24 }).map((_, h) => {
                  const entry = hourlyData.find((item) => item.hour === h) || {
                    hour: h,
                    totalSeconds: 0,
                    categorySeconds: {},
                    appSeconds: {}
                  };
                  const heightPercent = maxHourlySeconds > 0 ? Math.min(100, Math.round((entry.totalSeconds / maxHourlySeconds) * 100)) : 0;
                  const isSelected = selectedHour === h;
                  const hasActivity = entry.totalSeconds > 0;

                  return (
                    <div
                      key={h}
                      onClick={() => setSelectedHour(isSelected ? null : h)}
                      className={`flex-1 min-w-[28px] flex flex-col items-center justify-end h-full group cursor-pointer transition-all ${
                        isSelected ? 'opacity-100 ring-2 ring-blue-400 rounded-lg' : 'opacity-80 hover:opacity-100'
                      }`}
                    >
                      {/* Tooltip on hover */}
                      <div className="opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity text-[10px] bg-slate-800 text-white px-2 py-0.5 rounded shadow-lg mb-1 whitespace-nowrap z-10 border border-slate-700">
                        {String(h).padStart(2, '0')}:00 - {formatSeconds(entry.totalSeconds)}
                      </div>

                      {/* Bar Fill */}
                      <div className="w-full bg-slate-800/50 rounded-t-md h-full flex items-end">
                        <div
                          style={{ height: `${Math.max(hasActivity ? 8 : 2, heightPercent)}%` }}
                          className={`w-full rounded-t-md transition-all duration-300 ${
                            isSelected
                              ? 'bg-blue-400'
                              : hasActivity
                              ? 'bg-gradient-to-t from-blue-600 to-indigo-500 group-hover:from-blue-500 group-hover:to-indigo-400'
                              : 'bg-slate-800/40'
                          }`}
                        />
                      </div>

                      {/* Hour Label */}
                      <div className="text-[10px] text-slate-500 group-hover:text-slate-300 mt-2 font-mono">
                        {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 14-Day Lookback Strip */}
            {dailyHistory.length > 0 && (
              <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <History className="w-5 h-5 text-blue-400" />
                    <h3 className="text-base font-semibold text-white">Past 14-Day Lookback</h3>
                  </div>
                  <span className="text-xs text-slate-500">Click any day to inspect</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
                  {dailyHistory.map((day) => {
                    const isSelected = day.date === selectedDate;
                    return (
                      <button
                        key={day.date}
                        onClick={() => {
                          setSelectedDate(day.date);
                          setSelectedHour(null);
                        }}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'bg-blue-600/20 border-blue-500 text-white ring-1 ring-blue-500'
                            : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-800/50 text-slate-300'
                        }`}
                      >
                        <div className="text-xs text-slate-400 font-medium">{day.date}</div>
                        <div className="text-sm font-bold mt-1 text-blue-300">{formatSeconds(day.totalActiveSeconds)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Granular Activity Timeline: App at which time */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <Activity className="w-5 h-5 text-blue-400" /> Granular Timeline Feed
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Chronological audit of every application, window title, and active period recorded.
                  </p>
                </div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Category Filter */}
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="All">All Categories</option>
                    <option value="Games">Games</option>
                    <option value="Browsers">Browsers</option>
                    <option value="Social">Social</option>
                    <option value="Media">Media</option>
                    <option value="Productivity">Productivity</option>
                    <option value="Other">Other</option>
                  </select>

                  {/* Search Bar */}
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="Search app or window..."
                      value={timelineSearch}
                      onChange={(e) => setTimelineSearch(e.target.value)}
                      className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-xl pl-9 pr-3 py-2 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Timeline Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4">Time</th>
                      <th className="py-3 px-4">Application</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4">Window / Page Title</th>
                      <th className="py-3 px-4 text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredTimeline.map((log) => {
                      const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                      return (
                        <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">{timeStr}</td>
                          <td className="py-3 px-4 font-semibold text-white whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {getCategoryIcon(log.category)}
                              <span>{log.app}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${getCategoryBadgeClass(log.category)}`}>
                              {log.category}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-300 max-w-md truncate" title={log.windowTitle}>
                            {log.windowTitle || '<No title>'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-blue-300 whitespace-nowrap">
                            {formatSeconds(log.durationSeconds)}
                          </td>
                        </tr>
                      );
                    })}

                    {filteredTimeline.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-slate-500">
                          <Activity className="w-8 h-8 text-slate-600 mx-auto mb-2 opacity-50" />
                          No activity records found for this date and filter selection.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: TIME QUOTAS & BEDTIME */}
        {activeTab === 'limits' && (
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl max-w-4xl flex flex-col gap-6">
            <div className="border-b border-slate-800 pb-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Sliders className="w-5 h-5 text-blue-400" /> Daily Time Quotas & Schedule
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Configure global allowances, category limits, 5-minute advance warnings, and bedtime curfews.
              </p>
            </div>

            {/* Global daily limit */}
            <div>
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                Daily Global Screen Time Limit: <span className="text-blue-400">{formatSeconds(currentDevice.policy.dailyGlobalLimitSeconds)}</span>
              </label>
              <input
                type="range"
                min="0"
                max="86400"
                step="1800"
                value={currentDevice.policy.dailyGlobalLimitSeconds}
                onChange={(e) => {
                  const updated = {
                    ...currentDevice.policy,
                    dailyGlobalLimitSeconds: Number(e.target.value)
                  };
                  handleSavePolicy(updated);
                }}
                className="w-full accent-blue-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>Off (0h)</span>
                <span>6 Hours</span>
                <span>12 Hours</span>
                <span>18 Hours</span>
                <span>24h (Unlimited)</span>
              </div>
            </div>

            {/* 5-minute Warning Threshold */}
            <div>
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                Advance Warning Notification: <span className="text-amber-400">{Math.round(currentDevice.policy.warningThresholdSeconds / 60)} minutes before lockout</span>
              </label>
              <input
                type="range"
                min="60"
                max="600"
                step="60"
                value={currentDevice.policy.warningThresholdSeconds || 300}
                onChange={(e) => {
                  const updated = {
                    ...currentDevice.policy,
                    warningThresholdSeconds: Number(e.target.value)
                  };
                  handleSavePolicy(updated);
                }}
                className="w-full accent-amber-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Bedtime Curfew */}
            <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">Bedtime Curfew Lockout</h3>
                  <p className="text-xs text-slate-400">Forces immediate logoff during sleeping hours.</p>
                </div>
                <input
                  type="checkbox"
                  checked={currentDevice.policy.bedtime?.enabled}
                  onChange={(e) => {
                    const updated = {
                      ...currentDevice.policy,
                      bedtime: {
                        ...currentDevice.policy.bedtime,
                        enabled: e.target.checked
                      }
                    };
                    handleSavePolicy(updated);
                  }}
                  className="w-5 h-5 accent-blue-600 rounded cursor-pointer"
                />
              </div>

              {currentDevice.policy.bedtime?.enabled && (
                <div className="grid grid-cols-2 gap-4 pt-3 border-t border-slate-800">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Curfew Start (Lock PC)</label>
                    <input
                      type="time"
                      value={`${String(currentDevice.policy.bedtime.startHour).padStart(2, '0')}:${String(currentDevice.policy.bedtime.startMinute).padStart(2, '0')}`}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(':').map(Number);
                        const updated = {
                          ...currentDevice.policy,
                          bedtime: {
                            ...currentDevice.policy.bedtime,
                            startHour: h,
                            startMinute: m
                          }
                        };
                        handleSavePolicy(updated);
                      }}
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Curfew End (Unlock PC)</label>
                    <input
                      type="time"
                      value={`${String(currentDevice.policy.bedtime.endHour).padStart(2, '0')}:${String(currentDevice.policy.bedtime.endMinute).padStart(2, '0')}`}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(':').map(Number);
                        const updated = {
                          ...currentDevice.policy,
                          bedtime: {
                            ...currentDevice.policy.bedtime,
                            endHour: h,
                            endMinute: m
                          }
                        };
                        handleSavePolicy(updated);
                      }}
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white w-full"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Category Limits */}
            <div>
              <h3 className="text-sm font-semibold text-slate-200 mb-3">Category Quotas</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {['Games', 'Social', 'Browsers', 'Media'].map((cat) => {
                  const limit = currentDevice.policy.categoryLimits?.find((c) => c.category === cat)?.dailyLimitSeconds || 0;
                  return (
                    <div key={cat} className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {getCategoryIcon(cat)}
                          <span className="text-sm font-semibold text-white">{cat}</span>
                        </div>
                        <span className="text-xs text-blue-400 font-mono font-medium">
                          {limit > 0 ? formatSeconds(limit) : 'Unlimited'}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="14400"
                        step="900"
                        value={limit}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const existingLimits = [...(currentDevice.policy.categoryLimits || [])];
                          const idx = existingLimits.findIndex((c) => c.category === cat);
                          if (idx >= 0) {
                            existingLimits[idx] = { category: cat as any, dailyLimitSeconds: val };
                          } else {
                            existingLimits.push({ category: cat as any, dailyLimitSeconds: val });
                          }
                          handleSavePolicy({
                            ...currentDevice.policy,
                            categoryLimits: existingLimits
                          });
                        }}
                        className="w-full accent-blue-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: APP RULES */}
        {activeTab === 'apps' && (
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-6">
            <div className="border-b border-slate-800 pb-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-400" /> Application Rules & Limits
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Customize limits or permanently block specific executable files (.exe).
              </p>
            </div>

            {/* Add App Form */}
            <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Executable Name</label>
                <input
                  type="text"
                  placeholder="e.g. RobloxPlayerBeta.exe"
                  value={newAppExe}
                  onChange={(e) => setNewAppExe(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  placeholder="e.g. Roblox"
                  value={newAppDisplayName}
                  onChange={(e) => setNewAppDisplayName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Category</label>
                <select
                  value={newAppCategory}
                  onChange={(e) => setNewAppCategory(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="Games">Games</option>
                  <option value="Browsers">Browsers</option>
                  <option value="Social">Social / IM</option>
                  <option value="Media">Media</option>
                  <option value="Education">Education</option>
                  <option value="Productivity">Productivity</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-slate-400 mb-1">Limit (Mins, opt)</label>
                  <input
                    type="number"
                    placeholder="e.g. 45"
                    value={newAppLimitMinutes}
                    onChange={(e) => setNewAppLimitMinutes(e.target.value ? Number(e.target.value) : '')}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <button
                  onClick={handleAddAppRule}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition"
                >
                  <PlusCircle className="w-4 h-4" /> Add Rule
                </button>
              </div>
            </div>

            {/* App Rules Table */}
            <div className="overflow-x-auto border border-slate-800 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Executable</th>
                    <th className="px-4 py-3">Display Name</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Daily Limit</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {currentDevice.policy.appRules.map((rule) => (
                    <tr key={rule.executableName} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3 font-mono text-slate-200">{rule.executableName}</td>
                      <td className="px-4 py-3 font-medium text-white">{rule.displayName}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                          {getCategoryIcon(rule.category)}
                          {rule.category}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {rule.isBlockedAlways ? (
                          <span className="text-red-400 font-semibold">Blocked Always</span>
                        ) : rule.dailyLimitSeconds ? (
                          <span className="text-blue-400 font-medium">{formatSeconds(rule.dailyLimitSeconds)}</span>
                        ) : (
                          <span className="text-slate-500">Inherits category limit</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDeleteAppRule(rule.executableName)}
                          className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-red-500/10 transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: DEEP TELEMETRY (YOUTUBE & IM) */}
        {activeTab === 'telemetry' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* YouTube Activity */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col">
              <div className="flex items-center gap-2 mb-4">
                <Youtube className="w-5 h-5 text-red-500" />
                <h2 className="text-base font-semibold text-white">YouTube Watch History (Tab Tracking)</h2>
              </div>
              <div className="flex-1 overflow-y-auto max-h-[500px] flex flex-col gap-2">
                {telemetry.filter((t) => t.type === 'YOUTUBE').map((t) => (
                  <div key={t.id} className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                    <div className="text-sm font-medium text-slate-100">{t.titleOrText}</div>
                    <div className="flex items-center justify-between text-xs text-slate-500 mt-2">
                      <span>Browser: <span className="text-slate-400 font-mono">{t.app}</span></span>
                      <span>{new Date(t.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
                {telemetry.filter((t) => t.type === 'YOUTUBE').length === 0 && (
                  <div className="text-xs text-slate-500 italic py-8 text-center">
                    No YouTube video telemetry received yet.
                  </div>
                )}
              </div>
            </div>

            {/* IM Message Activity */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col">
              <div className="flex items-center gap-2 mb-4">
                <Send className="w-5 h-5 text-emerald-400" />
                <h2 className="text-base font-semibold text-white">IM Messages & Chat Telemetry</h2>
              </div>
              <div className="flex-1 overflow-y-auto max-h-[500px] flex flex-col gap-2">
                {telemetry.filter((t) => t.type === 'IM_MESSAGE').map((t) => (
                  <div key={t.id} className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                    <div className="text-sm font-medium text-slate-200">"{t.titleOrText}"</div>
                    <div className="flex items-center justify-between text-xs text-slate-500 mt-2">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-400 font-medium">
                        {t.app}
                      </span>
                      <span>{new Date(t.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
                {telemetry.filter((t) => t.type === 'IM_MESSAGE').length === 0 && (
                  <div className="text-xs text-slate-500 italic py-8 text-center">
                    No IM chat message telemetry received yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-4 text-center text-xs text-slate-600">
        Project Watchtower • Windows 11 Screen Time & Parental Control Platform
      </footer>
    </div>
  );
}
