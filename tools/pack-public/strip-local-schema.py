# SPDX-License-Identifier: GPL-3.0-or-later
"""Remove the working-tree-only keys (ZeroTier, Writing) from a staged schema.

Keys named zerotier-* and writing-* go, and so do comments starting with
"local-only". Both features' *-enabled keys must be there, so a renamed
key cannot slip into a public build unnoticed.
"""

import sys
import xml.etree.ElementTree as ET

PREFIXES = ("zerotier-", "writing-")
REQUIRED = ("zerotier-enabled", "writing-enabled")

path = sys.argv[1]
parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
tree = ET.parse(path, parser)
matches = []
for parent in tree.getroot().iter():
    for child in list(parent):
        if child.tag == "key" and child.get("name", "").startswith(PREFIXES):
            matches.append((parent, child))
        elif child.tag is ET.Comment and (child.text or "").strip().startswith("local-only"):
            matches.append((parent, child))

names = {key.get("name") for _, key in matches if key.tag == "key"}
for required in REQUIRED:
    if required not in names:
        raise SystemExit(f"expected the {required} schema key")

for parent, key in matches:
    parent.remove(key)
tree.write(path, encoding="UTF-8", xml_declaration=True)
