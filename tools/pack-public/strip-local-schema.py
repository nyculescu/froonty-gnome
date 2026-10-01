# SPDX-License-Identifier: GPL-3.0-or-later
"""Remove the working-tree-only ZeroTier keys from a staged schema."""

import sys
import xml.etree.ElementTree as ET

path = sys.argv[1]
parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
tree = ET.parse(path, parser)
matches = []
for parent in tree.getroot().iter():
    for child in list(parent):
        if child.tag == "key" and child.get("name", "").startswith("zerotier-"):
            matches.append((parent, child))

if not any(key.get("name") == "zerotier-enabled" for _, key in matches):
    raise SystemExit("expected the zerotier-enabled schema key")

for parent, key in matches:
    parent.remove(key)
tree.write(path, encoding="UTF-8", xml_declaration=True)