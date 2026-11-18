// macOS install, helper and removal scripts served by routes/api.ts.
//
// Every script here is a TypeScript template string holding bash. Inside them:
// backslashes are doubled, there are no backticks, and the bash never uses the
// brace form of parameter expansion (dollar sign followed by an opening brace),
// because the template would interpolate it. Values from the request are reduced
// to an allowlist of characters first and embedded inside single quotes.

import { releaseAssetUrl } from '../release/latest.js';

export const MAC_INSTALL_DIR = '/Library/Application Support/Watchtower';
export const MAC_AGENT_LABEL = 'local.systemdiagnostics.host';
export const MAC_DAEMON_LABEL = 'local.systemdiagnostics.helper';
export const MAC_AGENT_PLIST_PATH = `${MAC_INSTALL_DIR}/${MAC_AGENT_LABEL}.plist`;
export const MAC_DAEMON_PLIST_PATH = `/Library/LaunchDaemons/${MAC_DAEMON_LABEL}.plist`;
export const MAC_HELPER_PATH = `${MAC_INSTALL_DIR}/helper.sh`;
export const MAC_HELPER_LOG = `/var/log/${MAC_DAEMON_LABEL}.log`;
export const MAC_DOWNLOAD_URL = releaseAssetUrl('macos');

/**
 * A macOS short account name: letters, digits, '.', '_' and '-', not starting
 * with '-', at most 64 characters. Returns '' when the value is missing and
 * null when it contains anything else, so the caller can reject it instead of
 * installing for a different account than the one the parent typed.
 */
export function parseMacUser(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(raw)) return null;
  return raw;
}

/**
 * An enrollment secret. Generated secrets are hex; operator-set ones
 * (DEVICE_ENROLLMENT_SECRET) may use common punctuation. Nothing here can end a
 * bash single-quoted string or a JSON string: no quotes, backslashes, backticks,
 * dollar signs, whitespace or control characters. '' when missing, null when
 * the value has other characters.
 */
export function parseEnrollKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9._~+\/=:@,!#%*^-]{1,256}$/.test(raw)) return null;
  return raw;
}

/** The Host header reduced to hostname/IP/port characters. */
export function sanitizeHost(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9.:\[\]-]/g, '').slice(0, 253) : '';
  return s || fallback;
}

/** A tiny bash script that prints an error and exits 1 (served with a 4xx status). */
export function macErrorScript(message: string): string {
  const safe = message.replace(/[^A-Za-z0-9 .,:;=?()\/_-]/g, '');
  return `#!/bin/bash
printf 'Watchtower: %s\\n' '${safe}' >&2
exit 1
`;
}

// The launch agent that runs the client as the child, inside their GUI session.
// Stored root-owned in the install directory (not /Library/LaunchAgents, which
// would load it for every account); the helper bootstraps it into gui/<uid>.
export const MAC_AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${MAC_INSTALL_DIR}/watchtower</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;

