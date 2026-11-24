#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Log everything that happens around the llano pad, without asking the pad anything.

  llano-watch.py                 watch until stopped, appending to the log
  llano-watch.py mark [NOTE]     add "heard it" (or NOTE) to the log, for a blip heard by ear

Sources, all pushed by the system, none polled:
  pad      input reports the pad sends by itself on its interrupt endpoint (hidraw read)
  control  writes to the pad by any program (llano.py's control.log)
  udev     USB and hidraw devices added, removed or changed
  journal  kernel USB/HID/power lines, llano units, sleep and wake

The log is $XDG_STATE_HOME/llano/watch.log (~/.local/state/llano/watch.log).
"""
import datetime
import json
import os
import re
import signal
import subprocess
import sys
import threading
from pathlib import Path

HID_ID = 'HID_ID=0003:0000374A:0000B101'
STATE = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'llano'
LOG = STATE / 'watch.log'
CONTROL_LOG = STATE / 'control.log'

KERNEL_RE = re.compile(r'usb|xhci|hid|hub|over-?current|PM: |suspend|resume', re.I)
JOURNAL_RE = re.compile(r'llano|sleep|suspend|resum|hibernat', re.I)

_lock = threading.Lock()
_pad_back = threading.Event()


def stamp(seconds: float | None = None) -> str:
    when = datetime.datetime.fromtimestamp(seconds) if seconds else datetime.datetime.now()
    return when.isoformat(sep=' ', timespec='milliseconds')


def log(source: str, text: str, seconds: float | None = None) -> None:
    line = f'{stamp(seconds)}  {source:<7} {text}\n'
    with _lock:
        with LOG.open('a') as f:
            f.write(line)
        # Under systemd, stdout is the journal, which this script follows.
        if sys.stdout.isatty():
            sys.stdout.write(line)
            sys.stdout.flush()


def find_hidraw() -> Path | None:
    for node in sorted(Path('/sys/class/hidraw').iterdir()):
        try:
            if HID_ID in (node / 'device/uevent').read_text():
                return Path('/dev') / node.name
        except OSError:
            pass
    return None


def describe(report: bytes) -> str:
    raw = report.hex(' ')
    if len(report) >= 8 and report[0] in (0x80, 0x88):
        control = 'pad' if report[0] == 0x88 else 'software'
        on = 'off' if report[2] else 'on'
        lights = 'off' if report[3] & 0x80 else 'on'
        return f'speed {report[1]}% ({control}) pad {on} lights {lights}  raw {raw}'
    return f'raw {raw}'


def watch_pad() -> None:
    # Blocks in read(); the pad's reply to a status or version request also lands here.
    while True:
        path = find_hidraw()
        if path is None:
            log('pad', 'not on USB; waiting for udev to add it')
            _pad_back.clear()
            _pad_back.wait()
            continue
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError as e:
            log('pad', f'cannot open {path}: {e}; waiting for udev')
            _pad_back.clear()
            _pad_back.wait()
            continue
        log('pad', f'listening on {path}')
        try:
            while True:
                report = os.read(fd, 64)
                if not report:
                    break
                log('pad', describe(report))
        except OSError as e:
            log('pad', f'read stopped: {e}')
        finally:
            os.close(fd)
        _pad_back.clear()
        _pad_back.wait()


def follow(source: str, argv: list[str], handle) -> None:
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        handle(line.rstrip('\n'))
    log(source, f'{argv[0]} ended with {proc.wait()}')


def on_control(line: str) -> None:
    try:
        entry = json.loads(line)
    except ValueError:
        log('control', line)
        return
    log('control', f"{entry.get('action')} {entry.get('speed')}% by {entry.get('by')} (pid {entry.get('pid')})",
        entry.get('time'))


def on_udev(line: str) -> None:
    # "KERNEL[1234.5678] remove   /devices/.../1-2.1 (usb)"
    if not line.startswith('KERNEL['):
        return
    log('udev', line.split('] ', 1)[-1].strip())
    if ' add ' in line and '(hidraw)' in line:
        _pad_back.set()


def on_journal(line: str) -> None:
    try:
        entry = json.loads(line)
    except ValueError:
        return
    message = entry.get('MESSAGE')
    if isinstance(message, list):
        message = bytes(message).decode(errors='replace')
    if not message:
        return
    unit = entry.get('_SYSTEMD_USER_UNIT') or entry.get('_SYSTEMD_UNIT') or ''
    if unit.startswith('llano-watch'):
        return
    who = 'kernel' if entry.get('_TRANSPORT') == 'kernel' else unit or entry.get('SYSLOG_IDENTIFIER', '?')
    if who == 'kernel':
        wanted = KERNEL_RE.search(message)
    else:
        wanted = JOURNAL_RE.search(unit) or JOURNAL_RE.search(message)
    if wanted:
        seconds = int(entry['__REALTIME_TIMESTAMP']) / 1e6
        log('journal', f'[{who}] {message}', seconds)


def main() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    if sys.argv[1:2] == ['mark']:
        log('mark', ' '.join(sys.argv[2:]) or 'heard it')
        return
    log('watch', f'started (pid {os.getpid()})')
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(log('watch', 'stopped')))
    CONTROL_LOG.touch(exist_ok=True)
    threads = [
        threading.Thread(target=watch_pad, daemon=True),
        threading.Thread(target=follow, daemon=True, args=(
            'control', ['/usr/bin/tail', '-n0', '-F', str(CONTROL_LOG)], on_control)),
        threading.Thread(target=follow, daemon=True, args=(
            'udev', ['/usr/bin/udevadm', 'monitor', '--kernel',
                     '--subsystem-match=usb', '--subsystem-match=hidraw'], on_udev)),
        threading.Thread(target=follow, daemon=True, args=(
            'journal', ['/usr/bin/journalctl', '-f', '-n0', '-o', 'json'], on_journal)),
    ]
    for t in threads:
        t.start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        log('watch', 'stopped')


if __name__ == '__main__':
    main()
