# Changelog

## 2.10

Changes from version 2.9 (commit `47fae6f` "align between DEXPIViewer and AKSODEXPIViewer"). This release ports DEXPIViewer 2.5 (commit `37e4029` "Version 2.5") to the Proteus 4.1.1 viewer.

### Version

- The app is versioned as **2.10** (`package.json` / `package-lock.json` 2.10.0, `README.md`, User Guide).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Mixed labels keep the file's label as it is

With **Mixed labels**, a `<Label>` text that is a valid representation (it references, with a value, at least one of the label symbol's profile LabelTemplate attributes through an `ObjectAttributesReference` with an `ItemID`) is now shown exactly as with both checkboxes unticked. It is no longer rebuilt from the profile LabelTemplate's values and in-between literals, so a difference from the profile label stays visible:

Illustration (values as on an ND0077 reducer and an instrument tag):

| File text | Profile template | 2.9 Mixed | 2.10 Mixed |
|---|---|---|---|
| `In` + `Out`, no literal | ND0077 `<NominalDiameterRepresentationIn>x<NominalDiameterRepresentationOut>` | `0400x0150` | `04000150` |
| `ProcessPlantIdentificationCode` + `PlantSystemIdentificationCode` | `<ProcessPlantIdentificationCode>-<PlantSystemIdentificationCode>` | `D-26` | `D26` |

The other Mixed labels rules are unchanged: a `<Label>` text that references none of the symbol's label attributes with a value is not drawn, and each profile label is drawn as the default when none of its own attributes is used by a `<Label>` text of the placement. The rule that joined a `Units` reference to a preceding `Value` reference of the same attribute under Mixed labels is gone; the text shows what each reference's `DependantAttributeContents` asks for, as when unticked.

Checked against 2.9 on FPQ-AKSO-P-XB-20030-01 (26 Mixed label texts), DISC_EXAMPLE-05-10 and C01V04 with the default profile: no label text changes, because their file labels already match the profile separators.

- `src/proteusParser.js`: `formatRepresentationGroupLabel()`, `labelTemplateParts()` and `variantLabelTemplateTexts()` are replaced by `representationGroupAttributes()`; `repGroupValue` is now `resolvedTemplateValue` (the unticked text) when the Text references a label attribute with a value.
- `src/App.jsx`: comments and the Mixed labels tooltip.

The DEXPIViewer 2.5 change "literal-only labels show their LiteralText fragments, never the stored Text" needs no port: this viewer never draws a Text's `String`, and a Text with no `ItemID` reference is not drawn.

### MDL-CMP-01: objects nested in a signal line

`MDL-CMP-01` (*Components property not defined for the parent class*) is now implemented. It reports every plant object element nested in an `<InformationFlow>`: SignalConveyingFunction and its subtypes MeasuringLineFunction and SignalLineFunction have no composition property in the DEXPI model, so they cannot contain objects. Graphics and annotation children (`Label`, `Symbol`, `SignalConnectorSymbol`, `CenterLine`, `Connection` …) are not reported. The message says where the object belongs (a `PipingComponent` in a PipingNetworkSegment, a `Nozzle` in its Equipment, …) and names any object that already points to it with `Association Type="is located in"` (e.g. ProcessSignalGeneratingFunction.SensingLocation). This is the Proteus counterpart of DEXPIViewer's extended ERR-E08.

Example from FPQ-AKSO-P-XB-20030-01: flange `XMP_1269` (`<PipingComponent ComponentClass="Flange">`, D-41L00041A-F006) is nested in MeasuringLineFunction `XMP_2440`; ProcessSignalGeneratingFunction-1 already points to it with `is located in`. The file gets 14 new MDL-CMP-01 errors (5 Flanges nested in MeasuringLineFunctions, 9 in SignalConveyingFunctions); no other findings change. The XSD check flagged only 3 of these `<PipingComponent>` elements (SER-STR-01, element not expected), and none of a `<Component>`, which disc.xsd allows in `<InformationFlow>`.

- `src/rdlValidate.js`: `SIGNAL_LINE_NON_OBJECT_TAGS`, `SIGNAL_LINE_CHILD_HOME`, the "signal-line-child" check in the InformationFlow pass, summary `signalLineChildren`.
- `src/issueCodes.js`: `MDL-CMP-01` `implemented: true`.

### DXF export

A **DXF** button saves the whole drawing (not just the current view) as an AutoCAD R12 ASCII DXF with vector geometry: LINE / POLYLINE, CIRCLE and ARC, and TEXT with height, rotation and alignment. Elements go on the layers SYMBOLS, LINES, LABELS and HEAT_TRACE; stroke colours map to the nearest AutoCAD colour index, and each dash pattern gets its own LTYPE. Y is flipped and `$INSUNITS` is millimetres (Proteus `<Drawing>` coordinates). Labels are exported as currently shown (Profile labels / Mixed labels). The BG image and selection/connectivity highlights are left out. Unlike DEXPIViewer, the drawing group here carries the BG **Blend** opacity, so it is marked `data-dxf-keep-opacity` and exported whatever the blend.

- `src/dxfExport.js` (new, from DEXPIViewer 2.5): `svgToDxf()`; `isDrawn()` honours `data-dxf-keep-opacity`.
- `src/App.jsx`: `exportAsDxf()`, `cleanExport` state, `data-dxf-root` around the drawing and heat-trace overlays, `data-dxf-layer` (`dxfLayerFor()`), heat-trace overlays wrapped in a `HEAT_TRACE` group.

### Toolbar

- **PNG**, **PDF** and **DXF** (was **Save PNG** / **Save PDF**) are one button group at the right-hand end of the centre toolbar, with a download icon.
- **Fit** and **BG PNG** (was **BG Image**) sit next to them with icons; **BG PNG** is blue while an image is loaded. **BG Controls** is now a sliders icon button.
- The Folder tab's batch **Save PNG…** is unchanged.

### DependantAttributeContents spellings

A label text built from its `DependantAttribute` references shows the value, the unit, or both, as each reference's `DependantAttributeContents` asks. Units are shown with their short Core.xml symbol (`Kilowatt` -> `kW`). Spellings outside the schema are now read as the schema value they stand for: `ValueAndUnit` as `ValueAndUnits` and `Unit` as `Units`, ignoring letter case. Before this change, such a reference showed the value without its unit. Example: `DesignCaseHeatFlowRate` on the FPQ-AKSO-P-XB-20030-01 equipment box now shows `5700.0 kW`, not `5700.0`.

- `src/proteusParser.js`: `normalizeDependantAttributeContents()`, used by `readTextTemplateReferences()`.

### Export file names

**PNG**, **PDF** and **DXF** are now named after the loaded Proteus XML file, with the new extension: `FPQ-AKSO-P-XB-20030-01.XML` saves as `FPQ-AKSO-P-XB-20030-01.png`, `.pdf` or `.dxf`. Before, they were named after the drawing number. The drawing number is still used as a fallback when no file name is known. The Validation tab's **CSV** uses the same rule and no longer saves as `name.XML.csv`.

- `src/App.jsx`: `exportFileBaseName()`.

### Validation tab header

The header row with the issue count badge and the engine text ("ProteusPIDSchema 4.1.1 disc.xsd + DEXPI 1.4 model/Profile (N objects)") is removed. The **CSV** button now sits next to **Expand all** / **Collapse all**. The total issue count is still shown on the tab label and the badges under **Run Validation**.

- `src/App.jsx`: Validation tab header; button row.

### Suggestion under each finding

Every finding now shows a blue **Suggestion:** line under its message, as in DEXPIViewer, in the Validation tab, the Issues tab, the Folder tab and the error explorer. The text is a one-line fix chosen by the finding's code, and by the message wording where one code covers several cases. Values from the message (the bad value, the class or attribute name) are used where they help. Codes with no rule show no line. The **Suggest…** dialog is unchanged.

- `src/suggestedCorrection.js` (new): `suggestedCorrectionFor(issue)`.
- `src/App.jsx`, `src/errorExplorer.jsx`: the Suggestion line.

### Validation badges

A badge row under **Run Validation** shows **All**, **Errors**, **Warn** and **Info** counts. The badges are the Validation tab's type filter: clicking one opens the tab filtered to that type, and the active one is outlined. The All / Error / Warning / Info chips at the top of the Validation tab are removed. The Folder tab and Error explorer keep their own chips.

Not ported from DEXPIViewer 2.5: *Hide elements with issues* (this viewer has no such feature) and the code descriptions in the group headers (this viewer already shows each code's title there).

### User Guide

`public/UserGuide.md`: version line; 2.3 *Running validation* (badges); 4.2 *Validation tab* (header removed, CSV next to Collapse all); 5.2 *Toolbar controls* (Fit, BG PNG, PNG / PDF / DXF and their file names, *Exporting the drawing*); 5.6 *Profile labels* (Mixed labels); 5.7 *Background image* (BG PNG, sliders button); `MDL-CMP-01` row. `public/UserGuide.html` regenerated with `scripts/build-guide.py`.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.9_to_2.10.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dxfExport.js` (new), `src/errorExplorer.jsx`, `src/suggestedCorrection.js` (new), `src/issueCodes.js`, `src/proteusParser.js`, `src/rdlValidate.js`.
