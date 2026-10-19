# SPDX-License-Identifier: GPL-3.0-or-later
"""The LocalSend tab's helper (docs/features/localsend.md).

A LocalSend protocol v2 peer (https://github.com/localsend/protocol): it
answers discovery, receives files the user accepted, and sends files to
a LocalSend app (the iPhone's). Runs in a process of its own, with the
system Python and only its standard library: never inside GNOME Shell.

    helper.py serve

stdin, one JSON object a line: first the configuration

    {"alias": "Froonty", "folder": "/home/u/Downloads", "port": 53317,
     "zerotier": true, "manual": ["10.40.196.27"], "trusted": [FINGERPRINT],
     "trustedNetworks": [NM_UUID], "onlyTrusted": true, "pinFirst": true}

then commands:

    {"cmd": "accept", "id": OFFER} / {"cmd": "decline", "id": OFFER}
    {"cmd": "scan"}                    announce again (peers answer)
    {"cmd": "add", "address": "10.0.0.5"}   introduce itself to it now
    {"cmd": "update", ...}             any configuration field but alias,
                                       port and zerotier
    {"cmd": "send", "to": FINGERPRINT, "paths": [...]}
    {"cmd": "cancel-send"}

stdout, one JSON event a line: ready, peers, pin, pin-gone, offer,
offer-gone, progress, received, message, cancelled, send-progress,
send-done, send-failed, warning, fatal (see emit() calls). Closing stdin
stops it.

Only Wi-Fi and wired interfaces are used, and ZeroTier's (zt*) when the
configuration allows it; Docker, bridges, other VPNs and loopback never.
With onlyTrusted, a Wi-Fi or wired network is used only if its
NetworkManager connection (nmcli) is one of trustedNetworks: elsewhere (a
cafe) only ZeroTier. A request from an address outside the networks in
use is refused. The addresses in "manual" (a phone on ZeroTier, which
multicast does not reach) are introduced to every few seconds, so this
computer shows up there whenever LocalSend is open.

With pinFirst, a device not in "trusted" must give a one-time PIN, shown
in Froonty, before its first transfer is even offered (LocalSend asks
for it): a stranger on the network cannot start one. Nothing is written
without the user accepting it (or that PIN); files go to the chosen
folder under their own name (made safe, never overwriting).

Its key and self-signed certificate (made once with the system openssl)
live in ~/.local/share/froonty/localsend (0700, key 0600).
"""

import errno
import fcntl
import hashlib
import http.client
import ipaddress
import json
import mimetypes
import os
import secrets
import select
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PROTOCOL_VERSION = "2.1"
MULTICAST_GROUP = "224.0.0.167"
DEFAULT_PORT = 53317
API = "/api/localsend/v2/"
# How long the sender waits for the user to accept, and how long an
# accepted session may sit without data before it is dropped.
OFFER_TIMEOUT_S = 120
SESSION_IDLE_S = 90
SEND_ANSWER_TIMEOUT_S = 300
PEER_FORGET_S = 30 * 60
MAX_BODY = 4 * 1024 * 1024  # JSON bodies (prepare-upload with previews)
MAX_FILES = 10000
CHUNK = 256 * 1024
PROGRESS_EVERY_S = 0.3
# Devices added by address: introduced to this often, each try at most
# INTRODUCE_TIMEOUT_S (a phone with LocalSend closed does not answer).
INTRODUCE_EVERY_S = 5
INTRODUCE_TIMEOUT_S = 3
# NetworkManager's connections are read when the interfaces change, and
# at least this often (another Wi-Fi with the same address).
NM_REFRESH_S = 60
# A PIN lasts this long, and this many wrong tries make a new one.
PIN_TTL_S = 300
PIN_TRIES = 5
# Interfaces never used: containers, bridges, other VPNs, loopback.
SKIPPED_PREFIXES = ("lo", "docker", "br-", "veth", "virbr", "vnet", "tun", "tap", "wg",
                    "tailscale", "vboxnet", "vmnet", "lxc", "lxd", "podman", "cni", "flannel")
ZEROTIER_PREFIX = "zt"
SIOCGIFADDR = 0x8915
SIOCGIFNETMASK = 0x891B


def data_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "froonty" / "localsend"


_out_lock = threading.Lock()


def emit(event, **fields):
    with _out_lock:
        sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------- names

def safe_name(name):
    """A file name that stays in the folder: the last part of what the
    sender sent, without control characters, never empty, "." or ".."."""
    name = str(name or "").replace("\\", "/").split("/")[-1]
    name = "".join(c for c in name if unicodedata.category(c)[0] != "C").strip()
    if name in ("", ".", ".."):
        name = "file"
    # 255 bytes is the usual limit; leave room for " (99)" and the part suffix.
    while len(name.encode("utf-8")) > 200:
        stem, dot, ext = name.rpartition(".")
        if dot and stem and len(ext) < 16:
            name = stem[:-1] + "." + ext
        else:
            name = name[:-1]
    return name