// The root launch daemon that runs the helper at load and every 60 seconds.
export const MAC_DAEMON_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_DAEMON_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${MAC_HELPER_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${MAC_HELPER_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${MAC_HELPER_LOG}</string>
</dict>
</plist>
`;

// The helper, minus its first two lines (the shebang and CHILD_UID='<uid>'),
// which the installer writes. Runs as root. Each run it (1) makes sure the
// client agent is enabled, loaded into the child's GUI session and running,
// when that session exists, and (2) at most every 6 hours compares the
// installed binary with the published checksum and swaps in a verified new
// binary by rename. Any failure keeps the current binary running.
export const MAC_HELPER_BODY = `# Watchtower helper. launchd runs it as root at load and every 60 seconds.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

INSTALL_DIR='${MAC_INSTALL_DIR}'
BINARY_PATH="$INSTALL_DIR/watchtower"
AGENT_LABEL='${MAC_AGENT_LABEL}'
AGENT_PLIST="$INSTALL_DIR/${MAC_AGENT_LABEL}.plist"
STAMP_PATH="$INSTALL_DIR/.last-update-check"
DOWNLOAD_URL='${MAC_DOWNLOAD_URL}'
UPDATE_INTERVAL_SECS=21600
RETRY_AFTER_FAILURE_SECS=1800

log() {
    printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# Keep the client agent loaded and running in the child's GUI session. A
# Standard user can boot out or disable an agent in their own session, so this
# undoes that within a minute.
ensure_agent() {
    launchctl print "gui/$CHILD_UID" >/dev/null 2>&1 || return 0
    launchctl enable "gui/$CHILD_UID/$AGENT_LABEL" >/dev/null 2>&1
    if ! launchctl print "gui/$CHILD_UID/$AGENT_LABEL" >/dev/null 2>&1; then
        if launchctl bootstrap "gui/$CHILD_UID" "$AGENT_PLIST" >/dev/null 2>&1; then
            log "client agent loaded into gui/$CHILD_UID"
        else
            return 0
        fi
    fi
    if ! launchctl print "gui/$CHILD_UID/$AGENT_LABEL" 2>/dev/null | grep -q 'state = running'; then
        if launchctl kickstart "gui/$CHILD_UID/$AGENT_LABEL" >/dev/null 2>&1; then
            log "client agent started"
        fi
    fi
}

# Schedule the next update check soon instead of in 6 hours.
retry_update_soon() {
    echo $(( $1 - UPDATE_INTERVAL_SECS + RETRY_AFTER_FAILURE_SECS )) > "$STAMP_PATH"
}

maybe_update() {
    now=$(date +%s)
    last=$(cat "$STAMP_PATH" 2>/dev/null)
    case "$last" in
        ''|*[!0-9]*) last=0 ;;
    esac
    [ $(( now - last )) -ge "$UPDATE_INTERVAL_SECS" ] || return 0
    echo "$now" > "$STAMP_PATH"

    # Leftovers from an interrupted run.
    rm -f "$INSTALL_DIR"/.watchtower-new.*

    expected=$(curl -fsSL --connect-timeout 20 --max-time 60 "$DOWNLOAD_URL.sha256" </dev/null | grep -oE '[0-9a-fA-F]{64}' | head -n 1 | tr 'A-F' 'a-f')
    if [ -z "$expected" ]; then
        log "update check failed: could not read the published checksum"
        retry_update_soon "$now"
        return 0
    fi
    current=$(shasum -a 256 "$BINARY_PATH" 2>/dev/null | cut -d ' ' -f 1)
    [ "$current" = "$expected" ] && return 0

    # Download next to the binary so the final mv is an atomic rename on the
    # same volume. Never copy over or rewrite the running binary in place:
    # Apple Silicon kills a process whose signed pages change under it.
    new_file=$(mktemp "$INSTALL_DIR/.watchtower-new.XXXXXX") || return 0
    if ! curl -fsSL --connect-timeout 20 --max-time 600 -o "$new_file" "$DOWNLOAD_URL" </dev/null; then
        rm -f "$new_file"
        log "update download failed; keeping the current client"
        retry_update_soon "$now"
        return 0
    fi
    got=$(shasum -a 256 "$new_file" | cut -d ' ' -f 1)
    if [ "$got" != "$expected" ]; then
        rm -f "$new_file"
        log "downloaded client hash $got does not match $expected; keeping the current client"
        retry_update_soon "$now"
        return 0
    fi
    if ! chown root:wheel "$new_file" || ! chmod 755 "$new_file"; then
        rm -f "$new_file"
        return 0
    fi
    if ! mv -f "$new_file" "$BINARY_PATH"; then
        rm -f "$new_file"
        log "could not replace the client binary; keeping the current client"
        return 0
    fi
    log "client updated to $expected"
    if launchctl print "gui/$CHILD_UID/$AGENT_LABEL" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$CHILD_UID/$AGENT_LABEL" >/dev/null 2>&1
    fi
}

[ "$(id -u)" = "0" ] || exit 0
case "$CHILD_UID" in
    ''|*[!0-9]*) exit 0 ;;
esac
[ -f "$AGENT_PLIST" ] || exit 0

ensure_agent
maybe_update
exit 0
`;

// Stops and removes every part of an install. Shared by the installer (to make
// re-running safe) and the removal payload. The daemon goes first so the
// helper cannot load the agent again while it is being removed.
const MAC_TEARDOWN_FN = `wt_teardown() {
    launchctl bootout 'system/${MAC_DAEMON_LABEL}' >/dev/null 2>&1
    rm -f '${MAC_DAEMON_PLIST_PATH}'
    # Every GUI session the agent may be loaded in: local accounts plus any
    # account with a running process.
    for wt_uid in $( { dscl . -list /Users UniqueID 2>/dev/null | awk '{ print $2 }'; ps -axo uid= 2>/dev/null; } | awk '$1 >= 500 { print $1 }' | sort -un ); do
        if launchctl print "gui/$wt_uid/${MAC_AGENT_LABEL}" >/dev/null 2>&1; then
            launchctl bootout "gui/$wt_uid/${MAC_AGENT_LABEL}" >/dev/null 2>&1
        fi
    done
    pkill -f '${MAC_INSTALL_DIR}/watchtower' >/dev/null 2>&1
    rm -rf '${MAC_INSTALL_DIR}'
}`;

export interface MacInstallOptions {
  user: string;     // validated with parseMacUser, non-empty
  enrollKey: string; // validated with parseEnrollKey, may be ''
  wsUrl: string;    // built from a sanitized host
  httpBase: string; // built from a sanitized host
}

export function macInstallScript(o: MacInstallOptions): string {
  return `#!/bin/bash
# Watchtower macOS client installer. Run it as root from an admin account:
#   curl -fsSL '${o.httpBase}/api/install.sh?user=${o.user}' | sudo bash
# Everything is inside a function so bash reads the whole script before it
# runs any of it.

wt_install() {
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

CHILD_USER='${o.user}'
ENROLL_KEY='${o.enrollKey}'
SERVER_WS_URL='${o.wsUrl}'
SERVER_HTTP_BASE='${o.httpBase}'
DOWNLOAD_URL='${MAC_DOWNLOAD_URL}'

INSTALL_DIR='${MAC_INSTALL_DIR}'
BINARY_PATH="$INSTALL_DIR/watchtower"
CONFIG_PATH="$INSTALL_DIR/config.json"
HELPER_PATH='${MAC_HELPER_PATH}'
STAMP_PATH="$INSTALL_DIR/.last-update-check"
AGENT_LABEL='${MAC_AGENT_LABEL}'
AGENT_PLIST='${MAC_AGENT_PLIST_PATH}'
DAEMON_LABEL='${MAC_DAEMON_LABEL}'
DAEMON_PLIST='${MAC_DAEMON_PLIST_PATH}'
HELPER_LOG='${MAC_HELPER_LOG}'

fail() {
    printf '❌ %s\\n' "$*" >&2
    exit 1
}

# Failure after the previous install was removed: remove the partial one too,
# so nothing is left that looks installed but does not run.
abort_install() {
    wt_teardown
    fail "$* Nothing is installed now. Fix the problem and run the installer again."
}

${MAC_TEARDOWN_FN}

printf '🛡️  Installing the Watchtower client for macOS...\\n'

# 1. Preflight: root, macOS 14 or later on Apple Silicon, an existing account.
[ "$(id -u)" = "0" ] || fail "Run the installer as root: curl -fsSL '$SERVER_HTTP_BASE/api/install.sh?user=$CHILD_USER' | sudo bash"
[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows use install.ps1."
arch_ok=0
[ "$(uname -m)" = "arm64" ] && arch_ok=1
[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] && arch_ok=1
[ "$arch_ok" = "1" ] || fail "The Watchtower macOS client needs an Apple Silicon Mac."
os_version=$(sw_vers -productVersion 2>/dev/null)
os_major=$(printf '%s' "$os_version" | cut -d . -f 1)
case "$os_major" in
    ''|*[!0-9]*) fail "Could not read the macOS version." ;;
esac
[ "$os_major" -ge 14 ] || fail "Watchtower needs macOS 14 or later. This Mac runs macOS $os_version."
for tool in curl shasum launchctl plutil scutil dscl dseditgroup; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required tool $tool is missing."
done

CHILD_UID=$(id -u "$CHILD_USER" 2>/dev/null)
case "$CHILD_UID" in
    ''|*[!0-9]*) fail "There is no account named '$CHILD_USER' on this Mac. Use the account's short name (dscl . -list /Users shows them)." ;;
esac
[ "$CHILD_UID" -ge 500 ] || fail "'$CHILD_USER' is a system account. Use the child's own account."
if dseditgroup -o checkmember -m "$CHILD_USER" admin >/dev/null 2>&1; then
    printf '⚠️  %s is an administrator and could remove Watchtower. Make it a Standard account in System Settings, Users and Groups.\\n' "$CHILD_USER"
fi

# 2. Download and verify the client before touching any previous install, so a
#    failed download leaves the current client running.
STAGE_DIR=$(mktemp -d '/Library/Application Support/.watchtower-install.XXXXXX') || fail "Could not create a temporary folder."
trap 'rm -rf "$STAGE_DIR"' EXIT
printf '📥 Downloading the client from GitHub...\\n'
curl -fsSL --retry 3 --connect-timeout 20 -o "$STAGE_DIR/watchtower" "$DOWNLOAD_URL" </dev/null || fail "Could not download $DOWNLOAD_URL. Nothing was changed."
expected_hash=$(curl -fsSL --retry 3 --connect-timeout 20 "$DOWNLOAD_URL.sha256" </dev/null | grep -oE '[0-9a-fA-F]{64}' | head -n 1 | tr 'A-F' 'a-f')
[ -n "$expected_hash" ] || fail "Could not read the published checksum $DOWNLOAD_URL.sha256. Nothing was changed."
actual_hash=$(shasum -a 256 "$STAGE_DIR/watchtower" | cut -d ' ' -f 1)
[ "$actual_hash" = "$expected_hash" ] || fail "The downloaded client does not match its published checksum. Nothing was changed."
printf ' Download verified (SHA-256 %s).\\n' "$actual_hash"

# 3. Enroll this device for a device-bound token when a key was given.
DEVICE_ID=$(scutil --get LocalHostName 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c 1-64)
[ -n "$DEVICE_ID" ] || DEVICE_ID=$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c 1-64)
[ -n "$DEVICE_ID" ] || DEVICE_ID='Mac'
AUTH_TOKEN=''
if [ -n "$ENROLL_KEY" ]; then
    # The secret goes to curl on stdin (printf is a shell builtin), never in
    # process arguments.
    enroll_response=$(printf '{"deviceId":"%s","enrollmentSecret":"%s"}' "$DEVICE_ID" "$ENROLL_KEY" | curl -sS --connect-timeout 20 --max-time 60 -X POST -H 'Content-Type: application/json' --data-binary @- "$SERVER_HTTP_BASE/api/devices/enroll")
    token=$(printf '%s' "$enroll_response" | plutil -extract token raw -o - - 2>/dev/null)
    case "$token" in
        ''|*[!A-Za-z0-9._-]*)
            printf '⚠️  Device enrollment failed. If REQUIRE_DEVICE_AUTH is on, the server will reject this client.\\n'
            ;;
        *)
            AUTH_TOKEN="$token"
            printf ' Device enrolled as %s.\\n' "$DEVICE_ID"
            ;;
    esac
