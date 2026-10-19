# SPDX-License-Identifier: GPL-3.0-or-later
"""The LocalSend tab's helper (froonty@catalin/features/localsend/helper.py):
file names, which interfaces it uses, and two helpers talking the
protocol to each other on 127.0.0.1 (loopback is allowed here only, by
the test). Run by tools/unit/run.sh (python3 -m unittest)."""

import contextlib
import importlib.util
import io
import ipaddress
import json
import os
import socket
import ssl
import tempfile
import threading
import time
import http.client
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent.parent / "froonty@catalin" / "features" / "localsend" / "helper.py"


def load():
    spec = importlib.util.spec_from_file_location("localsend_helper", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Events:
    """Collects what emit() prints."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = []

    def __call__(self, event, **fields):
        with self.lock:
            self.items.append({"event": event, **fields})

    def wait(self, event, timeout=10, after=0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                found = [e for e in self.items[after:] if e["event"] == event]
            if found:
                return found[0]
            time.sleep(0.02)
        raise AssertionError(f"no {event} in {self.items}")


class Names(unittest.TestCase):
    def test_safe_name_keeps_files_in_the_folder(self):
        self.assertEqual(helper.safe_name("../../etc/passwd"), "passwd")
        self.assertEqual(helper.safe_name("a\\b\\c.txt"), "c.txt")
        self.assertEqual(helper.safe_name(".."), "file")
        self.assertEqual(helper.safe_name(""), "file")
        self.assertEqual(helper.safe_name("bad\x00\nname.png"), "badname.png")
        long = helper.safe_name("x" * 400 + ".jpeg")
        self.assertTrue(long.endswith(".jpeg") and len(long.encode()) <= 200)

    def test_numbered(self):
        self.assertEqual(helper.numbered("photo.heic", 2), "photo (2).heic")
        self.assertEqual(helper.numbered("README", 3), "README (3)")
        self.assertEqual(helper.numbered(".bashrc", 2), ".bashrc (2)")

    def test_place_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            (folder / "a.txt").write_text("old")
            part = folder / ".x.froonty-part"
            part.write_text("new")
            target = helper.place(part, folder, "a.txt")
            self.assertEqual(target.name, "a (2).txt")
            self.assertEqual((folder / "a.txt").read_text(), "old")
            self.assertFalse(part.exists())

    def test_interfaces(self):
        allowed = helper.interface_allowed
        self.assertTrue(allowed("wlo1", False))
        self.assertTrue(allowed("enp109s0", False))
        self.assertFalse(allowed("ztkti7oq6k", False))
        self.assertTrue(allowed("ztkti7oq6k", True))
        for name in ("lo", "docker0", "br-1aec9f5b7372", "veth12", "virbr0", "tun0", "wg0", "tailscale0"):
            self.assertFalse(allowed(name, True), name)


class Protocol(unittest.TestCase):
    """Two helpers on 127.0.0.1: B announces itself to A, A sends to B."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        self.events = Events()
        self._emit = helper.emit
        helper.emit = self.events
        self.peers = []

    def tearDown(self):
        for peer in self.peers:
            peer.server.shutdown()
            peer.server.server_close()
        helper.emit = self._emit
        self.tmp.cleanup()

    def start(self, name):
        port = free_port()
        # A certificate each: one shared would make them the same device.
        os.environ["XDG_DATA_HOME"] = os.path.join(self.tmp.name, f"{name}-data")
        peer = helper.Peer({"alias": name, "folder": os.path.join(self.tmp.name, name), "port": port})
        peer.networks = {"lo": ipaddress.IPv4Interface("127.0.0.1/8")}
        threading.Thread(target=peer.serve, daemon=True).start()
        for _ in range(100):
            if peer.server:
                break
            time.sleep(0.02)
        self.peers.append(peer)
        return peer

    def post(self, peer, route, body, query=""):
        context = ssl._create_unverified_context()
        conn = http.client.HTTPSConnection("127.0.0.1", peer.port, timeout=10, context=context)
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
        conn.request("POST", helper.API + route + query, body=data)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response.status, json.loads(payload) if payload else None

    def test_register_and_send_files(self):
        a, b = self.start("A"), self.start("B")
        self.assertEqual(a.protocol, "https")
        status, answer = self.post(a, "register", {**b.info(), "port": b.port})
        self.assertEqual((status, answer["alias"]), (200, "A"))
        self.assertIn(b.fingerprint, a.peers)

        src = Path(self.tmp.name) / "photo.jpg"
        src.write_bytes(os.urandom(700_000))
        threading.Thread(target=a.send, args=(b.fingerprint, [str(src)]), daemon=True).start()
        offer = self.events.wait("offer")
        self.assertEqual(offer["files"][0]["name"], "photo.jpg")
        b.decide(offer["id"], True)
        received = self.events.wait("received")
        self.events.wait("send-done")
        self.assertEqual(Path(received["paths"][0]).read_bytes(), src.read_bytes())

    def test_declined_and_bad_tokens(self):
        a, b = self.start("A"), self.start("B")
        self.post(a, "register", {**b.info(), "port": b.port})
        src = Path(self.tmp.name) / "a.txt"
        src.write_text("hi")
        threading.Thread(target=a.send, args=(b.fingerprint, [str(src)]), daemon=True).start()
        b.decide(self.events.wait("offer")["id"], False)
        self.assertEqual(self.events.wait("send-failed")["reason"], "declined")
        self.assertEqual(os.listdir(b.folder) if b.folder.exists() else [], [])

        # Accepted, but uploads must carry the session's token.
        done = []
        body = {"info": {"alias": "phone"}, "files": {"1": {"id": "1", "fileName": "x.bin", "size": 3}}}
        threading.Thread(target=lambda: done.append(self.post(b, "prepare-upload", body)), daemon=True).start()
        mark = len(self.events.items)
        b.decide(self.events.wait("offer", after=mark)["id"], True)
        while not done:
            time.sleep(0.02)
        status, answer = done[0]
        self.assertEqual(status, 200)
        session = answer["sessionId"]
        self.assertEqual(self.post(b, "upload", b"abc", f"?sessionId={session}&fileId=1&token=wrong")[0], 403)
        self.assertEqual(self.post(b, "upload", b"abcd",
                                   f"?sessionId={session}&fileId=1&token={answer['files']['1']}")[0], 400)
        self.assertEqual(self.events.wait("cancelled")["reason"], "failed")
        self.assertEqual([n for n in os.listdir(b.folder) if not n.startswith(".")], [])

    def test_a_text_message_is_shown_not_saved(self):
        b = self.start("B")
        done = []
        body = {"info": {"alias": "phone"}, "files": {"1": {"id": "1", "fileName": "t.txt", "size": 5,
                                                            "fileType": "text/plain", "preview": "hello"}}}
        threading.Thread(target=lambda: done.append(self.post(b, "prepare-upload", body)), daemon=True).start()
        offer = self.events.wait("offer")
        self.assertEqual(offer["message"], "hello")
        b.decide(offer["id"], True)
        self.assertEqual(self.events.wait("message")["text"], "hello")
        while not done:
            time.sleep(0.02)
        self.assertEqual(done[0][0], 204)

    def test_sender_hangs_up_while_the_offer_waits(self):
        b = self.start("B")
        conn = http.client.HTTPSConnection("127.0.0.1", b.port, timeout=10,
                                           context=ssl._create_unverified_context())
        body = {"info": {"alias": "phone", "fingerprint": "PHONE"},
                "files": {"1": {"id": "1", "fileName": "x.jpg", "size": 3}}}
        conn.request("POST", helper.API + "prepare-upload", body=json.dumps(body).encode())
        offer = self.events.wait("offer")
        self.assertEqual(offer["fingerprint"], "PHONE")
        conn.close()  # iOS: the send was cancelled before it was accepted
        gone = self.events.wait("offer-gone")
        self.assertEqual((gone["id"], gone["reason"]), (offer["id"], "sender"))
        b.decide(offer["id"], True)  # too late: nothing starts
        time.sleep(0.3)
        self.assertIsNone(b.session)
        self.assertEqual([e for e in self.events.items if e["event"] == "progress"], [])

    def test_cancel_before_the_answer_withdraws_the_offer(self):
        b = self.start("B")
        body = {"info": {"alias": "phone"}, "files": {"1": {"id": "1", "fileName": "x.jpg", "size": 3}}}

        def prepare():
            with contextlib.suppress(Exception):
                self.post(b, "prepare-upload", body)

        threading.Thread(target=prepare, daemon=True).start()
        offer = self.events.wait("offer")
        self.assertEqual(self.post(b, "cancel", None)[0], 200)
        self.assertEqual(self.events.wait("offer-gone")["reason"], "sender")
        self.assertEqual(b.offers, {})

    def test_a_new_device_needs_the_pin_first(self):
        b = self.start("B")
        b.update({"pinFirst": True, "trusted": ["KNOWN"]})
        body = {"info": {"alias": "phone", "fingerprint": "NEW"},
                "files": {"1": {"id": "1", "fileName": "x.jpg", "size": 3}}}
        self.assertEqual(self.post(b, "prepare-upload", body)[0], 401)
        pin = self.events.wait("pin")
        self.assertEqual((pin["sender"], len(pin["pin"])), ("phone", 6))
        wrong = "000000" if pin["pin"] != "000000" else "111111"
        self.assertEqual(self.post(b, "prepare-upload", body, f"?pin={wrong}")[0], 401)
        self.assertEqual(len([e for e in self.events.items if e["event"] == "pin"]), 1, "the same PIN stays")
        done = []
        threading.Thread(target=lambda: done.append(self.post(b, "prepare-upload", body, f"?pin={pin['pin']}")),
                         daemon=True).start()
        offer = self.events.wait("offer")
        self.assertTrue(offer["pinVerified"])
        self.assertEqual(self.events.wait("pin-gone")["reason"], "used")
        b.decide(offer["id"], True)
        while not done:
            time.sleep(0.02)
        self.assertEqual(done[0][0], 200)

        # A trusted device: no PIN.
        b.end_session("test")
        mark = len(self.events.items)
        body["info"]["fingerprint"] = "KNOWN"
        threading.Thread(target=lambda: self.post(b, "prepare-upload", body), daemon=True).start()
        self.assertFalse(self.events.wait("offer", after=mark)["pinVerified"])

    def test_wrong_pins_replace_it(self):
        b = self.start("B")
        first = b.check_pin("10.0.0.9", "phone", None)
        self.assertEqual(first, "need")
        pin = self.events.wait("pin")["pin"]
        for _ in range(helper.PIN_TRIES):
            self.assertEqual(b.check_pin("10.0.0.9", "phone", "x"), "wrong")
        self.assertNotIn("10.0.0.9", b.pins)
        self.assertEqual(b.check_pin("10.0.0.9", "phone", pin), "need", "the old PIN no longer works")

    def test_network_trust(self):
        b = self.start("B")
        b.nm = {"wlo1": {"uuid": "HOME", "type": "802-11-wireless", "name": "Home"},
                "wlo2": {"uuid": "CAFE", "type": "802-11-wireless", "name": "Cafe"}}
        b.update({"trustedNetworks": ["HOME"]})
        self.assertTrue(b.network_trusted("wlo1"))
        self.assertFalse(b.network_trusted("wlo2"))
        self.assertFalse(b.network_trusted("enp0s1"), "no NetworkManager connection: not trusted")
        self.assertTrue(b.network_trusted("ztabc"))
        self.assertEqual(helper.interface_kind("wlo2", "802-11-wireless"), "wifi")
        self.assertEqual(helper.interface_kind("ztabc"), "zerotier")

    def test_devices_added_by_address_are_introduced_to(self):
        a, b = self.start("A"), self.start("B")
        # B listens on the default port in real life; here A asks B's port.
        original = helper.DEFAULT_PORT
        helper.DEFAULT_PORT = b.port
        try:
            a.update({"manual": ["127.0.0.1", "not-an-ip"]})
            self.assertEqual(a.manual, {"127.0.0.1"})
            self.assertTrue(a.introduce("127.0.0.1"))
        finally:
            helper.DEFAULT_PORT = original
        self.assertIn(a.fingerprint, b.peers, "B now lists A")
        self.assertIn(b.fingerprint, a.peers, "and A lists B")

    def test_a_new_folder_applies_to_the_next_transfer(self):
        a, b = self.start("A"), self.start("B")
        self.post(a, "register", {**b.info(), "port": b.port})
        src = Path(self.tmp.name) / "doc.pdf"
        src.write_bytes(b"pdf")
        new = Path(self.tmp.name) / "elsewhere"
        b.update({"folder": str(new)})
        threading.Thread(target=a.send, args=(b.fingerprint, [str(src)]), daemon=True).start()
        b.decide(self.events.wait("offer")["id"], True)
        self.assertEqual(Path(self.events.wait("received")["paths"][0]).parent, new)

    def test_outside_the_networks_is_refused(self):
        b = self.start("B")
        b.networks = {"wlo1": ipaddress.IPv4Interface("192.168.50.2/24")}
        with self.assertRaises((ConnectionError, OSError, http.client.HTTPException)):
            self.post(b, "register", {"alias": "x"})


if __name__ == "__main__":
    unittest.main()
