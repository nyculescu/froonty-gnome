# SPDX-License-Identifier: GPL-3.0-or-later
UUID := froonty@catalin
SRC := $(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
# Froonty in Show Apps: opens its settings; Start/Stop Froonty on right
# click (tools/froonty.desktop). Local installs only: the public build
# cannot add one.
DESKTOP_FILE := $(HOME)/.local/share/applications/froonty.desktop

# Absolute paths: on some machines other toolchains (e.g. SUMO) shadow the
# system GLib tools on PATH. Override if needed.
GLIB_COMPILE_SCHEMAS ?= /usr/bin/glib-compile-schemas
GNOME_EXTENSIONS ?= /usr/bin/gnome-extensions

# Every source folder of the extension (schemas are packed separately;
# third_party holds the fetched MathJax, which the public build leaves out).
SOURCE_DIRS := $(filter-out schemas third_party,$(notdir $(patsubst %/,%,$(wildcard $(SRC)/*/))))
MATHJAX := $(SRC)/third_party/mathjax/fetched.json

.PHONY: schemas mathjax install uninstall pack unit test log clean devkit devkit-public

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

# Copies the extension into the user's extensions directory. A copy, not a
# symlink: GNOME Shell loads extensions once, at login, and a link into a
# drive that is mounted later (e.g. a data partition udisks mounts on first
# use) is broken at that moment, so the extension silently does not start.
# GNOME Shell only loads new code at startup: log out and in.
# First install: gnome-extensions enable $(UUID)
install: schemas $(MATHJAX) uninstall
	mkdir -p $(dir $(INSTALL_DIR))
	cp -r $(SRC) $(INSTALL_DIR)
	mkdir -p $(dir $(DESKTOP_FILE))
	cp tools/froonty.desktop $(DESKTOP_FILE)

# rm never follows a symlink named without a trailing slash, so this also
# removes the link of an older install without touching the working tree.
uninstall:
	rm -rf $(INSTALL_DIR)
	rm -f $(DESKTOP_FILE)

# gnome-extensions 46 segfaulted if --out-dir did not exist yet. The archive
# is built from a staged public copy; `make install` keeps local-only features.
pack: schemas
	mkdir -p dist
	GNOME_EXTENSIONS=$(GNOME_EXTENSIONS) GLIB_COMPILE_SCHEMAS=$(GLIB_COMPILE_SCHEMAS) \
		bash tools/pack-public.sh $(SRC) $(SOURCE_DIRS)

# Plain-gjs unit tests (isolated TMPDIR/XDG_DATA_HOME).
unit:
	tools/unit/run.sh

# Isolated headless GNOME Shell 50 runs; do not touch the real session.
# Both session modes: layout can depend on the theme (Ubuntu uses Yaru).
# Froonty in a nested GNOME Shell window, isolated from the session
# (needs mutter-dev-bin); devkit-public runs the make pack build.
devkit: schemas $(MATHJAX)
	tools/devkit.sh

devkit-public:
	tools/devkit.sh --public

test:
	tools/headless-test/run.sh
	FROONTY_TEST_MODE=ubuntu tools/headless-test/run.sh

log:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
	rm -rf dist