else
    printf '⚠️  No enrollment key given (&key=...). If REQUIRE_DEVICE_AUTH is on, the server will reject this client.\\n'
fi

# 4. Remove any previous install so re-running is safe.
printf '🧹 Removing any previous install...\\n'
wt_teardown

# 5. Install files: root-owned, not writable by the child.
mkdir -p "$INSTALL_DIR" || abort_install "Could not create $INSTALL_DIR."
chown root:wheel "$INSTALL_DIR" && chmod 755 "$INSTALL_DIR" || abort_install "Could not set permissions on $INSTALL_DIR."
mv -f "$STAGE_DIR/watchtower" "$BINARY_PATH" || abort_install "Could not move the client into place."
chown root:wheel "$BINARY_PATH" && chmod 755 "$BINARY_PATH" || abort_install "Could not set permissions on the client."

printf '{\\n  "server_url": "%s",\\n  "device_id": "%s",\\n  "auth_token": "%s",\\n  "heartbeat_interval_secs": 3\\n}\\n' "$SERVER_WS_URL" "$DEVICE_ID" "$AUTH_TOKEN" > "$CONFIG_PATH" || abort_install "Could not write $CONFIG_PATH."
# The client runs as the child and reads its config, so it is world-readable.
chown root:wheel "$CONFIG_PATH" && chmod 644 "$CONFIG_PATH" || abort_install "Could not set permissions on $CONFIG_PATH."
plutil -extract device_id raw -o - "$CONFIG_PATH" >/dev/null 2>&1 || abort_install "The generated $CONFIG_PATH is not valid JSON."
printf ' Configuration saved: connects to %s as %s.\\n' "$SERVER_WS_URL" "$DEVICE_ID"

