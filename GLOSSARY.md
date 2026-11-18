# Watchtower

Watchtower lets a parent limit and observe a child's screen time on the child's own computers.

## Language

**Device**:
One computer a child uses, with its own policy and usage record.
_Avoid_: PC, machine, computer

**Client**:
The Watchtower program installed on a device, which reports activity and carries out the server's decisions.
_Avoid_: Daemon, agent, service

**Platform**:
The operating system family a device runs, either Windows or macOS. A device that reports none is Windows.
_Avoid_: OS, system

**Lock**:
Sending a device to its password screen while the child's session and open work stay intact.
_Avoid_: Logoff, sign out, shutdown

**Warning**:
A notice the client shows the child shortly before a lock.
_Avoid_: Toast, notification, alert

**App identifier**:
The stable name a platform gives an app, which rules match against: the executable name on Windows, the bundle identifier on macOS.
_Avoid_: Executable name, process name, exe

**Display name**:
The human-readable name of an app, shown to the parent and never matched by rules.
_Avoid_: App name, title
