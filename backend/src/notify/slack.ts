// Lightweight Slack logging via an incoming webhook (SLACK_WEBHOOK_URL).
//
// Fire-and-forget: every call is best-effort, never throws, and never blocks a
// request or WebSocket handler. Security and lifecycle events are sent; raw
// telemetry content (YouTube titles, IM messages) is intentionally never sent.

const WEBHOOK = () => process.env.SLACK_WEBHOOK_URL || '';

// Collapse identical messages that arrive in a short burst (e.g. a reconnect
// storm) so the channel isn't flooded.
const recent = new Map<string, number>();
const DEDUPE_MS = 5000;

export function slackEnabled(): boolean {
  return Boolean(WEBHOOK());
}

export function notifySlack(text: string): void {
  const url = WEBHOOK();
  if (!url) return;

  const now = Date.now();
  const last = recent.get(text);
  if (last && now - last < DEDUPE_MS) return;
  recent.set(text, now);
  if (recent.size > 200) {
    for (const [k, t] of recent) {
      if (now - t > DEDUPE_MS) recent.delete(k);
    }
  }

  // Deliberately not awaited; failures fall back to the console only.
  void (async () => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(3000)
      });
    } catch (err) {
      console.warn('[slack] notification failed:', (err as Error).message);
    }
  })();
}
