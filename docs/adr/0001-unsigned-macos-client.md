# The macOS client ships unsigned

We decided on 2026-11-18 not to pay for an Apple Developer ID, so the macOS client is ad-hoc signed and installed with `curl | sudo bash`, which keeps Gatekeeper out of the way because `curl` downloads carry no quarantine flag. An ad-hoc signature changes with every build and macOS drops privacy permissions when it does, so the client uses only mechanisms that need no permission prompt.

## Consequences

- The client locks the screen through the private `SACLockScreenImmediate` call, falls back to `pmset displaysleepnow`, checks that the lock happened, and reports to the server when it did not.
- macOS devices send no window titles, so they have no YouTube or IM telemetry. Reading titles needs Screen Recording or Accessibility.
- The client draws its own window for a warning, because notifications from an unbundled binary fail silently.
- Without MDM a Standard user can probably stop the client in their own session. A root launch daemon restarts it and the server's disconnect alert covers the rest.

Buying a Developer ID later would lift the first three limits. It would not lift the fourth.
