import { describe, it, expect } from 'vitest';
import { resolveStartupUrls } from '../server.js';

describe('resolveStartupUrls', () => {
  it('uses the public Railway domain over HTTPS/WSS when deployed', () => {
    const env = { RAILWAY_PUBLIC_DOMAIN: 'watchtower-production-3b1e.up.railway.app' } as NodeJS.ProcessEnv;
    expect(resolveStartupUrls(env, '0.0.0.0', 8080)).toEqual({
      httpBase: 'https://watchtower-production-3b1e.up.railway.app',
      wsBase: 'wss://watchtower-production-3b1e.up.railway.app'
    });
  });

  it('falls back to localhost (not 0.0.0.0) with the port when no Railway domain', () => {
    expect(resolveStartupUrls({} as NodeJS.ProcessEnv, '0.0.0.0', 4000)).toEqual({
      httpBase: 'http://localhost:4000',
      wsBase: 'ws://localhost:4000'
    });
    // IPv6 any-address also maps to localhost.
    expect(resolveStartupUrls({} as NodeJS.ProcessEnv, '::', 4000).httpBase).toBe('http://localhost:4000');
  });

  it('keeps an explicit bind host as-is', () => {
    expect(resolveStartupUrls({} as NodeJS.ProcessEnv, '192.168.1.50', 4000)).toEqual({
      httpBase: 'http://192.168.1.50:4000',
      wsBase: 'ws://192.168.1.50:4000'
    });
  });

  it('treats an empty Railway domain as not set', () => {
    expect(resolveStartupUrls({ RAILWAY_PUBLIC_DOMAIN: '' } as NodeJS.ProcessEnv, '0.0.0.0', 4000).httpBase)
      .toBe('http://localhost:4000');
  });
});
