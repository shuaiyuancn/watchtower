import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WatchtowerStore } from '../ledger/store.js';

describe('Watchtower Authentication & Password Protection', () => {
  let tempDir: string;
  let store: WatchtowerStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-auth-test-'));
    store = new WatchtowerStore(tempDir);
  });

  afterEach(() => {
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
      payload: { password: 'wrong' }
    });
    expect(badLogin.statusCode).toBe(401);

    // 3. Successful login with default 0000
    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
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
      payload: { password: '0000' }
    });
    expect(oldLogin.statusCode).toBe(401);

    // 7. New password 5555 works
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: '5555' }
    });
    expect(newLogin.statusCode).toBe(200);

    await app.close();
  });
});

