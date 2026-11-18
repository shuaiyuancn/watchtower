import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { clearAllAuthRateLimits } from '../routes/api.js';
import {
  parseMacUser,
  parseEnrollKey,
  sanitizeHost,
  MAC_AGENT_PLIST,
  MAC_DAEMON_PLIST,
  MAC_HELPER_BODY,
  MAC_REMOVAL_SCRIPT
} from '../routes/macos-scripts.js';
import { releaseAssetUrl } from '../release/latest.js';

const ADMIN_PW = 'watchtower-test-pw';
const ENROLL_SECRET = 'enroll-secret-0123456789';
process.env.ADMIN_PASSWORD = ADMIN_PW;
process.env.DEVICE_ENROLLMENT_SECRET = ENROLL_SECRET;

const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;

let tempDir: string;
let scriptDir: string;
let app: Awaited<ReturnType<typeof import('../server.js')['createServer']>>['app'];

/** Write a script to disk and check it with `bash -n` (skipped without bash). */
function bashSyntaxOk(name: string, content: string): void {
  const file = path.join(scriptDir, name);
  fs.writeFileSync(file, content);
  if (!HAS_BASH) return;
  const res = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  expect(res.stderr, `${name}: ${res.stderr}`).toBe('');
  expect(res.status).toBe(0);
}