cat > "$AGENT_PLIST" <<'WT_AGENT_PLIST_EOF' || abort_install "Could not write $AGENT_PLIST."
${MAC_AGENT_PLIST}WT_AGENT_PLIST_EOF

{
    printf '#!/bin/bash\\n'
    printf "CHILD_UID='%s'\\n" "$CHILD_UID"
    cat <<'WT_HELPER_EOF'
${MAC_HELPER_BODY}WT_HELPER_EOF
} > "$HELPER_PATH" || abort_install "Could not write $HELPER_PATH."

cat > "$DAEMON_PLIST" <<'WT_DAEMON_PLIST_EOF' || abort_install "Could not write $DAEMON_PLIST."
${MAC_DAEMON_PLIST}WT_DAEMON_PLIST_EOF

chown root:wheel "$AGENT_PLIST" "$HELPER_PATH" "$DAEMON_PLIST" || abort_install "Could not set file owners."
chmod 644 "$AGENT_PLIST" "$DAEMON_PLIST" && chmod 755 "$HELPER_PATH" || abort_install "Could not set file permissions."
plutil -lint "$AGENT_PLIST" >/dev/null || abort_install "The agent plist is not valid."
plutil -lint "$DAEMON_PLIST" >/dev/null || abort_install "The daemon plist is not valid."
bash -n "$HELPER_PATH" || abort_install "The helper script is not valid."

