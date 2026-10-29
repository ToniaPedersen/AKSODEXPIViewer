# Changelog

## 2.8.2

Changes from version 2.8.1 (commit `9ee1d03` "version 2.8.1", 2026-10-22).

### Version

- The app is versioned as **2.8.2** (`package.json` / `package-lock.json` 2.8.2, `README.md`, User Guide).

### Linked text only - the Text `String` is never drawn

The drawings are imported into an intelligent CAD tool that rebuilds every label from the attribute database. The viewer therefore draws only text that tool can rebuild: a **link**, never a cached string. This is the same rule as DEXPIViewer 2.2.1, applied to Proteus.

A `<Label>`'s `<Text>` is drawn only from its `TextStringFormatSpecification` / `ObjectAttributesReference` links (`DependantAttribute` + `ItemID`). The `<Text String="...">` value is never drawn.

| Case | 2.8.1 | 2.8.2 |
|---|---|---|
| No profile loaded, `<Text>` with valid references | stored `String` shown | resolved references shown |
| No profile loaded, `<Text>` without references, or whose references do not resolve | stored `String` shown | not drawn |
| Profile loaded, `<Text>` with references valid for the placed profile symbol | resolved references | unchanged |
| Profile loaded, `<Text>` with an empty or missing `String` but valid references | not drawn | resolved references shown |
| Profile loaded, `<Text>` without valid references | not drawn | unchanged |
| Symbol catalogue text and `lbltpl_` LabelTemplate overlays | drawn | unchanged |

Implementation:

- `src/proteusParser.js` (`buildProteusGraphics()`): `resolveTextTemplateValue()` now runs with or without a profile. Without one, the new `ANY_LABEL_ATTRIBUTE` set accepts any attribute that resolves on its `ItemID` target. A `<Text>` whose resolution is `null` is not drawn. Every drawn instance `<Text>` has `hasOwnValidatedTemplate = true`. An empty `String` no longer skips the `<Text>`.
- `src/App.jsx`: `renderPrimitive()` draws `resolvedTemplateValue` for every instance `<Text>`. The literal `value` is used only for symbol catalogue primitives and `lbltpl_` overlays. The unreachable `isDiscProfileLabel` / `validRawProfileText` branches are removed.

Visible effect on FPQ-AKSO-P-XB-20030-01: every drawn label shows its live linked value. Values can differ from the exported strings, e.g. full vacuum as `FV` instead of `-1.0`, a Note reference as `11.` instead of `NOTE 11`, and without a profile `91` instead of `91.0`.

### User Guide

