# Changelog

## 2.0

Changes from the GitHub repository [ToniaPedersen/AKSODEXPIViewer](https://github.com/ToniaPedersen/AKSODEXPIViewer), commit `670624f` ("Added validation mechanism", 2026-09-17).

### Version

- The app is versioned as **2.0** (`package.json` / `package-lock.json` 2.0.0, previously 0.0.0).
- The version shows next to the title in the left panel and in the User Guide.

### Folder tab

- **Validate Folder…** moved from the top toolbar into the Folder tab and renamed **Validate…**.
- New **Save PNG…** button: renders every `.xml` in a folder and its subfolders and saves `<name>.png` next to each file.
  - Uses the drawing toolbar's current **Profile labels**, **Line Boost** and **Include symbol outlines** settings.
  - Fits the whole drawing, scales line weights to match the screen, leaves out any BG image, and ignores the BG blend setting.
  - Asks for write access to the folder. Browsers without folder write access download each PNG instead.
  - Progress with **Stop**, a summary of saved/failed files, and the previously open file is restored afterwards.
- New **Export Element…** button: downloads `<folder>-elements.xlsx` with two sheets.
  - **Classes**: File, Class, SuperType, Count, IsValid. A `Custom<X>` element with a `TypeURIAssignmentClass` is listed under the DiscProfile.xml class it maps to.
  - **Attributes**: File, Class, SuperType, Attribute, Count, IsValid, for the `DexpiAttributes` and `DexpiCustomAttributes` sets only.
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
  - A vendor `AttributeURI` no longer makes an attribute valid. It now raises **MDL-PRP-01**; before, it was an info note.
  - A profile property used on a class it isn't declared for raises **PRF-EXT-01**.
  - Previously, any profile DataProperty matching the AttributeURI was accepted on any class.
- **Vendor and marker classes**: no exceptions. A ComponentClass not in the DEXPI 1.4 model always raises **MDL-CLS-01**. `Orphan…` classes are no longer reported separately, and are caught by **PRF-SCP-01** in DISC files.
- **TransmissionSystem**: no longer exempt from the model class check. It is in the DEXPI 1.4 model and gets the same checks as every other class, plus its drive-train checks.
- **DEXPI 1.x property breaks**: in DEXPI 1.x files (ApplicationVersion 1.x, or none declared), PRF-SCP-02 accepts `CompositionBreak`, `InsulationBreak`, `NominalDiameterBreak` and `PipingClassBreak` on `PropertyBreak`. DiscProfile.xml models property breaks the DEXPI 2.0 way, which the Proteus schema cannot carry.

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

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html` cover the new Folder tab buttons, the type-assignment and attribute rules, the DEXPI 1.x property-break exception and the register changes above.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_0.0_to_2.0.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/folderValidate.js`, `src/rdlValidate.js`, `src/profileRules.js`, `src/issueCodes.js`, `src/dexpi14Rdl.json`.
