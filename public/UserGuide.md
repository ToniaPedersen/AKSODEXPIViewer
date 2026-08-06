# AKSO DEXPI Viewer — User Guide

A browser-based viewer for legacy **Proteus 4.1.1 / DEXPI 1.3** P&ID XML files, rendered using **DEXPI 2.x** profile symbols, classes, and attributes supplied by a loaded `DiscProfile.xml`.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [Interface Overview](#3-interface-overview)
4. [Left Panel — Files &amp; Topology Tree](#4-left-panel-files-topology-tree)
5. [Centre Panel — P&amp;ID Drawing](#5-centre-panel-p-id-drawing)
6. [Right Panel — Object Details](#6-right-panel-object-details)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Introduction

AKSO DEXPI Viewer reads an older-generation **Proteus 4.1.1 / DEXPI 1.3** drawing XML file and re-renders it using a **DEXPI 2.x DiscProfile.xml** — the same symbol catalogue, class model, and attribute definitions used by modern DEXPI 2.0 tooling. This lets a legacy 1.3 drawing be inspected, browsed, and cross-checked against a current profile without converting the file first.

The viewer provides:

- **Graphical rendering** of the drawing — symbols, piping lines, signal connectors, heat-trace overlays, and labels.
- **Topology tree** — the full object model as a searchable, expandable tree.
- **Object details** — data attributes, references/associations, parent, and sub-components for any selected object.
- **Connectivity map** — upstream/downstream/group tracing across the piping and instrumentation network.

The application runs entirely in the browser. No file is uploaded anywhere — both XML files are read and parsed locally.

---

## 2. Getting Started

### 2.1 Loading Files

The viewer needs **two** files, loaded from the buttons in the top-left toolbar:

1. **Load Proteus XML** — the Proteus 4.1.1 / DEXPI 1.3 drawing file to be viewed.
2. **Load DiscProfile.xml** — the DEXPI 2.x profile that supplies the symbol catalogue, class mappings, and attribute/label definitions used to render it.

A checkmark appears on each button once its file is loaded, and the loaded file names are listed underneath. The drawing renders as soon as both files are present, and re-renders automatically if either file is reloaded.

Once loaded, a small diagnostics line shows the total object count and how many objects were class-mapped via the TypeURI fallback rule.

---

## 3. Interface Overview

The application is divided into three panels:

| Area | Description |
|------|-------------|
| **Left panel** | Load the two XML files and browse the object topology tree. |
| **Centre panel** | The interactive, zoomable/pannable P&ID drawing. |
| **Right panel** | Details for the currently selected object — its data, references, and network connections. |

The left and right panels can each be collapsed by clicking the arrow button (`<` / `>`) at their edge, giving the drawing more room.

---

## 4. Left Panel — Files &amp; Topology Tree

Below the file-load buttons, the object tree shows the full model as an expandable hierarchy, organised by containment (e.g. a piping system down to its segments and components).

Each row shows the object's label and, on the right, its type suffix (shown in red if the type falls under `Plant/Unmapped.*`, meaning no matching class was found).

Controls above the tree:

- **Search box** — filters the tree in real time by tag, object ID, type, or persistent identifier.
- **Expand all / Collapse all** — expand or collapse the entire tree in one click.

Clicking any row selects that object: it highlights red in the drawing, scrolls into view in the tree, and populates the right panel.

---

## 5. Centre Panel — P&amp;ID Drawing

### 5.1 Navigation

| Action | How |
|--------|-----|
| Zoom | Scroll the mouse wheel over the drawing (zooms toward the cursor) |
| Pan | Hold **Space** and drag |
| Fit to window | Click the **Fit** button in the centre toolbar |
| Export view | Click **Save PNG** / **Save PDF** in the centre toolbar (see 5.10, below) |

### 5.2 Selecting Objects

Click any symbol or piping line in the drawing to select it — the same selection used by the tree and the right panel. The selected object is outlined in red (orange for label elements).

### 5.3 Connectivity

Check **Connectivity** in the centre toolbar to highlight the network neighbours of the selected object:

| Colour | Meaning |
|--------|---------|
| 🔵 Blue | Upstream — flows into the selected object |
| 🟢 Green | Downstream — the selected object flows into these |
| 🟣 Purple | Group — a connection point sits at the exact same drawing position as one of the selected object's own connection points |

A legend appears in the lower-left corner of the drawing while this is on. The highlight is off by default.

### 5.4 Sub-Components

Check **Sub-components** to have a selection also highlight (in red) every child object of the selected item — useful when selecting a container such as a piping segment or system. Off by default, so selecting a large container only highlights the container itself.

### 5.5 Line Weight

The **Line weight** toggle boosts very thin connector lines to a minimum visible stroke width so faint piping doesn't disappear when zoomed out. Toggle it off to render every line at its exact drawn weight.

### 5.6 Background Image

Click **BG Image** to overlay a reference image behind the drawing. Once one is loaded, **BG Controls** appears with:

| Control | Description |
|---------|-------------|
| Visible | Toggle the overlay on or off |
| Opacity | 0–1 |
| Scale | Uniform scale factor applied to the auto-fit size (native aspect ratio is always preserved) |
| X / Y | Offset, in drawing units, from the auto-fit (centered) position — not screen pixels, so the range scales with the drawing's own size |
| Reset fit | Sets scale back to 1 and X/Y back to 0, returning to the auto-fit (centered, aspect-correct) placement |
| ⬇ Download PNG with placement | *PNG images only.* Embeds the current Scale/X/Y into a copy of the loaded PNG and downloads it. The next time that downloaded copy is loaded as a BG image (in this session, a future session, or on another machine), it opens pre-aligned at this placement instead of the auto-fit default. The originally-selected file on disk is never modified. |
| Clear Default | *PNG images only, shown only when the loaded PNG already carries a saved placement.* Downloads a copy of the PNG with the saved placement removed, so a future load of that copy falls back to auto-fit. |
| Remove | Clear the background image |

The image is placed inside the same coordinate space as the drawing, so it pans and zooms in lockstep with it — it stays aligned at any zoom level, not just the level it was set up at.

Only PNG files can carry a saved placement (it's embedded as a small metadata chunk in the PNG itself, not stored anywhere in the browser) — other image formats work as background images exactly as before, just without the Download/Clear Default controls.

### 5.7 Profile Labels

Check **Profile labels** to show labels synthesized from the loaded DiscProfile.xml's `LabelTemplate` definitions, for symbols that carry no explicit `<Label>` XML of their own. Off by default, so only labels genuinely present in the drawing file are shown.

### 5.8 Heat Trace Overlay

When the loaded objects resolve to an active `HeatTracingType`, a dashed orange overlay is drawn automatically — no toggle needed:

- **Piping** — a dashed line offset alongside the pipe run.
- **Inline components** (valves, fittings, nozzles) — a dashed line alongside the symbol, oriented to match the pipe direction.
- **Instruments** (`ProcessInstrumentationFunction`) — a dashed outline following the symbol's actual boundary shape.

### 5.9 Signal-Conveying Line Styles (Proteus files)

For a Proteus/DEXPI 1.3 file's `InformationFlow` elements (signal/instrument wires), the drawn `CenterLine` is decorated according to the `SignalConveyingFunctionTypeRepresentationAssignmentClass` custom attribute (`DexpiCustomAttributes` set), when present:

| Representation value | Line style |
|---|---|
| `ElectricalSignalConveying` | Solid line with a small italic "E" repeated along its length |
| `HydraulicSignalConveying` | Solid line with a small upright "L" repeated along its length |
| `BusSignalConveying` | Solid line with a small circle repeated along its length |
| `PneumaticSignalConveying` | Solid line with a small "^" chevron repeated along its length |
| `CapillarySignalConveying` | Solid line with a small "x" repeated along its length |
| `UndefinedSignalConveying` | Solid line with a small "/" repeated along its length |
| `ElectromagneticGuidedSignalConveying` | Solid line with a small "∿" (sine-wave) squiggle repeated along its length |
| `ElectromagneticUnguidedSignalConveying` | No line drawn — only the repeated "∿" squiggle, since there's no physical conductor to draw |
| `SignalConveying` (plain, no sub-type) | Dashed line, no repeated mark |

Wherever a mark is drawn, the wire's own line runs straight through the mark's visual centre (e.g. through the "E"'s middle bar, the "L"'s vertical arm, the circle's centre, the "x"'s crossing point) rather than sitting to one side of it. Wires with no `SignalConveyingFunctionTypeRepresentationAssignmentClass` attribute at all, or a value not listed above, are drawn as a plain solid line with no decoration.

### 5.10 Exporting the Drawing

Use **Save PNG** or **Save PDF** in the centre toolbar to save exactly what's currently in the drawing viewport — the DEXPI drawing plus the BG image overlay, if one is loaded — as a file. Both buttons are disabled until a drawing is loaded, and while an export is in progress.

- **Save PNG** — rasterizes the current view to a PNG at a fixed long-edge resolution, aspect ratio matching the current view.
- **Save PDF** — the same rendering, embedded as a single full-page image in a PDF (long edge ~420mm, A3-ish). DEXPI/Proteus drawing coordinates aren't reliably tied to real-world units, so this is a print-friendly fit rather than a to-scale export.

The downloaded file name is derived from the drawing number where available.

---

## 6. Right Panel — Object Details

### 6.1 Object Tab

| Section | Content |
|---------|---------|
| Label and type | Display name and full DEXPI type string |
| Object ID | The XML `id` attribute value |
| Persistent Identifiers | Any persistent identifier values, with context |
| Data | Data attributes with formatted values and units of measure. Check **Show non-DEXPI attributes** to reveal attributes outside the standard `DexpiAttributes` / `DexpiCustomAttributes` sets (hidden by default). |
| Symbol Reference | *Proteus/DEXPI 1.3 files only.* The raw `ComponentName`/`SymbolRegistrationNumberAssignmentClass` and `Axis`/`Reference`/`Scale` values the source XML used to place the selected object's own symbol. Shown even when the `ComponentName` didn't resolve to a drawable symbol, so a mismatch can still be diagnosed. |
| Label Symbol Reference(s) | *Proteus/DEXPI 1.3 files only.* Appears when the selected object owns a nested `<Label>` that places a *separate* symbol of its own (e.g. a valve's actuator/instrument marker). Shows that Label's own `SymbolRegistrationNumberAssignmentClass` and `Axis`/`Reference`/`Scale`, without needing to select the Label's own tree node. Click the Label ID shown to jump to it. |
| Note(s) | *Proteus/DEXPI 1.3 files only.* Lists any Note object `ItemID`s referenced by the selected object's (or its Labels') Text templates. Click a Note ID to jump to it. |
| References / Associations | Outgoing references — blue if the target exists in the file, red if broken. Click a reference to jump to its target. |
| Parent Component | The containing object, if any — click to navigate to it. |
| Sub-Components | Direct children of the selected object — click any to navigate to it. |

### 6.2 Connections Tab

Shows the connectivity map for the selected object:

- **Upstream Node** — objects that connect into the selected item.
- **Downstream Node** — objects the selected item connects into.

  For a `PipingNetworkSegment`'s `CenterLine`, each end is matched independently against nearby components' connection points. If only one end lands on a real component (the other end's coordinate doesn't match anything, and there's no off-page connector to fall back to), that one match is still kept rather than discarded — select the `CenterLine` itself in the tree to see whichever one-sided Upstream/Downstream Node it resolved, even though the two real components aren't cross-linked to each other in that case (that direct link needs both ends to resolve).
- **Group** — objects with a connection point positioned exactly on top of one of the selected object's own connection points (within a very small tolerance). This detects physical touches directly, without needing an explicit `<CenterLine>` or `<Connection>` between the two — e.g. two piping components whose flanges meet, or two pipe items placed end-to-end with no drawn pipe run between them.

  This is purely position-based, so it isn't limited to process/piping ports: any connection point counts, including a symbol's drawing-layout anchors (nodes named `PID.T`/`PID.B`/`PID.L`/`PID.R` mark a tag balloon's top/bottom/left/right edge, used for leader-line placement). Two instrument tags stacked directly against each other on the drawing can end up in each other's Group list purely because their balloon edges touch, even with no real signal or process connection between them — check the Object tab's Data/References for the two objects if a Group entry looks unexpected.

Below these, any other structural associations the object carries (e.g. segment/system containment, or a signal wire's logical start/end) are listed in their own labeled sections, using their raw association name if no friendlier label is defined.

Click any entry in either section to navigate to that object.

#### InformationFlow (signal wire) CenterLine

An `InformationFlow` element's `CenterLine` is the drawn line for a signal/instrument wire. Its first and last points are matched by x/y position against nearby components' connection points, the same way a `PipingNetworkSegment`'s `CenterLine` is matched — and the two components that match feed the **Upstream Node** / **Downstream Node** buckets, just like a piping connection. Selecting the wire itself (its node in the tree, or its drawn line) also shows its own Upstream Node / Downstream Node this way — including a one-sided result if only one end of the wire lands on a real component's connection point, rather than showing nothing at all.

This position-based result is kept **separate** from, and shown alongside, the wire's declared logical endpoints: each `InformationFlow` element also carries explicit `Association` entries of type `has logical start` / `has logical end` pointing at its Source/Target components. These appear as their own labeled categories — **Has Logical Start** and **Has Logical End** — rather than under Upstream/Downstream/Group, since a wire's declared logical endpoint and where its drawn geometry physically lands do not always agree. Selecting the referenced component itself shows the reverse relationship, labeled **Is Logical Start Of** / **Is Logical End Of**.

---

## 7. Troubleshooting

**Drawing stays blank after loading both files**
Check the diagnostics line under the file buttons for the object count. If it reads 0, the Proteus XML likely didn't parse — check the browser console for the parse error shown in the left panel.

**Many objects show a red `Unmapped` type**
The loaded DiscProfile.xml doesn't cover every class used in the drawing. Confirm you loaded the DiscProfile.xml that matches this drawing's plant/profile, not a generic or partial one.

**Symbols render without labels**
The drawing file may not carry explicit `<Label>` XML for those symbols. Enable **Profile labels** to show labels synthesized from the DiscProfile's `LabelTemplate` definitions instead.

**Background image is stretched or misaligned**
Use the Scale and X/Y controls in BG Controls, or click **Reset fit** to snap back to the auto-fit (centered) placement. The image always preserves its native aspect ratio; only its uniform scale and X/Y offset are adjustable. It's rendered in the same coordinate space as the drawing, so once placed it stays aligned at any pan/zoom level. Note that the auto-fit placement is computed from the full extent of the parsed drawing, so a Proteus file whose symbols are missing or mis-scaled (see the next item) will also throw off the BG image's auto-fit.

**A symbol placement has no `<Scale>` in the source XML**
Rather than silently omitting it from the canvas, the viewer draws it at a default 1×1 scale, so it's still visible and still counted in the drawing's extent (which the BG image's auto-fit is computed from). Check that object's **Symbol Reference** section in the right panel (6.1) to see the raw `ComponentName`/`Axis`/`Reference`/`Scale` values the source XML actually provided.

**Exported PNG/PDF is missing the background image**
Make sure the BG image is loaded and **Visible** is checked before exporting — Save PNG/Save PDF capture exactly what's currently rendered in the drawing viewport, including the overlay only if it's currently shown.

**Connectivity highlight doesn't show anything**
Make sure an object is selected first — the Connectivity checkbox only highlights relative to the current selection, and only for objects that have upstream/downstream/group relationships in the parsed model.
