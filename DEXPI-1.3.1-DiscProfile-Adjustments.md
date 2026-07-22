# Special Adjustments: Rendering DEXPI 1.3.1 Files with DiscProfile.xml Definitions

## Overview

DEXPI 1.3.1 files (Proteus 4.1.1 `<PlantModel>` XML) are not natively compatible with a DEXPI 2.x `DiscProfile.xml`. The `proteusParser.js` module bridges the two formats so a legacy 1.3.1 drawing can be rendered, browsed, and cross-checked using a modern DiscProfile's symbol catalogue, class model, and attribute definitions. This report documents the special adjustments that make this translation possible.

## 1. Core Translation Rules

Three mapping rules connect Proteus's own vocabulary to the DiscProfile's DEXPI 2.x model:

**Class mapping.** An object's `TypeURIAssignmentClass` GenericAttribute value is matched against the DiscProfile's `MetaData/rdl_uri` on each `ConcreteClass`/`AbstractClass` to resolve its DEXPI 2.x type string.

**Symbol mapping.** The ShapeCatalogue entry's `SymbolRegistrationNumberAssignmentClass` value is matched against the DiscProfile's `Profile/Symbol` object names. Proteus's own shape geometry is never read or rendered — all symbol primitives, variant bounds, and node positions come exclusively from the loaded DiscProfile.xml.

**Attribute mapping.** Each GenericAttribute's `AttributeURI` is matched against a `DataProperty`'s `rdl_uri` to relabel it as `DiscProfile/<name>`. Attributes that don't resolve fall back to `Proteus/<name>` rather than being dropped.

**Custom-class resolution.** Proteus's DEXPI 1.3 RDL defines generic "Custom*" placeholder classes (CustomEquipment, CustomOperatedValve, CustomPipingComponent, etc.). Their true semantic type is carried via `TypeURIAssignmentClass` and resolved against the DiscProfile's declared `superTypes`, confirming the resolved class actually corresponds back to the Custom class used.

## 2. Geometry and Coordinate Conversion

| Adjustment | Reason |
|---|---|
| Y-axis negation | Proteus's `<Location>` uses a Y-up frame; DEXPI/SVG use Y-down. |
| Rotation sign flip on mirrored placements | Negating Y flips the effective handedness of the `<Reference>` vector's angle; mirroring flips it back — verified against all 8 rotation × mirror combinations. |
| `<Scale>` element support | Sizes a placed symbol (e.g. `Scale X="4.375" Y="4.03869..."`); defaults to 1/1 when absent. |
| Symbol variant selection | A GenericAttribute's short-code value (e.g. `ValvePosition="NC"`) is matched against the DiscProfile's `PropertyValueCondition` to pick the correct `SymbolVariant`. |

## 3. Labels

Explicit `<Label>` XML is used when present. When an object carries none — common in real Proteus/Comos exports — labels are synthesized instead from the DiscProfile's `LabelTemplate` definitions, with `<AttributeName>` and `RelatedClass:<AttributeName>` tokens substituted from the object's own data or an associated object's data. The synthesized label is transformed through the same translate/rotate/scale/mirror math as the symbol placement itself.

## 4. Connectivity Derivation

Proteus/AKSO-style exports frequently omit explicit `<Connection>` elements, so connectivity has to be derived from drawing geometry:

- **CenterLine endpoint matching** — a segment's CenterLine first/last coordinates are matched (0.001-unit tolerance) against components' `ConnectionPoints`/`Node` positions to derive upstream/downstream links. One-sided matches are kept rather than discarded when only one end resolves.
- **Off-page connector fallback** — `PipeOffPageConnector` elements never carry their own `ConnectionPoints`, so an unresolved CenterLine end is matched against same-segment off-page connectors within a 50-unit tolerance instead of being dropped entirely.
- **Coincident connection points** — components whose connection points sit at the exact same position with no CenterLine drawn between them are grouped as non-directional "Group" links. Groups are capped at 4 distinct owners to exclude degenerate placeholder coordinates (e.g. `(0,0)` shared by unrelated elements).
- **Segment/System containment** — tracked as its own structural category, kept separate from position-derived connectivity so a container relationship (e.g. "last item in a segment") isn't mistaken for a physical connection.
- **Signal wires (InformationFlow)** — accepted even without a `ComponentClass` attribute, since real-world exports sometimes omit it. Declared logical start/end associations are kept separate from, but shown alongside, connectivity derived from the wire's own CenterLine. The wire's own connection points are excluded from the matching index to prevent it from self-matching its own endpoints.

## 5. Data Display

GenericAttributes are tagged by their enclosing group's `Set` attribute, letting the UI distinguish genuine DEXPI-modeled attributes (`DexpiAttributes`/`DexpiCustomAttributes`) from vendor- or tool-specific ones — the latter are hidden by default.

## Summary

Together, these adjustments let a legacy DEXPI 1.3.1 / Proteus 4.1.1 drawing be re-rendered through a modern DEXPI 2.x DiscProfile without first converting the source file, reproducing the same tree, graphics, and connectivity model that a native DEXPI 2.x parser would produce.
