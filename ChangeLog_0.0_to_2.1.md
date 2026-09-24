# Changelog

## 2.1

Changes from the GitHub repository [ToniaPedersen/AKSODEXPIViewer](https://github.com/ToniaPedersen/AKSODEXPIViewer), commit `670624f` ("Added validation mechanism", 2026-09-17).

### Version

- The app is versioned as **2.1** (`package.json` / `package-lock.json` 2.1.0, previously 0.0.0).
- The version shows next to the title in the left panel and in the User Guide.

### Folder tab

- **Validate Folder…** moved from the top toolbar into the Folder tab and renamed **Validate…**.
- New **Save PNG…** button: renders every `.xml` in a folder and its subfolders and saves `<name>.png` next to each file.
  - Uses the drawing toolbar's current **Profile labels**, **Line Boost** and **Include symbol outlines** settings.
  - Fits the whole drawing, scales line weights to match the screen, leaves out any BG image, and ignores the BG blend setting.
  - Asks for write access to the folder. Browsers without folder write access download each PNG instead.
  - Progress with **Stop**, a summary of saved/failed files, and the previously open file is restored afterwards.
- New **Export Element…** button: downloads `<folder>-elements.xlsx` with three sheets.
  - **Classes**: File, Class, SuperType, Count, IsValid. A `Custom<X>` element with a `TypeURIAssignmentClass` is listed under the DiscProfile.xml class it maps to.
  - **Attributes**: File, Class, SuperType, Attribute, Count, IsValid, for the `DexpiAttributes` and `DexpiCustomAttributes` sets only.
  - **Symbols**: File, Symbol, Class, SuperType, Reference Type (Symbol / Label), Count, IsValid. For a label, Class is the class of the object the label belongs to. Valid when the `SymbolRegistrationNumber` is in the profile catalogue and its usage setting, if any, allows the using class. **N/A** for a file that doesn't claim DISC.
- The Folder tab's help text describes all three buttons and the extra write permission Save PNG… asks for.

### Validation rules

- **TypeNameAssignmentClass / TypeURIAssignmentClass**
  - Allowed only on CustomObject subtypes (the `Custom<X>` classes). On any other class they raise **PRF-SCP-02**.
  - For CustomObject subtypes, the type URI must match a DiscProfile.xml class (profile class extension), else **MDL-CLS-01**. That class's superType, followed through the profile's own classes, must match the `<X>` of `Custom<X>`, else **MDL-CLS-03**.
  - The type URI of a non-Custom element is no longer used anywhere (class mapping, abstract-class check, attribute scope, export).
  - Previously: a non-Custom element with a type URI was expected to use a `Custom<X>` wrapper, and an unresolved URI raised PRF-MAP-02.
- **Attribute names** (`DexpiAttributes` / `DexpiCustomAttributes` only; other sets are ignored)
  - Valid only when declared for the class they are used on, directly or through a supertype. That covers:
    - DEXPI 1.4 model properties of the ComponentClass and its ancestors.
    - DataProperties of the `Custom<X>` element's profile class and its profile superTypes.
    - DataProperties of any ClassExtension on those classes (Equipment ↔ ProcessEquipment counts as the same class).
  - In DEXPI 1.x files, profile references to enumerated lists (the TypeCode lists of ControlledActuator, InlineMeasuringElement, Motor, ProcessInstrumentationFunction and Turbine) are allowed as `<Name>AssignmentClass`, e.g. `TypeCodeAssignmentClass`. The value must be a list value's name or abbreviation, else **SER-VAL-04**. The bare name raises PRF-EXT-01.
  - A vendor `AttributeURI` no longer makes an attribute valid. It now raises **MDL-PRP-01**; before, it was an info note.
  - A profile property used on a class it isn't declared for raises **PRF-EXT-01**.
  - Previously, any profile DataProperty matching the AttributeURI was accepted on any class.
- **Vendor and marker classes**: no exceptions. A ComponentClass not in the DEXPI 1.4 model always raises **MDL-CLS-01**. `Orphan…` classes are no longer reported separately, and are caught by **PRF-SCP-01** in DISC files.
- **TransmissionSystem**: no longer exempt from the model class check. It is in the DEXPI 1.4 model and gets the same checks as every other class, plus its drive-train checks.
- **DEXPI 1.x property breaks**: in DEXPI 1.x files (ApplicationVersion 1.x, or none declared), `PropertyBreak` accepts `CompositionBreak`, `AreaBreak`, `HeatTracingBreak`, `InsulationBreak`, `NominalDiameterBreak`, `PipingClassBreak`, `ContractorBreak`, `CommissioningBreak`, `PipingInstrumentBreak`, `LineIDBreak`, `BreakValue1` and `BreakValue2`, by name (with or without the `AssignmentClass` / `Specialization` suffix) or by their NOAKA / sandbox AttributeURI. This applies to PRF-SCP-02 and to the attribute-name check (MDL-PRP-01/05, PRF-EXT-01). DiscProfile.xml models property breaks the DEXPI 2.0 way, which the Proteus schema cannot carry.
- **Symbols (PRF-SYM-01)**: a symbol is identified by its `SymbolRegistrationNumber` only. A `ComponentName` that equals a profile symbol name no longer counts, so an object without a registration number raises PRF-SYM-01. PRF-SYM-02 (usage class) already used the registration number only.
- **Symbol usage (PRF-SYM-02)**: a ComponentClass that matches the symbol's usage class by name only counts if it is a DEXPI 1.4 class. A profile-only class written directly as the ComponentClass (e.g. `ThreadedPipeCap` on symbol ND0157) now fails. It has to be a `Custom<X>` whose TypeURIAssignmentClass resolves to the profile class.
- **DISC detection**: a file counts as a DISC file only when at least one `SymbolRegistrationNumber` is a DISC symbol in the loaded profile's catalogue. With no profile loaded, no file is treated as a DISC file. Previously a file also counted when it had any `SymbolRegistrationNumber` at all (e.g. ISO 10628 numbers), a `ComponentName` matching a profile symbol or `ND####`, or a NOAKA/DISC URI. So the plain DEXPI sample `C01V04-VER.EX01.xml` was being checked against the DISC-scoped codes.

### Issue code register (`issueCodes.js`)

| Code | Change |
|---|---|
| MDL-CLS-05 "Vendor marker class emitted" | Removed |
| PRF-EXT-01 "Extension property used off its baseType" | Now implemented |
| PRF-MAP-02 "RDL URI does not resolve against the profile" | Marked not implemented (replaced by MDL-CLS-01) |
| PRF-SCP-02 "Property outside the DISC AllowedProperties list" | Severity Warning → Error |

### Model data (`dexpi14Rdl.json`)

- Checked against `DEXPI P&ID Specification.xmi`: all 418 classes, 810 properties and 49 enumerations match.
- 75 properties that the XMI declares without a lower bound (UML default 1, i.e. required) had `lower: 0`. They now have `lower: 1`. The validator does not use `lower`, so results are unchanged.

### XSD validation (`xsdValidate.js`)

- The in-browser validator (xmllint-wasm) was limited to 32 MiB of memory, so large files failed with a bare libxml2 line/caret message (exit code 9, out of memory). Example: `FPQ-AKSO-P-XB-13003-01.XML`, 11 MB.
- The limit is now sized from the file (16 MiB + 8× its size after vendor attribute groups are removed, up to 512 MiB), and a file that still runs out is retried once at 512 MiB.
- If it still runs out, the message says so plainly instead of showing raw libxml2 output.

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html` cover the new Folder tab buttons, the type-assignment and attribute rules, the DEXPI 1.x property-break exception and the register changes above.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_0.0_to_2.1.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/folderValidate.js`, `src/rdlValidate.js`, `src/profileRules.js`, `src/issueCodes.js`, `src/xsdValidate.js`, `src/dexpi14Rdl.json`.
