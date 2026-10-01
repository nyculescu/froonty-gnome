# SPDX-License-Identifier: GPL-3.0-or-later
UUID := froonty@catalin
SRC := $(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

# Absolute paths: on some machines other toolchains (e.g. SUMO) shadow the
# system GLib tools on PATH. Override if needed.
GLIB_COMPILE_SCHEMAS ?= /usr/bin/glib-compile-schemas
GNOME_EXTENSIONS ?= /usr/bin/gnome-extensions

# Every source folder of the extension (schemas are packed separately).
SOURCE_DIRS := $(filter-out schemas,$(notdir $(patsubst %/,%,$(wildcard $(SRC)/*/))))

.PHONY: schemas install uninstall pack unit test log clean

schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	$(GLIB_COMPILE_SCHEMAS) --strict $(SRC)/schemas

# Copies the extension into the user's extensions directory. A copy, not a
# symlink: GNOME Shell loads extensions once, at login, and a link into a
# drive that is mounted later (e.g. a data partition udisks mounts on first
# use) is broken at that moment, so the extension silently does not start.
# GNOME Shell only loads new code at startup: log out and in.
# First install: gnome-extensions enable $(UUID)
install: schemas uninstall
	mkdir -p $(dir $(INSTALL_DIR))
	cp -r $(SRC) $(INSTALL_DIR)

# rm never follows a symlink named without a trailing slash, so this also
# removes the link of an older install without touching the working tree.
uninstall:
	rm -rf $(INSTALL_DIR)

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
test:
	tools/headless-test/run.sh
	FROONTY_TEST_MODE=ubuntu tools/headless-test/run.sh

log:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
	rm -rf dist