# The client was just installed, so the helper's first update check can wait.
date +%s > "$STAMP_PATH"
chown root:wheel "$STAMP_PATH"
chmod 644 "$STAMP_PATH"
touch "$HELPER_LOG"
chmod 644 "$HELPER_LOG"

# 6. Load the daemon. It runs the helper now, which starts the client in the
#    child's session if they are logged in, and again every minute.
launchctl enable "system/$DAEMON_LABEL" >/dev/null 2>&1
launchctl bootstrap system "$DAEMON_PLIST" || abort_install "Could not load the launch daemon $DAEMON_LABEL."
printf ' Launch daemon %s loaded.\\n' "$DAEMON_LABEL"

printf '🔒 The lock fallback only works when %s requires a password immediately after sleep. Log in as %s once and set System Settings, Lock Screen, "Require password after screen saver begins or display is turned off" to Immediately.\\n' "$CHILD_USER" "$CHILD_USER"

if launchctl print "gui/$CHILD_UID" >/dev/null 2>&1; then
    wt_i=0
    while [ "$wt_i" -lt 20 ]; do
        if launchctl print "gui/$CHILD_UID/$AGENT_LABEL" 2>/dev/null | grep -q 'state = running'; then
            printf ' Watchtower is installed and running in %s'"'"'s session. Only an administrator can remove it.\\n' "$CHILD_USER"
            exit 0
        fi
        sleep 1
        wt_i=$(( wt_i + 1 ))
    done
    fail "Watchtower is installed but the client has not started in $CHILD_USER's session yet. The helper retries every minute; if the device does not appear in the dashboard, check $HELPER_LOG."
