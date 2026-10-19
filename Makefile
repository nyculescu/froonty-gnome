# SPDX-License-Identifier: GPL-3.0-or-later
UUID := froonty@catalin
SRC := $(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
# Froonty in Show Apps: opens its settings; Start/Stop Froonty on right
# click (tools/froonty.desktop).
DESKTOP_FILE := $(HOME)/.local/share/applications/froonty.desktop

# Absolute paths: on some machines other toolchains (e.g. SUMO) shadow the
# system GLib tools on PATH. Override if needed.
GLIB_COMPILE_SCHEMAS ?= /usr/bin/glib-compile-schemas

MATHJAX := $(SRC)/third_party/mathjax/fetched.json

.PHONY: schemas mathjax break-art third-party install uninstall unit test log clean devkit

schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	$(GLIB_COMPILE_SCHEMAS) --strict $(SRC)/schemas

# The Formulas tab's renderer: MathJax from the npm registry, pinned and
# hash-checked, into $(SRC)/third_party/mathjax (not in the repository).
# install and devkit fetch it when it is missing; run it again after
# tools/fetch-mathjax.py changes its pins. Network is needed only then,
# never at runtime.
mathjax:
	python3 tools/fetch-mathjax.py $(SRC)

$(MATHJAX):
	python3 tools/fetch-mathjax.py $(SRC)

# The Break tab's exercise pictures: WorkoutLabs' (all rights reserved by
# WorkoutLabs), fetched to this computer into $(SRC)/third_party/break-art
# (not in the repository) and cut into square frames. install
# and devkit fetch them when missing; a failed fetch is not an error (the
# tab then shows Workrave's pictures). Network only then, never at runtime.
BREAK_ART := $(SRC)/third_party/break-art/index.json

break-art:
	python3 tools/fetch-break-art.py $(SRC)

$(BREAK_ART):
	-python3 tools/fetch-break-art.py $(SRC)

# Submodules carrying local patches (third_party/patches/<name>/): applied
# on a `froonty` branch over the commit the superproject records. The Fan
# settings page's llano.py is third_party/llano-v12-linux/llano.py once
# patched.
third-party:
	bash tools/patch-third-party.sh

# Copies the extension into the user's extensions directory. A copy, not a
# symlink: GNOME Shell loads extensions once, at login, and a link into a
# drive that is mounted later (e.g. a data partition udisks mounts on first
# use) is broken at that moment, so the extension silently does not start.
# GNOME Shell only loads new code at startup: log out and in.
# First install: gnome-extensions enable $(UUID)
install: schemas $(MATHJAX) $(BREAK_ART) uninstall
	mkdir -p $(dir $(INSTALL_DIR))
	cp -r $(SRC) $(INSTALL_DIR)
	mkdir -p $(dir $(DESKTOP_FILE))
	cp tools/froonty.desktop $(DESKTOP_FILE)

# rm never follows a symlink named without a trailing slash, so this also
# removes the link of an older install without touching the working tree.
uninstall:
	rm -rf $(INSTALL_DIR)
	rm -f $(DESKTOP_FILE)

# Plain-gjs unit tests (isolated TMPDIR and XDG folders, GTK pages on a
# private Broadway display) and the Python helpers' tests.
unit: schemas
	tools/unit/run.sh

# Froonty in a nested GNOME Shell window, isolated from the session
# (needs mutter-dev-bin).
# SYSTEM_BUS=1 lets it reach the real asusd (tools/devkit.sh --system-bus):
# the Fan settings page's laptop profile and curves then change this
# computer's.
devkit: schemas $(MATHJAX) $(BREAK_ART)
	tools/devkit.sh $(if $(SYSTEM_BUS),--system-bus)

# Isolated headless GNOME Shell 50 runs; do not touch the real session.
# Both session modes: layout can depend on the theme (Ubuntu uses Yaru).
test:
	tools/headless-test/run.sh
	FROONTY_TEST_MODE=ubuntu tools/headless-test/run.sh

log:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
