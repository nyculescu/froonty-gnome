# SPDX-License-Identifier: GPL-3.0-or-later
"""Give a staged metadata.json the public build's description.

The working tree's description also covers features the public build
leaves out. gettext-domain goes too: the build ships no translations.

Usage: describe.py METADATA_JSON DESCRIPTION_TXT
"""

import json
import sys

metadata_path, description_path = sys.argv[1], sys.argv[2]
with open(metadata_path, encoding="utf-8") as f:
    metadata = json.load(f)
with open(description_path, encoding="utf-8") as f:
    metadata["description"] = f.read().strip()
metadata.pop("gettext-domain", None)
with open(metadata_path, "w", encoding="utf-8") as f:
    json.dump(metadata, f, indent=4, ensure_ascii=False)
    f.write("\n")