/** Minimal well-formedness check for the plists: declaration, doctype, balanced tags. */
function expectWellFormedPlist(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
  const body = xml.replace(/^<\?xml[^>]*\?>\s*<!DOCTYPE[^>]*>\s*/, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
  // Text content holds no markup characters that would need escaping.
  for (const m of body.matchAll(/>([^<]*)</g)) expect(m[1]).not.toMatch(/[&<>]/);
}

// Lines that hold an embedded request value.
function embeddedLines(script: string): string[] {
  return script.split('\n').filter((l) => /^(CHILD_USER|ENROLL_KEY|SERVER_WS_URL|SERVER_HTTP_BASE|SERVER_BASE)=/.test(l));
}

/** Each embedded value is one single-quoted word with no quote, $, backtick, ; or backslash inside. */
function expectSafeEmbeds(script: string): void {
  const lines = embeddedLines(script);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/^[A-Z_]+='[^'$`;\\\s]*'$/);
  // The template never leaves a brace expansion behind.
  expect(script).not.toContain('${');
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-macos-test-'));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-macos-scripts-'));
  process.env.DATA_DIR = tempDir;
  const { createServer } = await import('../server.js');
  ({ app } = await createServer());
});

afterAll(async () => {
  await app.close();
  for (const d of [tempDir, scriptDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

beforeEach(() => clearAllAuthRateLimits());

describe('macOS value allowlists', () => {
  it('accepts short names and rejects anything else', () => {
    expect(parseMacUser('leo')).toBe('leo');
    expect(parseMacUser('leo.y_2-b')).toBe('leo.y_2-b');
    expect(parseMacUser(undefined)).toBe('');
    expect(parseMacUser('')).toBe('');
    for (const bad of ['-rf', "x'y", 'a b', 'a$(id)', 'a`id`', 'a;b', 'a\nb', 'x'.repeat(65), 'é']) {
      expect(parseMacUser(bad)).toBeNull();
    }
  });

  it('accepts generated and operator-set enrollment secrets only', () => {
    expect(parseEnrollKey('0123abcdef'.repeat(4))).toBe('0123abcdef'.repeat(4));
    expect(parseEnrollKey(ENROLL_SECRET)).toBe(ENROLL_SECRET);
    expect(parseEnrollKey('Pa+ss/w=rd:1@2,3!#%*^~')).toBe('Pa+ss/w=rd:1@2,3!#%*^~');
    expect(parseEnrollKey(undefined)).toBe('');
    for (const bad of ["k'", 'k"', 'k$(id)', 'k`id`', 'k;id', 'k\nid', 'k id', 'k\\', 'x'.repeat(257)]) {
      expect(parseEnrollKey(bad)).toBeNull();
    }
  });

  it('reduces the Host header to host and port characters', () => {
    expect(sanitizeHost('example.com:443', 'fb')).toBe('example.com:443');
    expect(sanitizeHost('[::1]:4000', 'fb')).toBe('[::1]:4000');
    expect(sanitizeHost("evil.com';$(id)`x`\n;rm", 'fb')).toBe('evil.comidxrm');
    expect(sanitizeHost('', 'fb')).toBe('fb');
    expect(sanitizeHost(undefined, 'fb')).toBe('fb');
  });
});

describe('GET /api/install.sh', () => {
  it('serves a bash installer with the values embedded in single quotes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/install.sh?user=leo&key=${ENROLL_SECRET}`,
      headers: { host: 'watchtower.example.com', 'x-forwarded-proto': 'https' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const s = res.body;
    expect(s.startsWith('#!/bin/bash\n')).toBe(true);
    expect(s).toContain("CHILD_USER='leo'");
    expect(s).toContain(`ENROLL_KEY='${ENROLL_SECRET}'`);
    expect(s).toContain("SERVER_WS_URL='wss://watchtower.example.com/ws/client'");
    expect(s).toContain("SERVER_HTTP_BASE='https://watchtower.example.com'");
    expect(s).toContain(`DOWNLOAD_URL='${releaseAssetUrl('macos')}'`);
    expect(s).toContain("INSTALL_DIR='/Library/Application Support/Watchtower'");
    // Same config.json fields install.ps1 writes.
    expect(s).toContain('"server_url": "%s",');
    expect(s).toContain('"device_id": "%s",');
    expect(s).toContain('"auth_token": "%s",');
    expect(s).toContain('"heartbeat_interval_secs": 3');
    expect(s).toContain('scutil --get LocalHostName');
    // Preflight and verified download.
    expect(s).toContain('[ "$(id -u)" = "0" ]');
    expect(s).toContain('[ "$os_major" -ge 14 ]');
    expect(s).toContain('shasum -a 256');
    // The enrollment secret goes to curl on stdin.
    expect(s).toContain('--data-binary @-');
    expect(s).not.toContain('jq');
    expect(s).not.toContain('python');
    // Generated files are embedded verbatim.
    expect(s).toContain(MAC_AGENT_PLIST);
    expect(s).toContain(MAC_DAEMON_PLIST);
    expect(s).toContain(MAC_HELPER_BODY);
    expect(s).toContain('launchctl bootstrap system "$DAEMON_PLIST"');
    expectSafeEmbeds(s);
    bashSyntaxOk('install.sh', s);
  });

  it('uses ws and http without a forwarded https proto', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/install.sh?user=leo', headers: { host: 'localhost:4000' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SERVER_WS_URL='ws://localhost:4000/ws/client'");
    expect(res.body).toContain("SERVER_HTTP_BASE='http://localhost:4000'");
    expect(res.body).toContain("ENROLL_KEY=''");
  });

  it('rejects a missing user with a 400 bash script that exits 1', async () => {
    for (const url of ['/api/install.sh', '/api/install.sh?user=', '/api/install.sh?key=abc']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('user is required');
      expect(res.body).toContain('exit 1');
      bashSyntaxOk('missing-user.sh', res.body);
    }
  });

  it('rejects hostile user and key values without echoing them', async () => {
    const hostile = ["leo'; rm -rf / #", 'leo$(id)', 'leo`id`', 'leo\nid', 'leo;id', '-leo', '../leo'];
    for (const user of hostile) {
      const res = await app.inject({ method: 'GET', url: '/api/install.sh?user=' + encodeURIComponent(user) });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(user);
      expect(res.body).not.toContain('CHILD_USER=');
      bashSyntaxOk('bad-user.sh', res.body);
    }
    for (const key of ["k'; rm -rf / #", 'k$(id)', 'k`id`', 'k\nid', 'k;id', 'k"x']) {
      const res = await app.inject({ method: 'GET', url: '/api/install.sh?user=leo&key=' + encodeURIComponent(key) });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(key);
      expect(res.body).not.toContain('ENROLL_KEY=');
    }
  });

  it('strips quotes, $(), backticks, ; and newlines from the Host header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/install.sh?user=leo',
      headers: { host: "evil.com';$(touch /tmp/pwned)`id`;x", 'x-forwarded-proto': 'https' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SERVER_HTTP_BASE='https://evil.comtouchtmppwnedidx'");
    expect(res.body).not.toContain('pwned)');
    expectSafeEmbeds(res.body);
    bashSyntaxOk('hostile-host.sh', res.body);
  });
});