def numbered(name, n):
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        return f"{name} ({n})"
    return f"{stem} ({n}).{ext}"


def place(part_path, folder, name):
    """Moves a finished part file to `folder` under `name`, or "name (2)"
    and so on: never over an existing file. Returns the final path."""
    for n in range(1, 10000):
        target = folder / (name if n == 1 else numbered(name, n))
        try:
            os.link(part_path, target)
        except FileExistsError:
            continue
        except OSError as e:
            if e.errno not in (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP):
                raise
            # A file system without hard links: no atomic no-clobber move.
            if target.exists():
                continue
            os.rename(part_path, target)
            return target
        os.unlink(part_path)
        return target
    raise OSError("no free file name")


# ------------------------------------------------------------ networks

def _ifreq(sock, request, name):
    packed = fcntl.ioctl(sock.fileno(), request, struct.pack("256s", name[:15].encode()))
    return socket.inet_ntoa(packed[20:24])


def _ipv4(text):
    try:
        ipaddress.IPv4Address(text)
        return True
    except ValueError:
        return False


def interface_allowed(name, zerotier):
    if name.startswith(ZEROTIER_PREFIX):
        return zerotier
    return not name.startswith(SKIPPED_PREFIXES)


def networks(zerotier):
    """{interface: IPv4Interface} of the usable interfaces that are up."""
    found = {}
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for _index, name in socket.if_nameindex():
            if not interface_allowed(name, zerotier):
                continue
            try:
                address = _ifreq(probe, SIOCGIFADDR, name)
                mask = _ifreq(probe, SIOCGIFNETMASK, name)
            except OSError:
                continue  # no IPv4 address (down, or IPv6 only)
            found[name] = ipaddress.IPv4Interface(f"{address}/{mask}")
    finally:
        probe.close()
    return found


def interface_kind(name, nm_type=""):
    if name.startswith(ZEROTIER_PREFIX):
        return "zerotier"
    if nm_type == "802-11-wireless" or name.startswith("wl"):
        return "wifi"
    return "wired"


