import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WatchtowerStore } from '../ledger/store.js';
import { clearAllAuthRateLimits } from '../routes/api.js';

// Deterministic secrets for the test environment. On a fresh data dir the store
// seeds the dashboard password from ADMIN_PASSWORD and the enrollment secret
// from DEVICE_ENROLLMENT_SECRET instead of generating random ones.
const ADMIN_PW = 'watchtower-test-pw';
const ENROLL_SECRET = 'enroll-secret-0123456789';
process.env.ADMIN_PASSWORD = ADMIN_PW;
process.env.DEVICE_ENROLLMENT_SECRET = ENROLL_SECRET;

describe('Watchtower Authentication & Password Protection', () => {
  let tempDir: string;
  let store: WatchtowerStore;

  beforeEach(() => {
    clearAllAuthRateLimits();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-auth-test-'));
    store = new WatchtowerStore(tempDir);
  });

  afterEach(() => {
    clearAllAuthRateLimits();
    try {
      store.close();
    } catch {}
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('seeds the dashboard password from ADMIN_PASSWORD (no hardcoded default)', () => {
    expect(store.verifyPassword(ADMIN_PW)).toBe(true);
    // The old hardcoded default must no longer work.
    expect(store.verifyPassword('0000')).toBe(false);
    expect(store.verifyPassword('')).toBe(false);
  });

  it('creates and verifies session tokens for authenticated parents', () => {
    const token = store.createSessionToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(16);
    expect(store.verifySessionToken(token)).toBe(true);
    expect(store.verifySessionToken('invalid-token')).toBe(false);
    expect(store.verifySessionToken('a.b.c.d')).toBe(false);
  });

  it('invalidates all existing session tokens on revokeAllSessions (logout)', () => {
    const token = store.createSessionToken();
    expect(store.verifySessionToken(token)).toBe(true);
    store.revokeAllSessions();
    expect(store.verifySessionToken(token)).toBe(false);
    // Newly issued tokens work again.
    const fresh = store.createSessionToken();
    expect(store.verifySessionToken(fresh)).toBe(true);
  });

  it('expires session tokens after the configured TTL', () => {
    vi.useFakeTimers();
    try {
      const token = store.createSessionToken();
      expect(store.verifySessionToken(token)).toBe(true);
      // Default TTL is 12h; advance 13h.
      vi.advanceTimersByTime(13 * 60 * 60 * 1000);
      expect(store.verifySessionToken(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows changing password and invalidates old password', () => {
    expect(store.verifyPassword(ADMIN_PW)).toBe(true);
    store.setPassword('9876543210');
    expect(store.verifyPassword(ADMIN_PW)).toBe(false);
    expect(store.verifyPassword('9876543210')).toBe(true);
  });

  it('persists changed password across store restarts', () => {
    store.setPassword('secret-parent-pin');
    store.close();

    const reopenedStore = new WatchtowerStore(tempDir);
    expect(reopenedStore.verifyPassword(ADMIN_PW)).toBe(false);
    expect(reopenedStore.verifyPassword('secret-parent-pin')).toBe(true);
    reopenedStore.close();
  });

  // ---- Device authentication (C1) ----

  it('issues device tokens bound to a single deviceId', () => {
    const token = store.createDeviceToken('PC-ALICE');
    expect(store.verifyDeviceToken('PC-ALICE', token)).toBe(true);
    // A token for one device must not authenticate another.
    expect(store.verifyDeviceToken('PC-BOB', token)).toBe(false);
    // Tampered / malformed tokens fail.
    expect(store.verifyDeviceToken('PC-ALICE', token + 'x')).toBe(false);
    expect(store.verifyDeviceToken('PC-ALICE', 'garbage')).toBe(false);
    expect(store.verifyDeviceToken('PC-ALICE', '')).toBe(false);
  });

  it('verifies the enrollment secret', () => {
    expect(store.verifyEnrollmentSecret(ENROLL_SECRET)).toBe(true);
    expect(store.verifyEnrollmentSecret('wrong-secret')).toBe(false);
    expect(store.verifyEnrollmentSecret('')).toBe(false);
  });

  // ---- WS tickets (H3) ----

  it('issues single-use WebSocket tickets', () => {
    const ticket = store.createWsTicket();
    expect(store.consumeWsTicket(ticket)).toBe(true);
    // Second use fails (single-use).
    expect(store.consumeWsTicket(ticket)).toBe(false);
    expect(store.consumeWsTicket('never-issued')).toBe(false);
  });

  it('enforces exponential backoff and lockout on failed password attempts', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. First bad attempt -> 401 with a 5s Retry-After.
    const badLogin1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.50' },
      payload: { password: 'wrong' }
    });
    expect(badLogin1.statusCode).toBe(401);
    const badBody1 = JSON.parse(badLogin1.body);
    expect(badBody1.retryAfter).toBe(5);
    expect(badLogin1.headers['retry-after']).toBe('5');

    // 2. Immediate retry from same IP -> 429, even with the correct password.
    const rapidAttempt = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.50' },
      payload: { password: ADMIN_PW }
    });
    expect(rapidAttempt.statusCode).toBe(429);
    const rapidBody = JSON.parse(rapidAttempt.body);
    expect(rapidBody.success).toBe(false);
    expect(rapidBody.error).toContain('Too many password attempts');

    // 3. A different IP is not blocked.
    const otherIpLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.99' },
      payload: { password: ADMIN_PW }
    });
    expect(otherIpLogin.statusCode).toBe(200);

    await app.close();
  }, 15000);

  it('cannot bypass the rate limiter by spoofing X-Forwarded-For (H1)', async () => {
    // With TRUST_PROXY defaulting to 1 hop, req.ip is the single XFF entry the
    // trusted proxy set; injecting a chain does not let an attacker rotate IPs.
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { password: 'wrong' }
    });
    expect(first.statusCode).toBe(401);

    // Attacker appends a fake left-most IP; the trusted-hop resolution still
    // resolves to the same client, so this is rate limited.
    const spoofed = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
      payload: { password: 'wrong' }
    });
    expect(spoofed.statusCode).toBe(429);

    await app.close();
  }, 15000);

  it('verifies REST API auth routes and protects device endpoints', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. Unauthenticated request to /api/devices should be 401.
    const unauthRes = await app.inject({ method: 'GET', url: '/api/devices' });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Tokens in the query string are no longer accepted (H3).
    const goodLoginForToken = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.5.1' },
      payload: { password: ADMIN_PW }
    });
    const { token: qToken } = JSON.parse(goodLoginForToken.body);
    const queryTokenRes = await app.inject({
      method: 'GET',
      url: `/api/devices?token=${encodeURIComponent(qToken)}`
    });
    expect(queryTokenRes.statusCode).toBe(401);

    clearAllAuthRateLimits();

    // 3. Successful login with the configured admin password.
    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: { password: ADMIN_PW }
    });
    expect(goodLogin.statusCode).toBe(200);
    const { token } = JSON.parse(goodLogin.body);
    expect(token).toBeTruthy();

    // 4. Authenticated request to /api/devices with Bearer token.
    const authDevices = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authDevices.statusCode).toBe(200);

    // 5. A short password is rejected (M4).
    const weakChange = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'x-forwarded-for': '10.0.0.1', authorization: `Bearer ${token}` },
      payload: { currentPassword: ADMIN_PW, newPassword: 'short' }
    });
    expect(weakChange.statusCode).toBe(400);

    clearAllAuthRateLimits();

    // 6. Change password to a compliant value.
    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'x-forwarded-for': '10.0.0.1', authorization: `Bearer ${token}` },
      payload: { currentPassword: ADMIN_PW, newPassword: 'new-strong-pass' }
    });
    expect(changeRes.statusCode).toBe(200);
    const { token: newToken } = JSON.parse(changeRes.body);
    expect(newToken).toBeTruthy();

    // 7. The token issued before the password change is revoked (H2).
    const staleRes = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(staleRes.statusCode).toBe(401);

    // 8. Old password no longer works; new one does.
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.2' },
      payload: { password: ADMIN_PW }
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.3' },
      payload: { password: 'new-strong-pass' }
    });
    expect(newLogin.statusCode).toBe(200);

    await app.close();
  }, 20000);

  it('enrolls devices only with the correct enrollment secret (C1)', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // Wrong secret -> 401.
    const badEnroll = await app.inject({
      method: 'POST',
      url: '/api/devices/enroll',
      headers: { 'x-forwarded-for': '10.1.0.1' },
      payload: { deviceId: 'PC-KID', enrollmentSecret: 'nope' }
    });
    expect(badEnroll.statusCode).toBe(401);

    clearAllAuthRateLimits();

    // Correct secret -> a device-bound token.
    const goodEnroll = await app.inject({
      method: 'POST',
      url: '/api/devices/enroll',
      headers: { 'x-forwarded-for': '10.1.0.2' },
      payload: { deviceId: 'PC-KID', enrollmentSecret: ENROLL_SECRET }
    });
    expect(goodEnroll.statusCode).toBe(200);
    const { token: deviceToken } = JSON.parse(goodEnroll.body);
    expect(store.verifyDeviceToken('PC-KID', deviceToken)).toBe(true);

    await app.close();
  }, 15000);

  it('issues WS tickets only to authenticated dashboards (H3)', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // No token -> 401.
    const noAuth = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket' });
    expect(noAuth.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.2.0.1' },
      payload: { password: ADMIN_PW }
    });
    const { token } = JSON.parse(login.body);

    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/auth/ws-ticket',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = JSON.parse(ticketRes.body);
    expect(ticket).toBeTruthy();

    await app.close();
  }, 15000);

  it('adds/removes time without a password; removal cuts into the daily quota', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.9.0.1' },
      payload: { password: ADMIN_PW }
    });
    const { token } = JSON.parse(login.body);
    const auth = { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.9.0.1' };

    // Add +240 min with NO password confirmation -> 200.
    const add = await app.inject({
      method: 'POST', url: '/api/devices/PC-1/grant-time',
      headers: auth, payload: { extraMinutes: 240 }
    });
    expect(add.statusCode).toBe(200);
    expect(JSON.parse(add.body).bonusSecondsToday).toBe(240 * 60);

    // Remove 600 min: 240 comes off bonus (-> 0), remaining 360 off the daily
    // limit (default 86400s = 1440m -> 1080m).
    const remove = await app.inject({
      method: 'POST', url: '/api/devices/PC-1/grant-time',
      headers: auth, payload: { extraMinutes: -600 }
    });
    expect(remove.statusCode).toBe(200);
    const body = JSON.parse(remove.body);
    expect(body.bonusSecondsToday).toBe(0);
    expect(body.dailyGlobalLimitSeconds).toBe(1080 * 60);

    await app.close();
  }, 15000);

  it('requires password confirmation to change quotas and to unlock', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.9.1.1' },
      payload: { password: ADMIN_PW }
    });
    const { token } = JSON.parse(login.body);
    const auth = { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.9.1.1' };

    // Policy change without confirmation -> 401; the confirmPassword must not
    // be persisted onto the policy.
    const noPw = await app.inject({
      method: 'POST', url: '/api/devices/PC-2/policy',
      headers: auth, payload: { dailyGlobalLimitSeconds: 3600 }
    });
    expect(noPw.statusCode).toBe(401);

    clearAllAuthRateLimits();

    const ok = await app.inject({
      method: 'POST', url: '/api/devices/PC-2/policy',
      headers: auth, payload: { dailyGlobalLimitSeconds: 3600, confirmPassword: ADMIN_PW }
    });
    expect(ok.statusCode).toBe(200);
    const savedPolicy = JSON.parse(ok.body).policy;
    expect(savedPolicy.dailyGlobalLimitSeconds).toBe(3600);
    expect('confirmPassword' in savedPolicy).toBe(false);

    clearAllAuthRateLimits();

    // Enabling the emergency lock needs no confirmation...
    const lock = await app.inject({
      method: 'POST', url: '/api/devices/PC-2/emergency-lock',
      headers: auth, payload: { locked: true }
    });
    expect(lock.statusCode).toBe(200);

    // ...but unlocking does.
    const unlockNoPw = await app.inject({
      method: 'POST', url: '/api/devices/PC-2/emergency-lock',
      headers: auth, payload: { locked: false }
    });
    expect(unlockNoPw.statusCode).toBe(401);

    clearAllAuthRateLimits();

    const unlockOk = await app.inject({
      method: 'POST', url: '/api/devices/PC-2/emergency-lock',
      headers: auth, payload: { locked: false, confirmPassword: ADMIN_PW }
    });
    expect(unlockOk.statusCode).toBe(200);

    await app.close();
  }, 15000);

  it('protects uninstaller script: requires parent password and hides cleanup commands in dynamic payload', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. GET /api/uninstall.ps1 returns ONLY the wrapper, not the raw removal commands.
    const uninstallerWrapperRes = await app.inject({ method: 'GET', url: '/api/uninstall.ps1' });
    expect(uninstallerWrapperRes.statusCode).toBe(200);
    const wrapperScript = uninstallerWrapperRes.body;
    expect(wrapperScript).toContain('/api/uninstall/execute');
    expect(wrapperScript).toContain('Read-Host');
    expect(wrapperScript).not.toContain('Stop-Process -Name "watchtower"');
    expect(wrapperScript).not.toContain('Unregister-ScheduledTask');
    expect(wrapperScript).not.toContain('Remove-ItemProperty');

    // 2. Wrong password -> 401.
    const badUninstallRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: 'wrong-password' }
    });
    expect(badUninstallRes.statusCode).toBe(401);

    // 3. Immediate retry from same IP -> 429.
    const rateLimitedRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: ADMIN_PW }
    });
    expect(rateLimitedRes.statusCode).toBe(429);

    clearAllAuthRateLimits();

    // 4. Correct password -> removal script payload.
    const goodUninstallRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: ADMIN_PW }
    });
    expect(goodUninstallRes.statusCode).toBe(200);
    const goodUninstallBody = JSON.parse(goodUninstallRes.body);
    expect(goodUninstallBody.success).toBe(true);
    expect(goodUninstallBody.script).toContain('Stop-Process -Name "watchtower"');
    expect(goodUninstallBody.script).toContain('Unregister-ScheduledTask');

    await app.close();
  }, 15000);
});
