# Feature: ZeroTier

Status: **implemented for working-tree installs** (`make install`). `make
pack` leaves it out, with its settings, until it is published.

The tab says at a glance whether ZeroTier works on this computer and how
each joined network is doing. It is informative: networks are joined and
left, and ZeroTier is set to start with the computer, in ZeroTier itself.
The tab's only action is Start/Stop of the service.

## What it shows

- A summary: Running/Stopped, online/offline, and the node ID.
- Notices, most important first:
  - ZeroTier is not installed (no `zerotier-cli` in a system location).
  - ZeroTier is stopped.
  - ZeroTier does not start with the computer (`systemctl is-enabled`).
  - Froonty cannot read ZeroTier's status yet (see "Status access").
  - ZeroTier cannot reach its network (the node is offline: no internet,
    or UDP port 9993 blocked).
  - No networks joined.
- Each joined network: name (or ID), ID, type, addresses, and whether it
  works. A problem is named: not authorized yet in the network's
  controller, network not found, waiting for configuration, port error,
  ZeroTier too old, sign-in required, or connected with no IP address
  assigned.

It reads when the tab opens, on Refresh, and after Start/Stop. It does not
poll.

## First start

On Froonty's first start (`zerotier-install-checked` unset), the ZeroTier
tab is turned off if ZeroTier is not installed. It is checked once; the
tab can be turned on later in Settings → ZeroTier.

## Status access

`zerotier-cli` needs ZeroTier's API token, which only the system can read
(`/var/lib/zerotier-one/authtoken.secret`, mode 600). For other users it
also looks for `~/.zeroTierOneAuthToken`. Settings → ZeroTier → "Read
ZeroTier's status" → Allow runs

```sh
pkexec /usr/bin/install -m 600 -o "$USER" /var/lib/zerotier-one/authtoken.secret ~/.zeroTierOneAuthToken
```

after checking that the destination is not a link. The copy is readable
only by the user. It also lets the user's own programs control ZeroTier
without a password; the settings page says so. Froonty never reads the
token itself.

## Elevated commands

Only with `pkexec`, fixed argument vectors and binaries in root-owned
system locations (never from `$PATH`), no shell:

- Start/Stop: `pkexec systemctl start|stop zerotier-one.service` (tab).
- Allow status access: the `install` command above (settings).

## Publishing (extensions.gnome.org review guidelines)

Checked against <https://gjs.guide/extensions/review-guidelines/review-guidelines.html>
on 2026-10-01:

- Privileged subprocesses use `pkexec` with system binaries that a user
  process cannot modify. The guidelines say to avoid them "at all costs";
  both are explicit user actions, which a reviewer may still question.
- Nothing is created at import: the feature's icon is a getter.
- No synchronous file I/O in the Shell: executables are looked up with
  `query_info_async`.
- Subprocesses are cancelled (SIGTERM) when the tab's service stops, which
  `disable()` does through the hub.
- The settings page imports no Clutter, Meta, St or Shell.
- To publish: drop the ZeroTier lines from `tools/pack-public.sh` and
  `tools/pack-public/` (the stubs, `strip-local-schema.py`'s prefixes and
  `check_zip.py`'s list), and the `local:begin zerotier` / `local:end
  zerotier` markers around its rules in `stylesheet.css`.
