import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WatchtowerStore } from '../ledger/store.js';
import { clearAllAuthRateLimits } from '../routes/api.js';

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

  it('authenticates with default password 0000 on fresh setup', () => {
    expect(store.verifyPassword('0000')).toBe(true);
    expect(store.verifyPassword('1234')).toBe(false);
    expect(store.verifyPassword('')).toBe(false);
  });

  it('creates and verifies session tokens for authenticated parents', () => {
    const token = store.createSessionToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(16);
    expect(store.verifySessionToken(token)).toBe(true);
    expect(store.verifySessionToken('invalid-token')).toBe(false);
  });

  it('allows changing password and invalidates old password', () => {
    expect(store.verifyPassword('0000')).toBe(true);
    
    store.setPassword('9876');

    expect(store.verifyPassword('0000')).toBe(false);
    expect(store.verifyPassword('9876')).toBe(true);
  });

  it('persists changed password across store restarts', () => {
    store.setPassword('secret-parent-pin');
    store.close();

    const reopenedStore = new WatchtowerStore(tempDir);
    expect(reopenedStore.verifyPassword('0000')).toBe(false);
    expect(reopenedStore.verifyPassword('secret-parent-pin')).toBe(true);
    reopenedStore.close();
  });

  it('enforces 5-second retry rate limit on failed password attempts to block brute-forcing', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. First bad attempt -> 401 Unauthorized with Retry-After header
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

    // 2. Immediate second attempt from same IP (e.g. rapid script or second tab) -> 429 Too Many Requests
    const rapidAttempt = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.50' },
      payload: { password: '0000' } // even with correct password, blocked by cooldown
    });
    expect(rapidAttempt.statusCode).toBe(429);
    const rapidBody = JSON.parse(rapidAttempt.body);
    expect(rapidBody.success).toBe(false);
    expect(rapidBody.error).toContain('Too many password attempts');
    expect(rapidBody.retryAfter).toBeGreaterThanOrEqual(1);

    // 3. Different IP is not blocked
    const otherIpLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.99' },
      payload: { password: '0000' }
    });
    expect(otherIpLogin.statusCode).toBe(200);

    await app.close();
  }, 15000);

  it('verifies REST API auth routes and protects device endpoints', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. Unauthenticated request to /api/devices should be 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/devices'
    });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Failed login with wrong password
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: { password: 'wrong' }
    });
    expect(badLogin.statusCode).toBe(401);

    // Clear rate limits for clean happy path testing
    clearAllAuthRateLimits();

    // 3. Successful login with default 0000
    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: { password: '0000' }
    });
    expect(goodLogin.statusCode).toBe(200);
    const { token } = JSON.parse(goodLogin.body);
    expect(token).toBeTruthy();

    // 4. Authenticated request to /api/devices with Bearer token
    const authDevices = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(authDevices.statusCode).toBe(200);

    // 5. Change password via API
    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: {
        currentPassword: '0000',
        newPassword: '5555'
      }
    });
    expect(changeRes.statusCode).toBe(200);
    const { token: newToken } = JSON.parse(changeRes.body);
    expect(newToken).toBeTruthy();

    // 6. Old password 0000 no longer works
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.2' },
      payload: { password: '0000' }
    });
    expect(oldLogin.statusCode).toBe(401);

    // 7. New password 5555 works
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.3' },
      payload: { password: '5555' }
    });
    expect(newLogin.statusCode).toBe(200);

    await app.close();
  }, 15000);

  it('protects uninstaller script: requires parent password and hides cleanup commands in dynamic payload', async () => {
    const { createServer } = await import('../server.js');
    process.env.DATA_DIR = tempDir;
    const { app } = await createServer();

    // 1. GET /api/uninstall.ps1 should return ONLY the wrapper and NOT disclose the raw removal commands
    const uninstallerWrapperRes = await app.inject({
      method: 'GET',
      url: '/api/uninstall.ps1'
    });
    expect(uninstallerWrapperRes.statusCode).toBe(200);
    const wrapperScript = uninstallerWrapperRes.body;
    expect(wrapperScript).toContain('/api/uninstall/execute');
    expect(wrapperScript).toContain('Read-Host');
    // Ensure raw removal commands are NOT in the downloaded uninstaller.ps1
    expect(wrapperScript).not.toContain('Stop-Process -Name "watchtower"');
    expect(wrapperScript).not.toContain('Unregister-ScheduledTask');
    expect(wrapperScript).not.toContain('Remove-ItemProperty');

    // 2. POST /api/uninstall/execute with incorrect password returns 401
    const badUninstallRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: 'wrong-password' }
    });
    expect(badUninstallRes.statusCode).toBe(401);
    const badUninstallBody = JSON.parse(badUninstallRes.body);
    expect(badUninstallBody.success).toBe(false);
    expect(badUninstallBody.error).toContain('Incorrect password');

    // 3. Immediate retry from same IP triggers 429 rate limit cooldown
    const rateLimitedRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: '0000' }
    });
    expect(rateLimitedRes.statusCode).toBe(429);

    clearAllAuthRateLimits();

    // 4. POST /api/uninstall/execute with correct password (default 0000) returns removal script payload
    const goodUninstallRes = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.10' },
      payload: { password: '0000' }
    });
    expect(goodUninstallRes.statusCode).toBe(200);
    const goodUninstallBody = JSON.parse(goodUninstallRes.body);
    expect(goodUninstallBody.success).toBe(true);
    expect(goodUninstallBody.script).toContain('Stop-Process -Name "watchtower"');
    expect(goodUninstallBody.script).toContain('Unregister-ScheduledTask');
    expect(goodUninstallBody.script).toContain('SystemDiagnosticsHostTask');

    await app.close();
  }, 15000);
});


