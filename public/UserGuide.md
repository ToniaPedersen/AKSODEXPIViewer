# DEXPI 1.4 / DISC Profile Viewer — User Guide

A browser-based viewer and validation tool for legacy **DEXPI 1.4 / Proteus 4.1.1** XML files, rendered and checked using **DEXPI 2.x profile** symbols, classes and attributes by way of a loaded `DiscProfile.xml`.

Developed by **Tonia Pedersen**.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [Interface Overview](#3-interface-overview)
4. [Left Panel](#4-left-panel)
5. [Centre Panel — P&ID Drawing](#5-centre-panel--pid-drawing)
6. [Right Panel — Object Details](#6-right-panel--object-details)
7. [How Validation Works](#7-how-validation-works)
8. [Validation Code Reference](#8-validation-code-reference)
9. [CSV and Excel Export](#9-csv-and-excel-export)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Introduction

The viewer reads a Proteus 4.1.1 / DEXPI 1.4 XML file and provides three things at once:

- **Graphical rendering** — the P&ID is drawn directly from the XML: symbols, piping and signal lines, labels, heat-trace overlays and connectors, using the symbol geometry of the loaded profile where one is supplied.
- **Object model exploration** — a containment tree of every object, with its properties, references, connectivity, symbol placement and raw `ComponentClass`.
- **Validation** — two engines behind one issue list: the **ProteusPIDSchema 4.1.1 disc.xsd** schema check, and a model/profile check of classes, attributes, enumerations, cardinality, symbol usage and geometry against the **DEXPI 1.4 information model** (taken from the official DEXPI P&ID Specification 1.4 XMI) and the loaded **DiscProfile.xml**.

Everything runs in the browser — no server, and no file of yours leaves the machine. The single request the app makes to the network is for the default `DiscProfile.xml` it loads at startup (see [2.2](#22-loading-files)); the XML files you open, and the folders you validate, are read locally and are never sent anywhere.

A `DiscProfile.xml` is loaded **automatically** at startup, from the [DISCDEXPI_2026Pack](https://github.com/ToniaPedersen/DISCDEXPI_2026Pack) repository, so the profile-dependent checks are live from the first file opened. It stays optional: unload it, or start with no way to reach it, and the file is still drawn and the schema and model checks still run in full — only the profile-dependent codes step aside and report *not-evaluated* rather than passing silently.

---

## 2. Getting Started

### 2.1 Running the application

```bash
npm install
npm run dev
```

`npm run build` produces a static bundle in `dist/` that can be hosted anywhere.

This guide is generated: edit `public/UserGuide.md`, then run `python scripts/build-guide.py` (needs `pip install markdown`) to rebuild `public/UserGuide.html`.

### 2.2 Loading files

In the left panel:

1. **Load Proteus XML** — the drawing renders immediately and the Topology tree populates. Required.
2. **Load DiscProfile.xml** — optional, and usually unnecessary, because one is already loaded (see below). Picking a file here replaces the default, which is what you want when checking against a profile revision of your own. A profile resolves symbols, classes and attribute usage and switches on every profile-dependent check; the Proteus file is re-parsed automatically when a profile is added or removed.

Both buttons show a ✓ and turn blue once loaded, and the file names are listed underneath. The small **x** next to the profile name unloads the profile and returns to plain DEXPI viewing.

**The default profile.** At startup the app fetches `Profile/xml/DiscProfile.xml` from the [DISCDEXPI_2026Pack](https://github.com/ToniaPedersen/DISCDEXPI_2026Pack) repository and loads it, listed as `DiscProfile.xml (DISCDEXPI_2026Pack)`. It is fetched with no caching, so a profile published to that repository is picked up on the next page reload. While the fetch is in flight the panel reads *Loading default DiscProfile.xml…*; if it cannot be reached — no network, or GitHub unavailable — an amber note appears with a **Retry** button and the viewer carries on without a profile. A profile loaded by hand always wins: the startup fetch never overwrites one, and unloading the default with **x** does not pull it back.

Under the file names, a diagnostics line reports how many objects were parsed and how many had their class mapped via the TypeURI rule.

### 2.3 Running validation

Both engines run **automatically** when a file is opened, so the Validation tab is filled in by the time the drawing is on screen; its label carries the total issue count. Re-parsing after a profile is loaded or unloaded re-runs the model/profile engine against that profile — the schema engine depends on the file text alone and re-runs only when the file changes.

**Run Validation** (the blue, full-width button) re-runs both engines on the file already loaded. It is there for a deliberate re-check; nothing has to be clicked to get results.

To check a whole folder rather than one file, use **Validate Folder…** (see [4.3](#43-folder-tab--validating-a-whole-folder)).

---

## 3. Interface Overview

| Area | Contents |
|---|---|
| **Left panel** | File loading, Run Validation, and the Topology / Validation / Folder tabs. |
| **Centre panel** | The rendered P&ID drawing and its toolbar. |
| **Right panel** | Object / Connections / Issues for the current selection. |

The side panels collapse with the `<` / `>` button in their header, giving the drawing the full width.

---

## 4. Left Panel

### 4.1 Topology tab

The full object model as an expandable tree, organised by containment (e.g. `PlantModel` → `PipingNetworkSystem` → `PipingNetworkSegment`).

- **Search** — filters the tree live on tag, type, object ID or persistent identifier.
- **Expand all / Collapse all** — the whole tree in one click. The object count is shown on the right.

Clicking a node selects it: the matching graphics are highlighted in the drawing and the right panel fills with its details.

### 4.2 Validation tab

Both engines' results merged into one list, populated as soon as a file is opened. The header row shows the total issue count, which engines contributed, and a **CSV** button ([section 9](#9-csv-and-excel-export)).

- **All / Error / Warning / Info** chips filter the list by type and show the count for each.
- Issues are **grouped by code**. The group header carries the type badge, the code, the code's title and the number of issues in it; click it to fold the group, or use **Expand all / Collapse all**.
- Each row shows the type badge, the code, the source line where one is known, the code's title, the specific message, and the object ID. A row marked ⊕ can be clicked to select that object — the drawing highlights it and the right panel switches to its Issues tab. An object with no graphics is marked **⚠ no symbol** and is not clickable.

Two notices can appear above the list:

- **XSD schema validation unavailable** — the schema check could not run against this file (the reason is shown). Model and profile checks are unaffected.
- **non-DEXPI attribute groups excluded** — how many vendor `GenericAttributes` Sets were left out of the XSD check. Only `Set="DexpiAttributes"` and `Set="DexpiCustomAttributes"` are schema-checked.

### 4.3 Folder tab — validating a whole folder

**Validate Folder…**, under the two load buttons, checks every `.xml` file in a folder — and its subfolders — against the same two engines.

> **Nothing is uploaded.** The files are read and validated inside your browser, on your own machine, and are never sent to a server. The browser asks permission first, worded as *"view and copy files"*, *"let this site view files"* or *"upload N files to this site"* depending on the browser and version. Every one of those is the browser asking whether the page may **read** those files into itself — read access is the only folder permission the app requests, and there is no weaker one. Nothing is sent anywhere, which you can confirm in DevTools → Network: no requests are made while a folder is validated.

The currently loaded `DiscProfile.xml` is used for every file in the run — by default the one fetched at startup (2.2), so there is normally nothing to load first. If no profile is loaded, the app asks for confirmation before starting and names what will be skipped — the run then covers the schema and the DEXPI 1.4 model only, and the header says "no profile". A progress line reports each file as it goes, with **Stop** to end the run early and keep what has been done so far.

Results arrive as one list grouped by file:

- The header shows the folder name, the total issue count, how many files were checked, and which profile was used.
- **All / Error / Warning / Info** chips filter across every file at once; a file with nothing left after filtering drops out of the list.
- Each file's header shows its finding count, or a green **clean** / red **failed** badge. Click it to fold the file; **Expand all / Collapse all** work on the whole run.
- **Open** on any file loads it into the viewer, so a finding can be traced on the drawing.
- **Explorer** opens the drill-down view over the whole run — Layer → Category → Code, and from a code into the documents and lines behind it ([4.4](#44-error-explorer)).
- **CSV** and **Excel** download the whole run as one file — the only file the browser writes, and it goes to your Downloads folder, not back into the folder you picked. Both use the column layout in [section 9](#9-csv-and-excel-export).

A file that cannot be parsed appears with its error instead of findings, rather than dropping out of the run.

### 4.4 Error explorer

**Explorer**, in the Folder tab's button row, opens a drill-down over the findings of the whole folder run in a panel a little over half the width of the window. **Esc**, **Close** or a click outside it returns to the viewer; the run, the filters and the viewer's state are untouched.

The explorer answers a different question from the Folder tab. The Folder tab asks *what is wrong with this file*; the explorer asks *what is wrong across the set, and where*.

**Drilling down.** The panel opens on the four layers and steps inward on a click: **Layer → Category → Code**. Each row is a bar sized by the level's share of the run and split by type — red Error, amber Warning, blue Info — so the shape of the problem is visible before any of it is read. The breadcrumb above the bars steps back out.

- **Size by** — *Occurrences* sizes bars by raw finding count; *Documents hit* sizes them by how many files carry the finding at all. A code that fires thousands of times in two files and a code that fires twice in ninety look very different under the two, and the second is usually the one to fix first.
- **All / Error / Warning / Info** filter the whole tree by type, with counts.

**At the code level** the bars give way to the documents the code was raised in, most hits first, each with its count. Click a document to expand it into the individual findings, ordered by line, each one showing:

- the type badge and the **line number**;
- the **location** — the element, and the attribute where the message names one;
- the object ID, where the finding carries one;
- the message;
- the **source line itself**, read from the file you picked and shown as it appears in the XML.

Source lines are read once per document, straight from the folder pick — no file is re-read from disk until you expand it, and nothing is re-validated. **Open**, on a document row, loads that file into the viewer and closes the explorer, so a finding can be followed onto the drawing.

**The summary panel** on the right tracks whatever is in focus: occurrences, documents hit, the per-type split, and — for a single code — its severity, what the check needs, its scope, and the documents carrying the most hits.

## 5. Centre Panel — P&ID Drawing

The drawing number, name and subtitle from the file are shown at the top left of the toolbar.

### 5.1 Navigation

| Action | How |
|---|---|
| Zoom | Scroll the mouse wheel over the drawing (zooms toward the cursor) |
| Pan | Hold **Space** and drag |
| Fit to window | **Fit** button |
| Select | Click a symbol or line — it is outlined red (orange for labels) |

### 5.2 Toolbar controls

| Control | What it does |
|---|---|
| **Fit** | Fits the whole drawing into the window. |
| **Reset Z-Order (n)** | Appears once objects have been sent to back; restores the file's original paint order for all of them. |
| **Line Boost %** | Stroke-width multiplier for connector/centerlines. 100% is unchanged; raise it to bulk up thin lines, e.g. to match the weight of a background reference image. |
| **Include symbol outlines** | Applies the same Line Boost percentage to symbol outlines as well. Off by default. |
| **Save PNG** / **Save PDF** | Saves the current view — drawing plus background image, if visible. The PDF is a single full-page image, long edge ≈ 420 mm (A3-ish); DEXPI coordinates are not reliably tied to real-world units, so this is a print-friendly fit, not a to-scale export. The file name is taken from the drawing number. |
| **Connectivity** | Colour-codes the selected object's network neighbours (see below). Off by default. |
| **Sub-components** | Makes a selection also highlight every child of the selected object — useful when selecting a container such as a `PipingNetworkSystem`. Off by default. |
| **Profile labels** | Shown only when a profile is loaded (see 5.5). |
| **BG Image** / **BG Controls** | Reference image behind the drawing (see 5.6). |

### 5.3 Connectivity highlighting

With **Connectivity** checked, selecting an object colours its neighbours, and a legend appears in the lower-left corner:

| Colour | Meaning |
|---|---|
| 🔴 Red | The selected object |
| 🔵 Blue | Upstream — flows into the selection |
| 🟢 Green | Downstream — flows out of the selection |
| 🟣 Purple | Group — same piping network segment or instrumentation loop |

### 5.4 Signal-conveying line styles

A `SignalConveyingFunction` whose signal type resolves from the file is decorated automatically with a repeated mark along its line, independent of the line style encoded in the file's own graphics.

| Signal type | Line decoration |
|---|---|
| `ElectricalSignalConveying` | Repeated italic **E** |
| `HydraulicSignalConveying` | Repeated upright **L** |
| `BusSignalConveying` | Repeated small circle |
| `PneumaticSignalConveying` | Repeated **^** chevron |
| `CapillarySignalConveying` | Repeated small **x** |
| `UndefinedSignalConveying` | Repeated **/** slash |
| `ElectromagneticGuidedSignalConveying` | Repeated **∿** squiggle |
| `ElectromagneticUnguidedSignalConveying` | Only the repeated **∿** squiggle — the line itself is hidden, as there is no physical conductor to draw |

Selecting a decorated line, or highlighting it through Connectivity mode, recolours the line and its marks together.

### 5.5 Heat trace overlay

When a profile is loaded, heat-traced items are detected from the `HeatTracingType` property and drawn with dashed overlays on top of the drawing — along piping centerlines, as a dashed box around inline components and nozzles, and as a dashed rectangle around instrument symbols. No toggle: an item is overlaid when its resolved heat-tracing type is an actual tracing system rather than `NoHeatTracingSystem`.

### 5.6 Profile labels

With a profile loaded, a **Profile labels** checkbox appears.

- **Checked** — every catalogued symbol placement shows the value built from the profile symbol's own `Profile/LabelTemplate`, as an overlay, even for symbols that carry no `<Label>` of their own in the file.
- **Unchecked** — the profile's attribute-resolved value replaces the symbol's own literal label text.

### 5.7 Background image

**BG Image** loads a reference image behind the drawing; **BG Controls** then exposes:

| Control | Description |
|---|---|
| Blend | −1 to 1. Centre (0) shows both fully; right fades the image out, left fades the drawing out. |
| Scale | Uniform factor on the auto-fit size; the native aspect ratio is always preserved. |
| X / Y | Offset from the auto-fit (centred) position, **in drawing units** — not screen pixels. |
| Reset fit | Back to scale 1 and offset 0, i.e. the auto-fit placement. |
| ⬇ Download PNG with placement | PNG only. Writes the current Scale / X / Y into a copy of the PNG's own metadata and downloads it; the original file is untouched. Loading that copy later starts pre-aligned, on any machine or browser. |
| Clear Default | Shown once a loaded PNG carries an embedded placement; downloads a copy with it removed. |
| Remove | Unloads the image. |

The image sits in the same coordinate space as the drawing, so it pans and zooms in lockstep and stays aligned at any zoom. Only PNG can carry an embedded placement — other image types re-fit each time they are loaded.

### 5.8 Draw order — Send to Back

Objects are painted in file order, and whatever paints last sits on top for both display and clicking. When a large symbol covers smaller items, select the covering object and click **⇩ Send to Back** in the right panel's Object tab: its graphics move behind everything else and the items underneath become clickable. The button becomes **↺ Restore order** for that object, and **Reset Z-Order (n)** in the centre toolbar restores all of them at once.

> This affects the on-screen draw/click order for the current session only. Nothing is written back to the XML, and it resets when a new file is loaded.

---

## 6. Right Panel — Object Details

### 6.1 Object tab

| Section | Content |
|---|---|
| Label and type | Display name and the resolved DEXPI type (e.g. `Plant/Piping.CentrifugalPump`). |
| ComponentClass | The raw `ComponentClass="…"` attribute exactly as written in the Proteus file, shown alongside the resolved type — the two legitimately differ when a TypeURI assignment maps a custom class onto a profile class. Proteus/1.4 files only. |
| Object ID | The XML `ID`, with the **⇩ Send to Back** button when the object has graphics. |
| Persistent Identifiers | Each `PersistentIdentifier` with its context. |
| Data | Properties with values and units. **Show non-DEXPI attributes** reveals vendor `GenericAttributes` Sets, which are hidden by default; the count of hidden entries is shown. |
| Symbol Reference | The `SymbolRegistrationNumberAssignmentClass` and the raw `Axis` / `Reference` / `Scale` of the Position block that placed the symbol. |
| Label Symbol Reference | The same, for any symbol placed by a nested `<Label>` of this object (e.g. an actuator or special-item marker). |
| Notes | Note ItemIDs referenced by this object's text templates; click to navigate. |
| References / Associations | Outgoing references — blue when the target resolves, red when it does not. |
| Parent Component | The containing object; click to navigate. |
| Sub-Components | Children, with their type suffix and child count; click to navigate. |

### 6.2 Connections tab

The connectivity map for the selection: **Upstream Node** (blue), **Downstream Node** (green) and **Group** (purple), followed by the structural associations — segment/system containment, logical start/end, and any other association type — each under its own heading. Every entry is clickable.

### 6.3 Issues tab

The validation issues attached to the selected object, with type, code, title and message. Populated as soon as the file is opened and validated; schema findings carry a line number rather than an object, so they appear only in the Validation tab.

---

## 7. How Validation Works

### 7.1 Two engines, one vocabulary

| Engine | What it checks | Needs |
|---|---|---|
| **XSD schema** | The file against `ProteusPIDSchema 4.1.1 disc.xsd`, via `xmllint-wasm`. | `xmllint-wasm` resolving |
| **Model / profile** | Classes, properties, multiplicity, references, symbol usage, profile scope and node geometry against the DEXPI 1.4 information model and the loaded `DiscProfile.xml`. | Always runs |

Both speak the same classification codes, so a code shown in the viewer, a code in an exported CSV or Excel report and a code in the classification register are the same identifier.

### 7.2 Anatomy of a code

A code reads `LAYER-CATEGORY-NN`, e.g. `MDL-PRP-03`. The layer is the first three letters:

| Layer | Meaning |
|---|---|
| **SER** | Serialization & schema — is the file valid XML, and valid against the schema? |
| **MDL** | Effective information model — do classes, properties, multiplicities and references hold up? |
| **PRF** | DISC profile — symbols, label templates, allowed classes and properties. |
| **GEO** | Node placement & geometry — grid, node positions, connection alignment. |

### 7.3 pass, fail, and not-evaluated

Two independent facts gate every code:

- **Needs** — what data the check requires: the XSD alone, the information model, the profile, or both. `Model (+ profile if DISC)` means the profile is required only when the file claims DISC — the profile declares 172 classes of its own, so a DISC file checked without it cannot have its class names resolved at all.
- **Scope** — which files the check is meaningful for: all DEXPI files, or only a file that claims the DISC profile. Asking whether a plain DEXPI file stays inside the DISC `AllowedClasses` list is meaningless, because it never claimed to.

A check that cannot be answered reports **not-evaluated**, never *pass*. That is the difference between a file that is clean and a file that was never really checked. In the viewer an unevaluated code produces no findings at all.

Codes marked as not implemented in [section 8](#8-validation-code-reference) are registered and reserved, but the check behind them is not written yet — they always report not-evaluated.

---

## 8. Validation Code Reference

81 codes are registered; 40 are implemented today. **Type** is the default the viewer gives the code (Major → Error, Minor → Warning). **Needs** and **Scope** are the gates described in 7.3, and **Implemented** marks the checks that actually run today.

The five DEXPI 2.0-only codes (`SER-FMT-03`, `SER-FMT-05`, `MDL-REF-06`, `PRF-LBL-05`, `PRF-SYM-05`) are deliberately absent: this tool can never produce them for a 1.3/1.4 file, and carrying them would report them as not-evaluated for ever.

### SER — Serialization & schema

| Code | Issue | Category | Type | Needs | Scope | Implemented |
|---|---|---|---|---|---|:--:|
| `SER-CNT-01` | Declared count disagrees with actual children | Declared counts | Warning | XSD only | All files | ✓ |
| `SER-FMT-01` | File is not well-formed XML | File format | Error | XSD only | All files | — |
| `SER-FMT-02` | Wrong root element for the declared version | File format | Error | XSD only | All files | ✓ |
| `SER-FMT-04` | Declared version does not match the content | File format | Error | XSD only | All files | ✓ |
| `SER-IDN-01` | Duplicate id within the file | Identity & references | Error | XSD only | All files | ✓ |
| `SER-IDN-02` | id does not match the ID pattern | Identity & references | Error | XSD only | All files | ✓ |
| `SER-IDN-03` | Reference does not resolve inside the file | Identity & references | Error | XSD only | All files | — |
| `SER-IDN-04` | Name collision in one scope | Identity & references | Error | XSD only | All files | ✓ |
| `SER-REQ-01` | Required attribute missing | Required content | Error | XSD only | All files | ✓ |
| `SER-REQ-02` | Required child element missing | Required content | Error | XSD only | All files | ✓ |
| `SER-STR-01` | Element not permitted in this parent | Document structure | Error | XSD only | All files | ✓ |
| `SER-STR-02` | Element order violates the schema sequence | Document structure | Warning | XSD only | All files | — |
| `SER-STR-03` | Foreign element or attribute | Document structure | Warning | XSD only | All files | ✓ |
| `SER-VAL-01` | Value does not match its lexical pattern | Lexical values | Error | XSD only | All files | ✓ |
| `SER-VAL-02` | Empty or placeholder reference string | Lexical values | Error | XSD only | All files | — |
| `SER-VAL-03` | Value not lexically valid for its datatype | Lexical values | Error | XSD only | All files | ✓ |
| `SER-VAL-04` | Enumeration literal not declared | Lexical values | Error | XSD only | All files | ✓ |

### MDL — Effective information model

| Code | Issue | Category | Type | Needs | Scope | Implemented |
|---|---|---|---|---|---|:--:|
| `MDL-CLS-01` | Class not defined in the model | Class usage | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-CLS-02` | Abstract class used as an object class | Class usage | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-CLS-03` | Class contradicts other evidence in the file | Class usage | Error | Model + profile | DISC files | ✓ |
| `MDL-CLS-04` | Type URI unresolvable or echoes the class name | Class usage | Warning | Model + profile | DISC files | ✓ |
| `MDL-CLS-05` | Vendor marker class emitted | Class usage | Warning | Model (+ profile if DISC) | All files | ✓ |
| `MDL-CMP-01` | Components property not defined for the parent class | Composition | Error | Model (+ profile if DISC) | All files | — |
| `MDL-CMP-02` | Child class not permitted by the composition property | Composition | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-CMP-03` | Required sub-component missing | Composition | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-CMP-04` | Container present but empty | Composition | Warning | Model (+ profile if DISC) | All files | — |
| `MDL-CYC-01` | Cyclic dependency | Cyclic dependency | Error | Model | All files | — |
| `MDL-MUL-01` | Multiplicity bound violated | Multiplicity | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-MUL-03` | Opposite multiplicity exceeded | Multiplicity | Error | Model (+ profile if DISC) | All files | — |
| `MDL-MUL-04` | Duplicate entry in a unique property | Multiplicity | Warning | Model (+ profile if DISC) | All files | — |
| `MDL-PRP-01` | Property not defined on the class or an ancestor | Properties | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-PRP-02` | Property value type does not match the declared type | Properties | Error | Model (+ profile if DISC) | All files | — |
| `MDL-PRP-03` | Required property absent | Properties | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-PRP-04` | Property value outside its declared constraint | Properties | Warning | Model (+ profile if DISC) | All files | — |
| `MDL-PRP-05` | Standard namespace claimed for a non-standard attribute | Properties | Warning | Model (+ profile if DISC) | All files | ✓ |
| `MDL-PRP-06` | Serialized attribute name does not reduce to a model property | Properties | Warning | Model (+ profile if DISC) | All files | — |
| `MDL-REF-01` | Reference target absent from the file | References & endpoints | Error | Model (+ profile if DISC) | All files | — |
| `MDL-REF-02` | Target class not permitted by the reference property | References & endpoints | Error | Model (+ profile if DISC) | All files | — |
| `MDL-REF-03` | Endpoint role violated | References & endpoints | Error | Model (+ profile if DISC) | All files | ✓ |
| `MDL-REF-04` | Endpoint class cannot be determined | References & endpoints | Warning | Model (+ profile if DISC) | All files | ✓ |
| `MDL-REF-05` | Object never participates where the model expects it to | References & endpoints | Warning | Model (+ profile if DISC) | All files | ✓ |
| `MDL-TAG-01` | Taggable object carries no identifier | Identification | Warning | Model | All files | — |
| `PRF-EXT-01` | Extension property used off its baseType | Properties | Error | Model + profile | DISC files | — |
| `PRF-EXT-02` | Extension attribute emitted without the vendor namespace | Properties | Warning | Model + profile | DISC files | — |
| `PRF-EXT-04` | Object rdl_uri disagrees with the profile class it claims | Class usage | Warning | Model + profile | DISC files | — |
| `PRF-MAP-01` | 1.4 class has no counterpart by name | Class usage | Warning | Model + profile | DISC files | — |
| `PRF-MAP-02` | RDL URI does not resolve against the profile | Class usage | Warning | Model + profile | DISC files | ✓ |
| `PRF-MAP-03` | Custom wrapper does not match the family its URI resolves to | Class usage | Error | Model + profile | DISC files | — |
| `PRF-MAP-04` | Class mapped by name across a version rename | Class usage | Error | Model + profile | DISC files | — |

### PRF — DISC profile — symbols & scope

| Code | Issue | Category | Type | Needs | Scope | Implemented |
|---|---|---|---|---|---|:--:|
| `PRF-EXT-03` | Type code outside the symbol's AllowedTypeCodes | Symbol usage | Warning | Profile | DISC files | — |
| `PRF-LBL-01` | Label references an attribute the symbol does not permit | Label templates | Error | Profile | DISC files | ✓ |
| `PRF-LBL-02` | Label is literal text with no attribute template | Label templates | Warning | Profile | DISC files | ✓ |
| `PRF-LBL-04` | Label template index or position not defined by the variant | Label templates | Warning | Profile | DISC files | — |
| `PRF-MAP-05` | 1.4 Shape class used where 2.0 expects SymbolUsage | 1.4 → DISC mapping | Warning | Profile | DISC files | — |
| `PRF-MAP-06` | Serialized symbol name does not reduce to a profile symbol | 1.4 → DISC mapping | Warning | Profile | DISC files | — |
| `PRF-SCP-01` | Class outside the DISC AllowedClasses list | DISC scope | Error | Profile | DISC files | ✓ |
| `PRF-SCP-02` | Property outside the DISC AllowedProperties list | DISC scope | Warning | Profile | DISC files | ✓ |
| `PRF-SYM-01` | Symbol not in the SymbolCatalogue | Symbol usage | Error | Profile | DISC files | ✓ |
| `PRF-SYM-02` | Symbol used for a class its usage does not cover | Symbol usage | Error | Profile | DISC files | ✓ |
| `PRF-SYM-03` | Drawn object places no symbol | Symbol usage | Warning | Profile | DISC files | — |
| `PRF-SYM-04` | Placeholder or disabled symbol name emitted | Symbol usage | Warning | Profile | DISC files | — |
| `PRF-TRN-01` | Transform applied where the profile forbids it | Symbol transforms | Warning | Profile | DISC files | — |
| `PRF-TRN-05` | Zero or negative scale | Symbol transforms | Error | Profile | DISC files | ✓ |
| `PRF-VAR-01` | Variant condition not satisfied | Variant selection | Warning | Profile | DISC files | — |
| `PRF-VAR-02` | No variant selected or VariantNumber out of range | Variant selection | Warning | Profile | DISC files | — |

### GEO — Node placement & geometry

| Code | Issue | Category | Type | Needs | Scope | Implemented |
|---|---|---|---|---|---|:--:|
| `GEO-ALN-01` | Connected items not coincident | Connection alignment | Error | Model | All files | ✓ |
| `GEO-ALN-02` | Zero-length connector | Connection alignment | Error | Model | All files | ✓ |
| `GEO-ALN-03` | Duplicate ports co-located | Connection alignment | Warning | Profile | DISC files | — |
| `GEO-DIR-01` | Connection approaches at a direction the node forbids | Approach direction | Warning | Profile | DISC files | — |
| `GEO-GRD-01` | SymbolUsage position not on the grid | Grid alignment | Error | Profile | DISC files | ✓ |
| `GEO-GRD-02` | Node position not on the grid | Grid alignment | Error | Profile | DISC files | ✓ |
| `GEO-NCT-01` | Node referenced by no connection | Node counts | Warning | Model | All files | ✓ |
| `GEO-NCT-02` | Connection count outside the node's declared bounds | Node counts | Error | Profile | DISC files | — |
| `GEO-NCT-04` | Component declares more ports than are referenced | Node counts | Warning | Profile | DISC files | — |
| `GEO-NPS-01` | Node not at a connection point of the placed symbol | Node position | Error | Profile | DISC files | — |
| `GEO-NPS-02` | Node position cannot be checked — no symbol placed | Node position | Warning | Profile | DISC files | — |
| `GEO-NPS-03` | Profile symbol declares no connection points | Node position | Warning | Model | All files | — |
| `GEO-NTY-01` | Piping node used by a non-piping connection | Node type usage | Error | Profile | DISC files | — |
| `GEO-NTY-03` | Instrumentation node used by a piping connection | Node type usage | Error | Profile | DISC files | — |
| `GEO-SNS-01` | Sensing location not coincident with the measured item | Sensing location | Warning | Model | All files | — |
| `GEO-SNS-02` | Sensing location references an impermissible object type | Sensing location | Error | Model | All files | — |

**`GEO-ALN-01` — piping segment continuity.** For each `PipingNetworkSegment`, the check takes the first and last point of every CenterLine and the connection-node positions of every component, and requires that:

- all items in the segment join into a single run, with touching end points (within 0.01 drawing units). If they don't, one finding lists the separate runs, e.g. *run 1: CenterLine 1, BallValve-3; run 2: BlindFlange-1*.
- the segment's start and end sit on the nodes named in its `Connection` (`FromID`/`FromNode`, `ToID`/`ToNode`). If not, the finding gives the expected node position, the nearest point in the segment and the distance between them. An end that connects to another segment, or to a node with no position, is skipped.

Items with neither points nor positioned nodes, such as flow arrows, are ignored. The finding is reported on the segment.

---

## 9. CSV and Excel Export

The **CSV** button in the Validation tab writes every issue of the current run (all types, not just the filtered ones). The Folder tab's **CSV** and **Excel** buttons write every issue of a whole folder run. All three use the same columns, one row per finding:

| Column | Contents |
|---|---|
| Classification code | The code, e.g. `SER-VAL-02`. Blank on a row reporting a file that could not be validated. |
| Causes | Always blank — kept for alignment with the issue lists this feeds into. |
| Nr | Sequence number within the file, starting at 1. |
| Source URI | Blank unless the finding carries one. |
| File | The file the finding came from. |
| Line | Source line, where one could be resolved. |
| Location | The element, and the attribute where the message names one: `<References>, attribute "objects"`. |
| Level | `ERROR`, `WARNING` or `INFO`. |
| Type | `Schema Error`, `Model Error`, `Profile Error` or `Geometry Error`, from the code's layer. |
| Description | The specific detail — the object, attribute or value at fault. |

CSV files are UTF-8 with CRLF line endings and quoted fields.

> If characters look garbled in Excel, open the CSV with **Data → From Text/CSV** and select UTF-8.

---

## 10. Troubleshooting

**Default DiscProfile.xml unavailable**
The startup fetch could not reach GitHub — no network, a proxy in the way, or the repository moved. Use **Retry** in the amber note, or load a `DiscProfile.xml` by hand; everything except the profile-dependent codes works meanwhile.

**Explorer: "source line unavailable"**
The picked folder is no longer readable — the permission lapsed, or the file changed since the run. Re-run **Validate Folder…** on the folder.

**No PRF or GEO findings at all**
Those codes need a profile. Check that one is listed under the load buttons — if the default could not be fetched, load a `DiscProfile.xml` by hand. Without one the codes report not-evaluated rather than passing.

**Everything reports not-evaluated for a DISC file**
The file claims DISC but no profile was loaded, so its class names cannot be resolved. Load the profile.

**Drawing renders blank or partially**
The file may reference profile symbols that are not loaded. Load the matching `DiscProfile.xml` — the file is re-parsed automatically when a profile is added.

**An item cannot be clicked in the drawing**
Something is painted over it. Select the covering object and use **⇩ Send to Back** (5.8).

**Background image will not line up, or resets every time**
Offsets are in drawing units, not pixels; **Reset fit** returns to the auto-fit placement. Only PNG can carry a saved placement, and only the copy downloaded with **⬇ Download PNG with placement** carries it — the original file is never modified.

**Excel shows garbled characters in the CSV**
Open it with **Data → From Text/CSV** in Excel and select UTF-8.
