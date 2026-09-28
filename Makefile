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

# Symlinks the working tree into the user's extensions directory.
# GNOME Shell 46 only discovers new extensions at startup: log out and in
# (Wayland) or press Alt+F2, r (X11), then: gnome-extensions enable $(UUID)
install: schemas
	mkdir -p $(dir $(INSTALL_DIR))
	ln -sfn $(CURDIR)/$(SRC) $(INSTALL_DIR)

uninstall:
	rm -f $(INSTALL_DIR)

# gnome-extensions 46 segfaults if --out-dir does not exist yet.
pack: schemas
	mkdir -p dist
	$(GNOME_EXTENSIONS) pack --force $(addprefix --extra-source=,$(SOURCE_DIRS)) \
		--out-dir=$(CURDIR)/dist $(SRC)

# Plain-gjs unit tests (isolated TMPDIR/XDG_DATA_HOME).
unit:
	tools/unit/run.sh

# Isolated headless GNOME Shell 46 run; does not touch the real session.
test:
	tools/headless-test/run.sh

log:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
	rm -rf dist