describe('generated helper and plists', () => {
  it('helper script is valid bash and swaps the binary by rename only', () => {
    const helper = `#!/bin/bash\nCHILD_UID='501'\n${MAC_HELPER_BODY}`;
    bashSyntaxOk('helper.sh', helper);
    expect(MAC_HELPER_BODY).not.toContain('${');
    // Each run keeps the agent enabled, loaded and running in the child's session.
    expect(MAC_HELPER_BODY).toContain('launchctl print "gui/$CHILD_UID"');
    expect(MAC_HELPER_BODY).toContain('launchctl enable "gui/$CHILD_UID/$AGENT_LABEL"');
    expect(MAC_HELPER_BODY).toContain('launchctl bootstrap "gui/$CHILD_UID" "$AGENT_PLIST"');
    expect(MAC_HELPER_BODY).toContain('launchctl kickstart "gui/$CHILD_UID/$AGENT_LABEL"');
    // Updates: at most every 6 hours, temp file in the install dir, hash verified, mv -f, restart.
    expect(MAC_HELPER_BODY).toContain('UPDATE_INTERVAL_SECS=21600');
    expect(MAC_HELPER_BODY).toContain('mktemp "$INSTALL_DIR/.watchtower-new.XXXXXX"');
    expect(MAC_HELPER_BODY).toContain('mv -f "$new_file" "$BINARY_PATH"');
    expect(MAC_HELPER_BODY).toContain('launchctl kickstart -k "gui/$CHILD_UID/$AGENT_LABEL"');
    expect(MAC_HELPER_BODY).not.toMatch(/\bcp\b/);
  });

  it('plists are well-formed and use the low-profile labels', () => {
    expectWellFormedPlist(MAC_AGENT_PLIST);
    expectWellFormedPlist(MAC_DAEMON_PLIST);
    fs.writeFileSync(path.join(scriptDir, 'local.systemdiagnostics.host.plist'), MAC_AGENT_PLIST);
    fs.writeFileSync(path.join(scriptDir, 'local.systemdiagnostics.helper.plist'), MAC_DAEMON_PLIST);
    expect(MAC_AGENT_PLIST).toContain('<string>local.systemdiagnostics.host</string>');
    expect(MAC_AGENT_PLIST).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(MAC_AGENT_PLIST).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(MAC_AGENT_PLIST).toContain('<string>/Library/Application Support/Watchtower/watchtower</string>');
    expect(MAC_DAEMON_PLIST).toContain('<string>local.systemdiagnostics.helper</string>');
    expect(MAC_DAEMON_PLIST).toContain('<key>StartInterval</key>\n    <integer>60</integer>');
    expect(MAC_DAEMON_PLIST).toContain('<string>/Library/Application Support/Watchtower/helper.sh</string>');
    expect(MAC_AGENT_PLIST + MAC_DAEMON_PLIST).not.toContain('com.apple.');
  });
});