fi
printf ' Watchtower is installed. %s is not logged in now; the client starts within a minute of their next login. Only an administrator can remove it.\\n' "$CHILD_USER"
exit 0
}

wt_install
`;
}

export function macUninstallWrapperScript(baseUrl: string): string {
  return `#!/bin/bash
# Watchtower macOS protected uninstaller. Run it as root from an admin account:
#   curl -fsSL '${baseUrl}/api/uninstall.sh' | sudo bash
# It asks for the Watchtower parent password, sends it to the server on curl's
# stdin (never in a URL or a process argument) and runs the removal script the
# server returns once the password checks out.

wt_uninstall() {
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

SERVER_BASE='${baseUrl}'

fail() {
    printf '❌ %s\\n' "$*" >&2
    exit 1
}

printf '🛡️  Watchtower protected uninstaller\\n'
[ "$(id -u)" = "0" ] || fail "Run the uninstaller as root: curl -fsSL '$SERVER_BASE/api/uninstall.sh' | sudo bash"
[ "$(uname -s)" = "Darwin" ] || fail "This uninstaller is for macOS. On Windows use uninstall.ps1."

# The script itself arrives on stdin through the pipe, so read the password
# from the terminal.
if ! { printf 'Enter the Watchtower parent password: ' > /dev/tty; } 2>/dev/null; then
    fail "No terminal to read the password from. Run this command in Terminal."
fi
IFS= read -r -s WT_PASSWORD < /dev/tty || fail "Could not read the password."
printf '\\n' > /dev/tty
[ -n "$WT_PASSWORD" ] || fail "The password is required to uninstall Watchtower."

WORK_DIR=$(mktemp -d /tmp/watchtower-uninstall.XXXXXX) || fail "Could not create a temporary folder."
trap 'rm -rf "$WORK_DIR"' EXIT

printf '🔐 Checking the password with the Watchtower server...\\n'
http_code=$(printf '%s' "$WT_PASSWORD" | curl -sS --connect-timeout 20 --max-time 60 -o "$WORK_DIR/response.json" -w '%{http_code}' -X POST -H 'Content-Type: text/plain; charset=utf-8' --data-binary @- "$SERVER_BASE/api/uninstall/execute?platform=macos")
WT_PASSWORD=''
case "$http_code" in
    200) ;;
    401) fail "Incorrect Watchtower password. Wait a few seconds before trying again." ;;
    429) fail "Too many failed attempts. Wait a few minutes before trying again." ;;
    *) fail "The server did not return the removal script (HTTP $http_code)." ;;
esac

plutil -extract script raw -o "$WORK_DIR/remove.sh" "$WORK_DIR/response.json" >/dev/null 2>&1 || fail "The server response had no removal script."
grep -q '^# Watchtower macOS removal payload' "$WORK_DIR/remove.sh" || fail "The server returned an unexpected removal script."
/bin/bash "$WORK_DIR/remove.sh"
exit $?
}

wt_uninstall
`;
}

export const MAC_REMOVAL_SCRIPT = `#!/bin/bash
# Watchtower macOS removal payload
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

if [ "$(id -u)" != "0" ]; then
    printf '❌ The removal script must run as root.\\n' >&2
    exit 1
fi

${MAC_TEARDOWN_FN}

printf '🛑 Removing the Watchtower client...\\n'
wt_teardown
rm -f '${MAC_HELPER_LOG}'

if [ -e '${MAC_INSTALL_DIR}' ] || [ -e '${MAC_DAEMON_PLIST_PATH}' ] || launchctl print 'system/${MAC_DAEMON_LABEL}' >/dev/null 2>&1; then
    printf '❌ Some Watchtower files or services could not be removed. Run the uninstaller again.\\n' >&2
    exit 1
fi
printf ' Watchtower has been removed from this Mac.\\n'
exit 0
`;