- `public/UserGuide.md`: version 2.8.2; section 5.6 *Profile labels* gains the *Linked text only* rule and describes the Unchecked state (the file's own `<Label>` texts, built from their links); Checked now reads "in addition" to that.
- `public/UserGuide.html`: rebuilt with `scripts/build-guide.py`.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.7_to_2.8.md`, `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/proteusParser.js`.

## 2.8.1

Commit `9ee1d03` "version 2.8.1" (2026-10-22) added these sections, described under 2.8 below: *Label symbols with their own LabelTemplate*, *MDL-PRP-02: PhysicalQuantity attributes (error)* and *BG image with the XML*.

## 2.8

Changes from version 2.7 (see `ChangeLog_2.6_to_2.7.md`). This work was started on 2.4 (commit `75c766f`) in parallel with 2.5-2.7 and merged on top of 2.7.

### Version

- The app is versioned as **2.8** (`package.json` / `package-lock.json` 2.8.0, `README.md`, User Guide).

### Profile labels - rule 'B' for rotation and mirroring

The **Profile labels** overlay (LabelTemplates of the placed profile symbol) is now placed by DISC DEXPI rule **'B'** (requirements document, ANNEX B *Profile Label Text under Rotation and Mirroring*), for every symbol, the same as DEXPIViewer 2.2 and `Update-DexpiLabels.ps1`:

- the template's **y offset** (above / below) follows the symbol's full rotation: a label above the symbol at 0° is below its origin at 180°;
- the template's **x offset** (left / right) follows the readable text direction: mirrored with the symbol and flipped when the text had to be turned over (rotation 90° and 180°): a label left of the symbol at 0° is still left of it at 180° and below it at 90°;
- text reads left to right at 0°/180° and bottom to top at 90°/270°;
- Left/Right swap for a mirrored symbol and Top/Bottom swap when the text is turned over, so the text grows away from the symbol. In 2.4 the overlay anchor was rotated with the symbol (`readableLabelOrientation()`) and Left/Right was not swapped for a mirrored symbol.

New `profileLabelPlacement(lt, pos, scale, stacked)` in `src/proteusParser.js` returns the anchor, the readable rotation and the alignment. Verified against the 32 cases of the ANNEX B tables. Character-stacked templates (`<NonSasFunction>`) still ignore their own Rotation and draw one upright character per line. `<Label>` texts stored in the file keep their stored position and orientation.

### Equipment boxes (DiscProfile 0.6.6, ND0300-ND0310)

- **Values from the Chambers.** A LabelTemplate token that the equipment does not carry is read from its Chambers: the nested `<Equipment ComponentClass="Chamber">` children (`chamberElementsOf()`).
- **Hot / cold side by ChamberFunction.** When a template is repeated in the same symbol variant (ND0309B heat exchanger: the design pressure and temperature lines for each side), the 1st occurrence reads the Chamber whose `ChamberFunction` (or `ChamberFunctionSpecialization`, by name or RDL URI) is **Cooling** (hot side), the 2nd the one with **Heating** (cold side), via `chamberForSide()`. Without the expected function the Nth Chamber is used. A repeated template reads only its own side's Chamber, blank rather than another side's value.
- **1 decimal.** In the value columns (`ND0300B`...`ND0310B`) numbers are shown with exactly 1 decimal, rounded half away from zero on the decimal value (`130` → `130.0`, `56.55` → `56.6`). This applies to the Profile labels overlay and to the box's own `<Label>` texts (`resolveTextTemplateValue()` / `gaDisplayValue()` for numeric GenericAttribute Formats). Text values (e.g. a material code `1.4306`) are never rounded.
- **'&' and '/' shown.** LabelTemplate texts are unwrapped like in DEXPIViewer (`unwrapLabelFormula()`): only quoted text is a VB-style formula (`'SP = ' & <SetPoint>`, `'HH=' & SignalConveyingFunction:<AlarmValue>`). `<A> & <B> / <C>` has no quotes, so its `&` and `/` are shown between the values: `FV & 130.0 / 90.0`.

### Units and full vacuum

- A numeric GenericAttribute with `Units` is carried as a PhysicalQuantity, so the Details panel and labels show its unit. Core.xml unit literals are shown with their symbol from the new `src/unitSymbols.js` (the same table as DEXPIViewer), e.g. a gauge `Bar` → `barg`, an absolute `Bar` → `bar`, `DegreeCelsius` → `°C`. Free-text units (`barg`, `kg/h`) are shown as written.
- Set point and alarm labels (`SetPoint`, `AlarmValue`) always show the value with its unit symbol (`SP = 6 barg`, `HH=272 barg`). Alarm labels are still taken from the SignalConveyingFunction with the matching PortStatusSpecialization (2.7); their unit is now shown as a symbol with a space (2.7: `HH=272Bar`). An alarm pressure unit with no gauge/absolute Type or TypeURI is taken as gauge (`Bar` → `barg`).
- A pressure at full vacuum is shown as `FV`: a gauge pressure of -1 atm (-1.01325 barg and the usual rounded -1.0 / -1.013 barg, within 1.5 %, in bar, mbar, kPa, MPa, Pa or psi) or an absolute pressure of 0.
- Gauge or absolute is taken from the GenericAttribute's `Type` (`PressureGaugeUnit` / `PressureAbsoluteUnit`) or `TypeURI` (`RDS7345161` = gauge), else from the loaded DiscProfile.xml DataProperty's `Core/PhysicalQuantities.Pressure*Unit` type (by `rdl_uri` or name, `buildProfilePressureUnitTypes()`), else from the DEXPI 1.4 model (`NullablePressureGauge` / `NullablePressureAbsolute` in `dexpi14Rdl.json`). When none says, the attribute name (`...Pressure...`) and unit text decide.

### Label symbols with their own LabelTemplate

- A nested `<Label>` that places its own profile symbol (e.g. `ND0048` special item label, LabelTemplate `<SpecialItemNumber>`) has its `<Text>` reference checked against that symbol's LabelTemplate attributes, not the owner's symbol. A Text referencing an attribute the label symbol does not define (`ObjectDisplayName` on `SpecialItemLabel-*`) is no longer drawn; the label shows the owner's `SpecialItemNumber`, or nothing when the owner has none.

### MDL-PRP-02: PhysicalQuantity attributes (error)

- MDL-PRP-02 is now implemented. An attribute whose definition is a physical quantity (a DiscProfile.xml DataProperty of type `Core/PhysicalQuantities.*`, e.g. `SetPoint`, or a DEXPI 1.4 `Nullable<Quantity>` property) must be `Format="double"` with a numeric `Value`, `Units`, and a `Type` naming the unit type (`PressureGaugeUnit`, `PressureAbsoluteUnit`, ...) or a `TypeURI`. Anything else is an error. An empty Value is not checked.
- Suggest… shows the corrected line, splitting a value such as `303barg` into `Value="303" Units="barg"` and choosing `Type` (e.g. `PressureGaugeUnit`) from the unit.

### User Guide

- `public/UserGuide.md`: version 2.8; section 5.6 *Profile labels* gets the units / `FV` paragraph and the new subsections *Rotation and mirroring* (rule 'B') and *Equipment boxes*.
- `public/UserGuide.html` regenerated with `scripts/build-guide.py`.

### BG image with the XML

- **Load Proteus XML** accepts the XML and a .png picked together; the .png is loaded as the BG image (the same-named one when several are picked) and the BG Controls bar is shown. Where the browser has a file picker API the PNG's file handle is kept, so Save placement writes back into it.
- **Open** on the Folder tab (and in the error explorer) loads the matching .png from the same folder: `<name>.png`, else the name with its further dotted parts removed (`a.enhanced.xml.Dexpi_2.0.xml` → `a.enhanced.xml.Dexpi_2.0.png`, …, `a.png`).

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.7_to_2.8.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/proteusParser.js`, `src/rdlValidate.js`, `src/issueCodes.js`, `src/suggestPrompt.js`, `src/unitSymbols.js` (new).
