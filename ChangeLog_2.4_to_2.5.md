# Changelog

## 2.5

Changes from version 2.4 (commit `75c766f`, 2026-10-02, see `ChangeLog_2.3_to_2.4.md`).

### Version

- The app is versioned as **2.5** (`package.json` / `package-lock.json` 2.5.0, `README.md`, User Guide).

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
- Set point and alarm labels (`SetPoint`, `AlarmValue`) always show the value with its unit (`SP = 6 barg`).
- A pressure at full vacuum is shown as `FV`: a gauge pressure of -1 atm (-1.01325 barg and the usual rounded -1.0 / -1.013 barg, within 1.5 %, in bar, mbar, kPa, MPa, Pa or psi) or an absolute pressure of 0.
- Gauge or absolute is taken from the GenericAttribute's `Type` (`PressureGaugeUnit` / `PressureAbsoluteUnit`) or `TypeURI` (`RDS7345161` = gauge), else from the loaded DiscProfile.xml DataProperty's `Core/PhysicalQuantities.Pressure*Unit` type (by `rdl_uri` or name, `buildProfilePressureUnitTypes()`), else from the DEXPI 1.4 model (`NullablePressureGauge` / `NullablePressureAbsolute` in `dexpi14Rdl.json`). When none says, the attribute name (`...Pressure...`) and unit text decide.

### User Guide

- `public/UserGuide.md`: version 2.5; section 5.6 *Profile labels* gets the units / `FV` paragraph and the new subsections *Rotation and mirroring* (rule 'B') and *Equipment boxes*.
- `public/UserGuide.html` regenerated with `scripts/build-guide.py`. This also brings in the section 2.2 *default profile* paragraph that was already in the Markdown.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.4_to_2.5.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/proteusParser.js`, `src/unitSymbols.js` (new).