def nm_connections():
    """{interface: {"uuid", "name", "type"}} of NetworkManager's active
    connections; {} without nmcli (then no network counts as trusted)."""
    nmcli = next((p for p in ("/usr/bin/nmcli", "/bin/nmcli") if os.access(p, os.X_OK)), None)
    if not nmcli:
        return {}
    try:
        out = subprocess.run([nmcli, "-t", "-e", "yes", "-f", "UUID,TYPE,DEVICE,NAME", "connection", "show", "--active"],
                             capture_output=True, text=True, timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    found = {}
    for line in out.splitlines():
        # NAME is last, and may hold escaped colons.
        parts = line.split(":", 3)
        if len(parts) == 4 and parts[2]:
            found[parts[2]] = {"uuid": parts[0], "type": parts[1], "name": parts[3].replace("\\:", ":")}
    return found


# --------------------------------------------------------- certificate

def ensure_certificate(folder):
    """(cert path, key path, fingerprint), made once; or None without
    openssl (then the helper speaks plain HTTP, which LocalSend allows)."""
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    cert, key = folder / "cert.pem", folder / "key.pem"
    if not (cert.exists() and key.exists()):
        openssl = next((p for p in ("/usr/bin/openssl", "/bin/openssl") if os.access(p, os.X_OK)), None)
        if not openssl:
            return None
        old = os.umask(0o077)
        try:
            subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-keyout", str(key), "-out", str(cert), "-days", "3650",
                            "-subj", "/CN=LocalSend User"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        finally:
            os.umask(old)
    der = ssl.PEM_cert_to_DER_cert(cert.read_text())
    return cert, key, hashlib.sha256(der).hexdigest().upper()


def client_context():
    # LocalSend peers use self-signed certificates: the protocol has no
    # authority to check them against.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


# ---------------------------------------------------------------- peer

class Peer:
    def __init__(self, config):
        self.alias = config["alias"]
        self.folder = Path(config["folder"])
        self.port = int(config.get("port") or DEFAULT_PORT)
        self.zerotier = bool(config.get("zerotier"))
        self.lock = threading.Lock()
        self.networks = {}  # in use
        self.candidates = {}  # every usable interface, used or not
        self.nm = {}  # interface -> NetworkManager connection
        self.peers = {}  # fingerprint -> dict (+ ip, seen)
        self.manual = set()  # addresses the user added
        self.trusted = set()  # fingerprints that need no PIN
        self.trusted_networks = set()  # NetworkManager connection UUIDs
        self.only_trusted = False
        self.pin_first = False
        self.pins = {}  # sender ip -> {"pin", "expires", "fails", "sender"}
        self.wake = threading.Event()
        self.offers = {}  # id -> {"event", "decision", "ip", "withdrawn"}
        self.session = None
        self.sending = None
        self.cert = ensure_certificate(data_dir())
        if self.cert:
            self.protocol = "https"
            self.fingerprint = self.cert[2]
        else:
            self.protocol = "http"
            self.fingerprint = secrets.token_hex(16).upper()
        self.multicast = None
        self.server = None
        self.update(config)

    def update(self, config):
        """Takes the fields of `config` that may change while it runs."""
        with self.lock:
            if "folder" in config:
                self.folder = Path(config["folder"])
            if "manual" in config:
                self.manual = {a for a in map(str, config["manual"] or []) if _ipv4(a)}
            if "trusted" in config:
                self.trusted = set(map(str, config["trusted"] or []))
            if "trustedNetworks" in config:
                self.trusted_networks = set(map(str, config["trustedNetworks"] or []))
            if "onlyTrusted" in config:
                self.only_trusted = bool(config["onlyTrusted"])
            if "pinFirst" in config:
                self.pin_first = bool(config["pinFirst"])
        self.wake.set()  # the networks in use may change

    # What this device says it is.
    def info(self, announce=None):
        body = {
            "alias": self.alias,
            "version": PROTOCOL_VERSION,
            "deviceModel": "Linux",
            "deviceType": "desktop",
            "fingerprint": self.fingerprint,
            "port": self.port,
            "protocol": self.protocol,
            "download": False,
        }
        if announce is not None:
            body["announce"] = announce
        return body

    def sender_fingerprint(self, info, ip):
        """Who sends: the fingerprint it gives, else the one it announced
        from that address; "" when unknown (then it cannot be trusted)."""
        given = str(info.get("fingerprint") or "")
        if given and given != self.fingerprint:
            return given[:128]
        with self.lock:
            for fingerprint, peer in self.peers.items():
                if peer["ip"] == ip and not fingerprint.startswith("ip:"):
                    return fingerprint
        return ""

    # -------------------------------------------------------- networks
    def network_trusted(self, name):
        """ZeroTier (its own encryption and members) or a network the user
        trusted. Called with the lock held."""
        if name.startswith(ZEROTIER_PREFIX):
            return True
        uuid = self.nm.get(name, {}).get("uuid")
        return bool(uuid) and uuid in self.trusted_networks

    def interface_of(self, local_ip):
        """(interface, trusted) a request arrived on, by its local address."""
        with self.lock:
            for name, net in self.networks.items():
                if str(net.ip) == local_ip:
                    return name, self.network_trusted(name)
        return "", False

    def allowed(self, ip):
        try:
            address = ipaddress.IPv4Address(ip)
        except ValueError:
            return False
        with self.lock:
            if ip in self.manual:
                return True
            return any(address in net.network for net in self.networks.values())

    def watch_networks(self):
        last = None
        nm_read = 0
        while True:
            try:
                candidates = networks(self.zerotier)
            except OSError as e:
                emit("warning", message=f"cannot read the network interfaces: {e}")
                candidates = {}
            now = time.monotonic()
            if candidates != self.candidates or now - nm_read > NM_REFRESH_S:
                nm = nm_connections()
                nm_read = now
            else:
                nm = self.nm
            with self.lock:
                self.candidates, self.nm = candidates, nm
                used = {name: net for name, net in candidates.items()
                        if not self.only_trusted or self.network_trusted(name)}
                old, self.networks = self.networks, used
                report = [{
                    "interface": name,
                    "address": str(net.ip),
                    "kind": interface_kind(name, nm.get(name, {}).get("type", "")),
                    "uuid": nm.get(name, {}).get("uuid", ""),
                    "name": nm.get(name, {}).get("name", ""),
                    "trusted": self.network_trusted(name),
                    "used": name in used,
                } for name, net in sorted(candidates.items())]
                folder = str(self.folder)
            if used != old:
                self.join_multicast(old, used)
            state = (report, folder)
            if state != last:
                emit("ready", alias=self.alias, port=self.port, fingerprint=self.fingerprint,
                     protocol=self.protocol, folder=folder, addresses=report)
                if last is None or used != old:
                    self.announce()
                last = state
            self.forget_old_peers()
            self.wake.wait(5)
            self.wake.clear()

    # ------------------------------------------------------- multicast
    def open_multicast(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", self.port))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
        self.multicast = sock

    def join_multicast(self, old, new):
        group = socket.inet_aton(MULTICAST_GROUP)
        for name, net in old.items():
            if new.get(name) != net:
                try:
                    self.multicast.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP,
                                              group + socket.inet_aton(str(net.ip)))
                except OSError:
                    pass
        for name, net in new.items():
            if old.get(name) != net:
                try:
                    self.multicast.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                                              group + socket.inet_aton(str(net.ip)))
                except OSError as e:
                    emit("warning", message=f"no discovery on {name}: {e}")

    def send_multicast(self, body):
        data = json.dumps(body).encode()
        with self.lock:
            addresses = [str(net.ip) for net in self.networks.values()]
        for address in addresses:
            try:
                self.multicast.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(address))
                self.multicast.sendto(data, (MULTICAST_GROUP, self.port))
            except OSError:
                pass  # an interface that just went away

    def announce(self):
        self.send_multicast(self.info(announce=True))

    def listen_multicast(self):
        while True:
            try:
                data, (ip, _port) = self.multicast.recvfrom(65536)
                body = json.loads(data)
            except (OSError, ValueError):
                continue
            if not isinstance(body, dict) or body.get("fingerprint") == self.fingerprint:
                continue
            if not self.allowed(ip):
                continue
            self.saw(body, ip)
            if body.get("announce") is True:
                threading.Thread(target=self.answer_announce, args=(body, ip), daemon=True).start()

    def answer_announce(self, body, ip):
        try:
            self.request(ip, int(body.get("port") or DEFAULT_PORT), body.get("protocol") or "https",
                         "register", self.info(), timeout=5)
        except Exception:
            self.send_multicast(self.info(announce=False))

    # ----------------------------------------------------------- peers
    def saw(self, body, ip):
        fingerprint = str(body.get("fingerprint") or f"ip:{ip}")
        if fingerprint == self.fingerprint:
            return
        peer = {
            "fingerprint": fingerprint,
            "alias": str(body.get("alias") or ip)[:64],
            "deviceModel": str(body.get("deviceModel") or "")[:64],
            "deviceType": str(body.get("deviceType") or "")[:16],
            "ip": ip,
            "port": int(body.get("port") or DEFAULT_PORT),
            "protocol": "http" if body.get("protocol") == "http" else "https",
            "seen": time.time(),
        }
        with self.lock:
            old = self.peers.get(fingerprint)
            self.peers[fingerprint] = peer
            changed = not old or any(old[k] != peer[k] for k in peer if k != "seen")
        if changed:
            self.emit_peers()

    def forget_old_peers(self):
        limit = time.time() - PEER_FORGET_S
        with self.lock:
            gone = [k for k, p in self.peers.items() if p["seen"] < limit]
            for k in gone:
                del self.peers[k]
        if gone:
            self.emit_peers()

    def emit_peers(self):
        with self.lock:
            peers = sorted(({k: v for k, v in p.items()} for p in self.peers.values()),
                           key=lambda p: p["alias"].lower())
        emit("peers", peers=peers)

    # ---------------------------------------------------------- client
    def request(self, ip, port, protocol, route, body, timeout=10, query=""):
        host = f"[{ip}]" if ":" in ip else ip
        if protocol == "http":
            conn = http.client.HTTPConnection(host.strip("[]"), port, timeout=timeout)
        else:
            conn = http.client.HTTPSConnection(host.strip("[]"), port, timeout=timeout, context=client_context())
        try:
            data = json.dumps(body).encode() if body is not None else b""
            conn.request("POST", API + route + query, body=data,
                         headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            payload = response.read(MAX_BODY)
            answer = None
            if payload:
                try:
                    answer = json.loads(payload)
                except ValueError:
                    pass
            return response.status, answer
        finally:
            conn.close()

    def add(self, address):
        """Introduces itself to `address` now (the user just added it)."""
        address = address.strip()
        if not _ipv4(address):
            emit("warning", message=f"not an IPv4 address: {address}")
            return
        with self.lock:
            self.manual.add(address)
        if not self.introduce(address, timeout=5):
            emit("warning", message=f"no LocalSend at {address} yet: it shows up once LocalSend is open there")

    def introduce(self, address, timeout=INTRODUCE_TIMEOUT_S):
        """POST /register to a device added by address: it then lists this
        computer (and answers with what it is). True when it answered."""
        for protocol in ("https", "http"):
            try:
                status, answer = self.request(address, DEFAULT_PORT, protocol, "register", self.info(),
                                              timeout=timeout)
            except Exception:
                continue
            if status == 200 and isinstance(answer, dict):
                self.saw({**answer, "port": answer.get("port") or DEFAULT_PORT,
                          "protocol": answer.get("protocol") or protocol}, address)
                return True
        return False

    def watch_manual(self):
        busy = set()

        def one(address):
            try:
                self.introduce(address)
            finally:
                busy.discard(address)

        while True:
            with self.lock:
                addresses = list(self.manual)
            for address in addresses:
                if address not in busy:
                    busy.add(address)
                    threading.Thread(target=one, args=(address,), daemon=True).start()
            time.sleep(INTRODUCE_EVERY_S)

    # ------------------------------------------------------------ send
    def send(self, fingerprint, paths):
        with self.lock:
            peer = dict(self.peers.get(fingerprint) or {})
            if self.sending:
                emit("send-failed", reason="busy")
                return
            self.sending = {"peer": peer, "cancelled": False, "session": None}
        try:
            if not peer:
                emit("send-failed", reason="gone")
                return
            self._send(peer, paths)
        finally:
            with self.lock:
                self.sending = None

    def _send(self, peer, paths):
        files, sources = {}, {}
        for path in paths:
            p = Path(path)
            if not p.is_file():
                continue
            file_id = secrets.token_hex(8)
            files[file_id] = {
                "id": file_id,
                "fileName": p.name,
                "size": p.stat().st_size,
                "fileType": mimetypes.guess_type(p.name)[0] or "application/octet-stream",
                "sha256": None,
                "preview": None,
            }
            sources[file_id] = p
        if not files:
            emit("send-failed", reason="no-files")
            return
        total = sum(f["size"] for f in files.values())
        emit("send-progress", to=peer["alias"], sent=0, total=total, waiting=True)
        try:
            status, answer = self.request(peer["ip"], peer["port"], peer["protocol"], "prepare-upload",
                                          {"info": self.info(), "files": files},
                                          timeout=SEND_ANSWER_TIMEOUT_S)
        except Exception as e:
            emit("send-failed", reason="unreachable", message=str(e))
            return
        if status == 204:
            emit("send-done", to=peer["alias"], count=0)
            return
        if status != 200 or not isinstance(answer, dict):
            emit("send-failed", reason={401: "pin", 403: "declined", 409: "busy"}.get(status, "refused"),
                 status=status)
            return
        session = answer.get("sessionId")
        tokens = answer.get("files") or {}
        with self.lock:
            self.sending["session"] = session
        sent = 0
        last = 0
        count = 0
        for file_id, token in tokens.items():
            source = sources.get(file_id)
            if not source:
                continue
            query = f"?sessionId={session}&fileId={file_id}&token={token}"
            try:
                sent = self._upload(peer, query, source, sent, total, last)
            except _Cancelled:
                self._cancel_remote(peer, session)
                emit("send-failed", reason="cancelled")
                return
            except Exception as e:
                emit("send-failed", reason="interrupted", message=str(e))
                return
            count += 1
        emit("send-done", to=peer["alias"], count=count)

    def _upload(self, peer, query, source, sent, total, last):
        ip, port = peer["ip"], peer["port"]
        if peer["protocol"] == "http":
            conn = http.client.HTTPConnection(ip, port, timeout=60)
        else:
            conn = http.client.HTTPSConnection(ip, port, timeout=60, context=client_context())
        try:
            size = source.stat().st_size
            conn.putrequest("POST", API + "upload" + query)
            conn.putheader("Content-Type", "application/octet-stream")
            conn.putheader("Content-Length", str(size))
            conn.endheaders()
            with open(source, "rb") as f:
                while True:
                    with self.lock:
                        if self.sending and self.sending["cancelled"]:
                            raise _Cancelled()
                    block = f.read(CHUNK)
                    if not block:
                        break
                    conn.send(block)
                    sent += len(block)
                    now = time.monotonic()
                    if now - last >= PROGRESS_EVERY_S:
                        last = now
                        emit("send-progress", to=peer["alias"], sent=sent, total=total, waiting=False)
            response = conn.getresponse()
            response.read()
            if response.status != 200:
                raise OSError(f"the receiver answered {response.status}")
            return sent
        finally:
            conn.close()

    def _cancel_remote(self, peer, session):
        try:
            self.request(peer["ip"], peer["port"], peer["protocol"], "cancel", None,
                         timeout=5, query=f"?sessionId={session}")
        except Exception:
            pass

    def cancel_send(self):
        with self.lock:
            if self.sending:
                self.sending["cancelled"] = True

    # --------------------------------------------------------- receive
    def decide(self, offer_id, accepted):
        with self.lock:
            offer = self.offers.get(offer_id)
            if offer and offer["decision"] is None:
                offer["decision"] = accepted
                offer["event"].set()

    def end_session(self, reason):
        """Drops the current session: its part files go."""
        with self.lock:
            session, self.session = self.session, None
        if not session:
            return
        for f in session["files"].values():
            part = f.get("part")
            if part and not f.get("done"):
                try:
                    os.unlink(part)
                except OSError:
                    pass
        saved = [f["saved"] for f in session["files"].values() if f.get("saved")]
        if reason == "done":
            emit("received", id=session["id"], sender=session["sender"], paths=saved)
        else:
            emit("cancelled", id=session["id"], sender=session["sender"], reason=reason, paths=saved)

    def watch_sessions(self):
        while True:
            time.sleep(5)
            now = time.monotonic()
            with self.lock:
                stale = self.session and now - self.session["active"] > SESSION_IDLE_S
                expired = [ip for ip, entry in self.pins.items() if entry["expires"] < now]
                for ip in expired:
                    del self.pins[ip]
            if stale:
                self.end_session("timeout")
            for ip in expired:
                emit("pin-gone", ip=ip, reason="expired")

    # ------------------------------------------------------------- PIN
    def check_pin(self, ip, sender, given):
        """'ok', or 'need' (none given yet) or 'wrong': then the sender is
        answered 401 and LocalSend asks its user for the PIN, which Froonty
        shows (the "pin" event). One PIN a sender address, PIN_TTL_S long;
        PIN_TRIES wrong ones and it is replaced."""
        now = time.monotonic()
        with self.lock:
            entry = self.pins.get(ip)
            fresh = not entry or entry["expires"] < now
            if fresh:
                entry = {"pin": f"{secrets.randbelow(10 ** 6):06d}", "expires": now + PIN_TTL_S, "fails": 0}
                self.pins[ip] = entry
            if given and not fresh and secrets.compare_digest(str(given), entry["pin"]):
                del self.pins[ip]
                result = "ok"
            elif given and not fresh:
                entry["fails"] += 1
                if entry["fails"] >= PIN_TRIES:
                    del self.pins[ip]
                result = "wrong"
            else:
                result = "need"
            pin = entry["pin"]
        if result == "ok":
            emit("pin-gone", ip=ip, reason="used")
        elif fresh or result == "need":
            emit("pin", ip=ip, sender=sender, pin=pin)
        return result

    # ---------------------------------------------------------- server
    def serve(self):
        peer = self
        context = None
        if self.cert:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(self.cert[0]), str(self.cert[1]))

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True
            request_queue_size = 32

            def get_request(self):
                sock, address = self.socket.accept()
                sock.settimeout(60)
                if context:
                    sock = context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
                return sock, address

            def verify_request(self, request, client_address):
                return peer.allowed(client_address[0])

            def handle_error(self, request, client_address):
                pass  # a peer that hung up mid-answer: nothing to do

        class Handler(_Handler):
            owner = peer

        self.server = Server(("0.0.0.0", self.port), Handler)
        self.server.serve_forever()