describe('macOS uninstall', () => {
  it('GET /api/uninstall.sh returns only the wrapper, which reads the password from the terminal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/uninstall.sh',
      headers: { host: "evil.com';$(id)`x`", 'x-forwarded-proto': 'https' }
    });
    expect(res.statusCode).toBe(200);
    const s = res.body;
    expect(s).toContain("SERVER_BASE='https://evil.comidx'");
    expect(s).toContain('read -r -s WT_PASSWORD < /dev/tty');
    // Password on curl's stdin, never in the URL or arguments.
    expect(s).toContain(`printf '%s' "$WT_PASSWORD" | curl`);
    expect(s).toContain('--data-binary @-');
    expect(s).toContain('"$SERVER_BASE/api/uninstall/execute?platform=macos"');
    expect(s.match(/\$WT_PASSWORD/g)).toHaveLength(2); // the printf and the -n check
    expect(s).toContain('plutil -extract script raw');
    // Removal commands are not in the wrapper.
    expect(s).not.toContain('bootout');
    expect(s).not.toContain('rm -rf \'/Library');
    expectSafeEmbeds(s);
    bashSyntaxOk('uninstall.sh', s);
  });

  it('serves the macOS removal script for a text/plain password with ?platform=macos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute?platform=macos',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-forwarded-for': '10.0.0.20' },
      payload: ADMIN_PW
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.script).toBe(MAC_REMOVAL_SCRIPT);
    expect(body.script).toContain('# Watchtower macOS removal payload');
    expect(body.script).toContain("launchctl bootout 'system/local.systemdiagnostics.helper'");
    expect(body.script).toContain('launchctl bootout "gui/$wt_uid/local.systemdiagnostics.host"');
    expect(body.script).toContain("rm -f '/Library/LaunchDaemons/local.systemdiagnostics.helper.plist'");
    expect(body.script).toContain("rm -rf '/Library/Application Support/Watchtower'");
    expect(body.script).not.toContain('${');
    bashSyntaxOk('remove.sh', body.script);
  });

  it('checks the password and rate-limits the text/plain form like the JSON one', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute?platform=macos',
      headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.0.21' },
      payload: 'wrong-password'
    });
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body).script).toBeUndefined();
    const limited = await app.inject({
      method: 'POST',
      url: '/api/uninstall/execute?platform=macos',
      headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.0.21' },
      payload: ADMIN_PW
    });
    expect(limited.statusCode).toBe(429);
  });

  it('accepts platform in a JSON body, defaults to Windows, and rejects unknown platforms', async () => {
    const mac = await app.inject({
      method: 'POST', url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.22' },
      payload: { password: ADMIN_PW, platform: 'macos' }
    });
    expect(JSON.parse(mac.body).script).toBe(MAC_REMOVAL_SCRIPT);

    const win = await app.inject({
      method: 'POST', url: '/api/uninstall/execute',
      headers: { 'x-forwarded-for': '10.0.0.22' },
      payload: { password: ADMIN_PW }
    });
    const winScript = JSON.parse(win.body).script;
    expect(winScript.startsWith('# Dynamic Watchtower Removal Payload')).toBe(true);
    expect(winScript).toContain('Unregister-ScheduledTask');

    for (const platform of ['linux', 'macos; rm -rf /', '']) {
      const res = await app.inject({
        method: 'POST', url: '/api/uninstall/execute?platform=' + encodeURIComponent(platform),
        headers: { 'x-forwarded-for': '10.0.0.23' },
        payload: { password: ADMIN_PW }
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('Windows scripts are unchanged by the macOS routes', () => {
  it('install.ps1 and uninstall.ps1 still serve PowerShell', async () => {
    const install = await app.inject({ method: 'GET', url: '/api/install.ps1?user=Leo%20Y' });
    expect(install.body.startsWith('# Watchtower 1-Click Client Installer')).toBe(true);
    expect(install.body).toContain('$TargetUser = "Leo Y"');
    expect(install.body).toContain('releases/latest/download/watchtower.exe');
    const uninstall = await app.inject({ method: 'GET', url: '/api/uninstall.ps1' });
    expect(uninstall.body.startsWith('# Watchtower Secure 1-Click Client Uninstaller')).toBe(true);
    expect(uninstall.body).toContain('Invoke-RestMethod -Uri "$ServerBase/api/uninstall/execute"');
  });
});
