#!/usr/bin/env python3
"""
Builds src/dexpiRdlUris.json: the MetaData/rdl_uri of every DEXPI 1.4 model
class and data attribute, keyed by the names used in src/dexpi14Rdl.json.

Sources, in order:
  1. The DEXPI 2.0 model files the DISC profile imports (Plant.xml,
     Process.xml, Core.xml in DISCDEXPI_2026Pack/Profile/xml). Their rdl_uri
     values are the ones the DEXPI 1.4 specification lists for the same
     class/attribute. DEXPI 2.0 renames (Equipment -> ProcessEquipment,
     DexpiModel -> PlantModel) are mapped back to the 1.4 names.
  2. scripts/dexpi14-rdl-overrides.json: classes and attributes only the
     DEXPI 1.4 specification carries (Custom<X> attributes, MetaData plant
     structure attributes, NominalCapacity(Volume), ...), copied from the
     1.4 reference pages.
  3. Custom<X> classes with no URI from 1 or 2 get the 1.4 convention
     http://sandbox.dexpi.org/rdl/Custom<X>.

Usage:  python scripts/build-rdl-uris.py <path to DISCDEXPI_2026Pack/Profile/xml>
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_FILES = ["Plant.xml", "Process.xml", "Core.xml"]
RENAMES_14_TO_20 = {"Equipment": "ProcessEquipment", "DexpiModel": "PlantModel"}
SANDBOX = "http://sandbox.dexpi.org/rdl/"


def rdl_uri(el):
    for data in el.findall("Data"):
        if data.get("property") == "MetaData/rdl_uri":
            s = data.find("String")
            return (s.text or "").strip() if s is not None else ""
    return ""


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    model_dir = Path(sys.argv[1])
    rdl14 = json.loads((ROOT / "src" / "dexpi14Rdl.json").read_text(encoding="utf-8"))
    overrides = json.loads((ROOT / "scripts" / "dexpi14-rdl-overrides.json").read_text(encoding="utf-8"))

    classes20, props20 = {}, {}
    for name in MODEL_FILES:
        for el in ET.parse(model_dir / name).getroot().iter():
            if el.tag not in ("ConcreteClass", "AbstractClass"):
                continue
            cls = el.get("name")
            if rdl_uri(el):
                classes20[cls] = rdl_uri(el)
            for prop in el.findall("DataProperty"):
                if rdl_uri(prop):
                    props20[f"{cls}.{prop.get('name')}"] = rdl_uri(prop)

    classes, properties = {}, {}
    for cls in rdl14["classes"]:
        uri = classes20.get(RENAMES_14_TO_20.get(cls, cls)) or overrides["classes"].get(cls)
        if not uri and cls.startswith("Custom"):
            uri = SANDBOX + cls
        if uri:
            classes[cls] = uri
    for full, info in rdl14["properties"].items():
        if info.get("kind") != "Data":
            continue
        cls, prop = full.split(".", 1)
        uri = props20.get(f"{RENAMES_14_TO_20.get(cls, cls)}.{prop}") or overrides["properties"].get(full)
        if uri:
            properties[full] = uri

    out = {
        "_source": "DEXPI 2.0 model files (DISCDEXPI_2026Pack/Profile/xml) + scripts/dexpi14-rdl-overrides.json; built by scripts/build-rdl-uris.py",
        "classes": dict(sorted(classes.items())),
        "properties": dict(sorted(properties.items())),
    }
    (ROOT / "src" / "dexpiRdlUris.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"classes: {len(classes)} / {len(rdl14['classes'])}, properties: {len(properties)}")
    missing = [f for f, i in rdl14["properties"].items() if i.get("kind") == "Data" and f not in properties]
    print("data properties without rdl_uri:", len(missing))
    for f in missing:
        print("  ", f)


if __name__ == "__main__":
    main()