class _Cancelled(Exception):
    pass


class _Handler(BaseHTTPRequestHandler):
    owner = None
    protocol_version = "HTTP/1.1"
    server_version = "Froonty-LocalSend"
    sys_version = ""

    def setup(self):
        if isinstance(self.request, ssl.SSLSocket):
            self.request.do_handshake()
        super().setup()

    def log_message(self, *args):
        pass

    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def route(self):
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        for prefix in ("/api/localsend/v2/", "/api/localsend/v1/"):
            if url.path.startswith(prefix):
                return url.path[len(prefix):], query
        return None, query

    def do_GET(self):
        route, _query = self.route()
        if route == "info":
            self.reply(200, self.owner.info())
        else:
            self.reply(404)

    def do_POST(self):
        route, query = self.route()
        try:
            if route == "register":
                self.register()
            elif route == "prepare-upload":
                self.prepare_upload(query)
            elif route == "upload":
                self.upload(query)
            elif route == "cancel":
                self.cancel(query)
            else:
                self.reply(404)
        except (ConnectionError, ssl.SSLError, TimeoutError, socket.timeout):
            self.close_connection = True

    def register(self):
        body = self.json_body()
        if body is None:
            self.reply(400)
            return
        self.owner.saw(body, self.client_address[0])
        self.reply(200, self.owner.info())

    def prepare_upload(self, query):
        owner = self.owner
        body = self.json_body()
        files = body.get("files") if body else None
        info = body.get("info") if body else None
        if not isinstance(files, dict) or not isinstance(info, dict) or len(files) > MAX_FILES:
            self.reply(400)
            return
        clean = {}
        for key, f in files.items():
            if not isinstance(f, dict):
                self.reply(400)
                return
            try:
                size = int(f.get("size") or 0)
            except (TypeError, ValueError):
                self.reply(400)
                return
            if size < 0:
                self.reply(400)
                return
            clean[str(key)] = {
                "id": str(key),
                "name": safe_name(f.get("fileName")),
                "size": size,
                "type": str(f.get("fileType") or "")[:100],
                "sha256": str(f["sha256"]).lower() if f.get("sha256") else None,
                "preview": f.get("preview") if isinstance(f.get("preview"), str) else None,
            }
        ip = self.client_address[0]
        owner.saw(info, ip)
        sender = str(info.get("alias") or ip)[:64]
        fingerprint = owner.sender_fingerprint(info, ip)
        interface, network_trusted = owner.interface_of(self.connection.getsockname()[0])
        # A device not trusted yet proves the user is at both ends first.
        with owner.lock:
            needs_pin = owner.pin_first and (not fingerprint or fingerprint not in owner.trusted)
        pin_verified = False
        if needs_pin:
            if owner.check_pin(ip, sender, query.get("pin")) != "ok":
                self.reply(401)
                return
            pin_verified = True
        # A text message (the share sheet's text or link): shown, never saved.
        texts = [f for f in clean.values() if f["type"].startswith("text/plain") and f["preview"] is not None]
        message = len(texts) == len(clean) == 1
        with owner.lock:
            if owner.session or (owner.offers and not message):
                busy = True
            else:
                busy = False
                offer_id = secrets.token_hex(8)
                offer = {"event": threading.Event(), "decision": None, "ip": ip, "withdrawn": False}
                owner.offers[offer_id] = offer
        if busy:
            self.reply(409)
            return
        emit("offer", id=offer_id, sender=sender, ip=ip, deviceModel=str(info.get("deviceModel") or "")[:64],
             fingerprint=fingerprint, pinVerified=pin_verified, interface=interface,
             trustedNetwork=network_trusted,
             message=texts[0]["preview"][:100000] if message else None,
             files=[{"name": f["name"], "size": f["size"], "type": f["type"]} for f in clean.values()])
        # The sender may give up while the user decides: it hangs up, or
        # calls /cancel (cancel() below). Either withdraws the offer.
        deadline = time.monotonic() + OFFER_TIMEOUT_S
        while not offer["event"].wait(0.5):
            if self.sender_gone():
                offer["withdrawn"] = True
                break
            if time.monotonic() > deadline:
                break
        with owner.lock:
            owner.offers.pop(offer_id, None)
        if offer["withdrawn"] or (offer["decision"] and self.sender_gone()):
            emit("offer-gone", id=offer_id, sender=sender, reason="sender")
            self.close_connection = True
            return
        if offer["decision"] is None:
            emit("offer-gone", id=offer_id, sender=sender, reason="timeout")
            self.reply(403)
            return
        if not offer["decision"]:
            self.reply(403)
            return
        if message:
            emit("message", id=offer_id, sender=sender, text=texts[0]["preview"][:100000])
            self.reply(204)
            return
        try:
            owner.folder.mkdir(parents=True, exist_ok=True, mode=0o755)
        except OSError as e:
            emit("warning", message=f"cannot make {owner.folder}: {e}")
            self.reply(500)
            return
        with owner.lock:
            if owner.session:
                self.reply(409)
                return
            for f in clean.values():
                f["token"] = secrets.token_hex(16)
            owner.session = {
                "id": secrets.token_hex(12),
                "folder": owner.folder,
                "offer": offer_id,
                "ip": ip,
                "sender": sender,
                "files": clean,
                "total": sum(f["size"] for f in clean.values()),
                "received": 0,
                "active": time.monotonic(),
                "reported": 0,
            }
            session = owner.session
        emit("progress", id=offer_id, sender=sender, received=0, total=session["total"])
        try:
            self.reply(200, {"sessionId": session["id"], "files": {k: f["token"] for k, f in clean.items()}})
        except (OSError, ssl.SSLError):
            # It hung up just now: no upload will come.
            owner.end_session("sender")
            raise

    def sender_gone(self):
        """Whether the sender hung up while waiting for the answer. It sends
        nothing more meanwhile, so anything to read is its end: the
        connection closed (nothing to read) or a TLS alert (record type
        21, close_notify)."""
        sock = self.request
        try:
            if isinstance(sock, ssl.SSLSocket) and sock.pending():
                return False
            readable, _, _ = select.select([sock], [], [], 0)
            if not readable:
                return False
            # The raw socket, below TLS: SSLSocket refuses MSG_PEEK.
            head = socket.socket.recv(sock, 1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
            return head in (b"", b"\x15")
        except BlockingIOError:
            return False
        except (OSError, ValueError):
            return True

    def upload(self, query):
        owner = self.owner
        with owner.lock:
            session = owner.session
            f = session["files"].get(query.get("fileId", "")) if session else None
            ok = (session and session["id"] == query.get("sessionId") and f
                  and secrets.compare_digest(f["token"], query.get("token", ""))
                  and session["ip"] == self.client_address[0] and not f.get("part"))
            if ok:
                part = session["folder"] / f".{secrets.token_hex(6)}.froonty-part"
                f["part"] = part
        if not session or not query.get("sessionId") or not query.get("fileId"):
            self.reply(400)
            return
        if not ok:
            self.reply(403)
            return
        digest = hashlib.sha256()
        written = 0
        try:
            fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(fd, "wb") as out:
                for block in self.body_blocks():
                    written += len(block)
                    if written > f["size"]:
                        raise ValueError("more data than announced")
                    out.write(block)
                    digest.update(block)
                    self.progress(session, len(block))
        except (ValueError, OSError) as e:
            self.drop_part(part)
            if isinstance(e, OSError) and not isinstance(e, (ConnectionError, TimeoutError)):
                emit("warning", message=f"cannot write {f['name']}: {e}")
            self.reply(400 if isinstance(e, ValueError) else 500)
            owner.end_session("failed")
            return
        if written != f["size"]:
            self.drop_part(part)
            self.reply(400)
            owner.end_session("failed")
            return
        if f["sha256"] and digest.hexdigest() != f["sha256"]:
            self.drop_part(part)
            self.reply(422)
            owner.end_session("failed")
            return
        try:
            f["saved"] = str(place(part, session["folder"], f["name"]))
        except OSError as e:
            self.drop_part(part)
            emit("warning", message=f"cannot save {f['name']}: {e}")
            self.reply(500)
            owner.end_session("failed")
            return
        f["done"] = True
        self.reply(200)
        with owner.lock:
            finished = owner.session is session and all(x.get("done") for x in session["files"].values())
        if finished:
            owner.end_session("done")

    def body_blocks(self):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            while True:
                line = self.rfile.readline(1024)
                if not line:
                    raise ConnectionError("cut off")
                size = int(line.split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                        pass
                    return
                left = size
                while left:
                    block = self.rfile.read(min(CHUNK, left))
                    if not block:
                        raise ConnectionError("cut off")
                    left -= len(block)
                    yield block
                self.rfile.readline(16)
        else:
            left = int(self.headers.get("Content-Length") or 0)
            while left > 0:
                block = self.rfile.read(min(CHUNK, left))
                if not block:
                    raise ConnectionError("cut off")
                left -= len(block)
                yield block

    def progress(self, session, count):
        with self.owner.lock:
            session["received"] += count
            session["active"] = time.monotonic()
            now = time.monotonic()
            if now - session["reported"] < PROGRESS_EVERY_S:
                return
            session["reported"] = now
            received, total = session["received"], session["total"]
        emit("progress", id=session["offer"], sender=session["sender"], received=received, total=total)

    @staticmethod
    def drop_part(part):
        try:
            os.unlink(part)
        except OSError:
            pass

    def cancel(self, query):
        owner = self.owner
        ip = self.client_address[0]
        session_id = query.get("sessionId")
        with owner.lock:
            session = owner.session
            mine = session and session["ip"] == ip and session_id in (None, session["id"])
            # Before the user answered there is no session yet: the
            # sender's waiting offers go.
            for offer in owner.offers.values():
                if offer["ip"] == ip and offer["decision"] is None:
                    offer["withdrawn"] = True
                    offer["event"].set()
        if mine:
            owner.end_session("sender")
        self.reply(200)


# ---------------------------------------------------------------- main

def commands(peer):
    for line in sys.stdin:
        try:
            command = json.loads(line)
        except ValueError:
            continue
        name = command.get("cmd")
        if name in ("accept", "decline"):
            peer.decide(str(command.get("id")), name == "accept")
        elif name == "scan":
            peer.announce()
        elif name == "update":
            peer.update(command)
        elif name == "add":
            threading.Thread(target=peer.add, args=(str(command.get("address", "")),), daemon=True).start()
        elif name == "send":
            threading.Thread(target=peer.send, args=(str(command.get("to")), list(command.get("paths") or [])),
                             daemon=True).start()
        elif name == "cancel-send":
            peer.cancel_send()


def serve():
    line = sys.stdin.readline()
    try:
        config = json.loads(line)
        Path(config["folder"])
    except (ValueError, KeyError, TypeError):
        emit("fatal", reason="config")
        return 2
    try:
        peer = Peer(config)
    except (OSError, subprocess.SubprocessError, ssl.SSLError) as e:
        emit("fatal", reason="certificate", message=str(e))
        return 1
    try:
        peer.open_multicast()
        server_ready = threading.Event()
        errors = []

        def run_server():
            try:
                peer.serve()
            except OSError as e:
                errors.append(e)
                server_ready.set()

        threading.Thread(target=run_server, daemon=True).start()
        server_ready.wait(0.5)
        if errors:
            raise errors[0]
    except OSError as e:
        emit("fatal", reason="port-in-use" if e.errno == errno.EADDRINUSE else "network",
             port=peer.port, message=str(e))
        return 1
    for target in (peer.listen_multicast, peer.watch_networks, peer.watch_sessions, peer.watch_manual):
        threading.Thread(target=target, daemon=True).start()
    commands(peer)  # until Froonty closes stdin
    peer.end_session("stopped")
    return 0


def main(argv):
    if argv[1:] == ["serve"]:
        return serve()
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
