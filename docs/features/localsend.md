# Feature: LocalSend

Status: **implemented for working-tree installs** (`make install`), off by
default (Settings → LocalSend → Show the LocalSend tab). `make pack`
leaves it out, with its settings, until it is published.

Files and text between this computer and a phone (an iPhone, say) or
another computer running the [LocalSend](https://localsend.org) app, over
the local network. Nothing goes through the internet or a cloud service.
Froonty speaks the LocalSend protocol v2
([localsend/protocol](https://github.com/localsend/protocol)) itself, in
a helper process; the LocalSend desktop app is not needed (and must not
run at the same time: both want port 53317).

Why not AirDrop: Apple keeps AirDrop to its own devices. The Linux
reimplementations (OWL + OpenDrop, omdrop-owl) need a Wi-Fi card in
monitor mode and root, switch Wi-Fi off on Intel cards while visible, and
break with iOS updates. LocalSend works on any network with any card.

## Using it

- **iPhone → computer:** in any app, Share → LocalSend → this computer
  ("Froonty (host name)" unless renamed). A notification asks to accept or
  decline (also in the tab); accepted files land in
  `~/Downloads/LocalSend` (the tab's "Change…" by Open folder, or Settings
  → LocalSend → Save received files in; the next transfer goes there, the
  helper keeps running).
  A shared text or link arrives as a notification with Copy (and Open link
  for a link); it is not saved. Cancelled on the iPhone before (or as) it
  is accepted, the question goes away with "… cancelled the transfer".
- **A new device: PIN** (`localsend-pin-first`, on). The first transfer
  from a device not trusted yet is answered "PIN required" (LocalSend's
  own 401): LocalSend on the phone asks for a PIN, and Froonty shows a
  one-time 6-digit PIN in a notification and in the tab ("Tidy Pear wants
  to connect"). Entered there, the transfer is accepted and the device
  trusted. One PIN per sender address, valid 5 minutes; 5 wrong ones and
  it is replaced. A stranger on the network cannot start a transfer at
  all. Off: the first transfer asks for Accept instead, and accepting
  trusts the device.
- **Trusted devices:** their transfers are accepted without asking (the
  files still notify when they are in), but only over ZeroTier or a
  trusted network; on another network they ask. Settings → LocalSend →
  Trusted devices lists them, each with Remove; "Accept automatically
  from trusted devices" (`localsend-auto-accept`, on) off: every transfer
  asks. A device is known by the ID (certificate fingerprint) it
  announces, which another device on the same network could copy: that
  is why auto-accept needs a trusted network. A device that gives no ID is
  never trusted (and asked for a PIN each time).
- **Trusted networks** (`localsend-only-trusted-networks`, on): Froonty
  is visible only on Wi-Fi or wired networks you trusted (the tab's
  Networks list → Trust; Settings lists them with Remove) and on
  ZeroTier, which encrypts and admits only its members. On a café's Wi-Fi
  nothing listens there. Off: visible everywhere, but on an untrusted
  network every transfer asks. A network is its NetworkManager connection
  (UUID): a Wi-Fi by its name and password; a wired profile such as
  "Wired connection 1" is the same on every cable, so trusting it trusts
  every wired network. Without `nmcli`, no network is trusted.
- **Computer → iPhone:** open LocalSend on the iPhone (iOS only lets it
  receive while it is open), then in the tab, "Send files…" next to the
  iPhone, pick the files; the iPhone asks to accept.
- **Away from home (ZeroTier):** with ZeroTier on the phone too and
  "Also over ZeroTier" on, the computer listens on its ZeroTier address.
  Discovery (multicast) does not cross ZeroTier from iOS (tried
  2026-10-18 on a prepaid SIM), so add the phone once in the tab by its
  ZeroTier IP ("Add a device by IP address"): it is kept
  (`localsend-devices`), and Froonty introduces itself to it every 5 s
  (`POST /register`, 3 s timeout), so the computer shows up in LocalSend
  on the phone whenever it is open there, and the phone in the tab. Tried
  with the phone at 10.40.196.27, the laptop at 10.40.196.100: works.

## What the tab shows

- Status: visible as "name" with each network used (Wi-Fi, Wired,
  ZeroTier and its address), hidden, or why it failed (port taken by the
  LocalSend app, no python3, certificate).
- **Hide/Show** (`localsend-visible`): hidden, nothing listens and
  nothing can be sent.
- PINs to enter on a new device (large).
- Transfers waiting to be accepted (Accept/Decline), the one being
  received (percentage), the one being sent (waiting for the other side,
  percentage, Cancel) and its result.
- Networks: each Wi-Fi, wired and ZeroTier network with its address,
  trusted or not, used or hidden, and Trust/Untrust.
- Devices seen, each with "Send files…" (a GTK file chooser of its own
  process); Refresh announces this computer again, so devices answer.
- Added by address: each with whether it answers, and Forget; then "Add a
  device by IP address" (kept until it is an IPv4 address).
- Received lately (this session): each file opens on click; the folder;
  Open folder and Change… (a GTK folder chooser of its own process).

## How it works

- `features/localsend/helper.py` runs with `/usr/bin/python3 -I` and only
  the standard library, in its own process, while the tab is enabled and
  visible (`background` in index.js: the tab need not be opened). Commands
  go in on stdin, one JSON event a line comes out; closing stdin stops it.
  It is restarted 3 times if it stops by itself; not after a fatal error.
- HTTPS with a self-signed certificate made once with `/usr/bin/openssl`
  (`~/.local/share/froonty/localsend`, 0700, key 0600); the fingerprint is
  the certificate's SHA-256. Without openssl it falls back to HTTP, which
  the protocol allows.
- Discovery: UDP multicast 224.0.0.167:53317 (announce, and answers by
  `POST /register` or multicast), plus `/register` from either side.
- Networks: Wi-Fi and wired interfaces, and ZeroTier's (`zt*`) when
  `localsend-zerotier` is on; never loopback, Docker, bridges, virtual
  machines or other VPNs (tun, wg, Tailscale). With trusted networks only,
  an untrusted Wi-Fi or wired one is left out too. The helper reads
  NetworkManager with `nmcli` (not GNOME Shell's NM client, which
  `make devkit`'s private system bus hides) when the interfaces change
  and at least every 60 s. Requests from outside the networks in use
  (or a device added by IP) are refused before TLS.
- Settings that can change while it runs (folder, devices by address,
  trust, PIN) go to the helper as `{"cmd": "update"}`, so a transfer under
  way goes on; the name, port and ZeroTier restart it.
- Receiving: every transfer waits up to 2 minutes for Accept (or none,
  from a trusted device); while it waits, the helper checks twice a second
  whether the sender hung up (its end of the connection closed, or a TLS
  alert), and a `/cancel` from its address withdraws it even before a
  session exists; so does a sender gone as it is accepted. One
  transfer at a time (409 to a second). Uploads must carry the session's
  per-file token from the same IP; more bytes than announced, fewer, or a
  SHA-256 mismatch drop the file and the session. Files are written as
  hidden `.froonty-part` files, then moved under their own name (only its
  last part, control characters dropped) without overwriting: "photo
  (2).heic". A session idle for 90 s is dropped.
- Sending: files only (no folders), one transfer at a time, sizes without
  SHA-256 (optional in the protocol).

## Settings

| Key | Default | |
|---|---|---|
| `localsend-enabled` | `false` | Show the tab (and run the helper) |
| `localsend-visible` | `true` | Listen and send (the tab's Hide/Show) |
| `localsend-pin-first` | `true` | A new device enters a one-time PIN first |
| `localsend-auto-accept` | `true` | Accept from trusted devices without asking (over trusted networks) |
| `localsend-only-trusted-networks` | `true` | Visible only on trusted networks and ZeroTier |
| `localsend-trusted-networks` | `{}` | Trusted networks: NetworkManager UUID → name |
| `localsend-devices` | `[]` | Devices added by address, introduced to every 5 s |
| `localsend-trusted` | `{}` | Trusted devices: fingerprint → name |
| `localsend-alias` | `''` | Name others see; empty: "Froonty (host name)" |
| `localsend-folder` | `''` | Received files; empty: Downloads/LocalSend |
| `localsend-zerotier` | `true` | Also on ZeroTier interfaces |
| `localsend-port` | `53317` | TCP and UDP port |

A firewall must allow the port: `sudo ufw allow 53317/tcp` and
`sudo ufw allow 53317/udp` (Ubuntu's ufw is off unless turned on).

## Tests

- `tools/unit/localsend.test.js`: the service's state from helper events
  (fake helper and notifier).
- `tools/unit/test_localsend_helper.py`: file names, interfaces, and two
  helpers on 127.0.0.1 exchanging files, a declined offer, bad tokens, a
  wrong size, a text message, a refused address, a sender hanging up or
  cancelling while the offer waits, the PIN (401, wrong tries, replaced),
  network trust, introducing itself to a device added by address, a new
  folder for the next transfer.
- By hand, with the iPhone: both directions on Wi-Fi; over ZeroTier.

## Not done

- Sending folders or text, the reverse (browser download) API.
- A device's identity is what it announces (LocalSend has no client
  certificate check here): the PIN and trusted networks limit who can
  claim one.
