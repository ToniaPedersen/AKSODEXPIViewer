# Changelog

## 2.3

Changes from version 2.2 (see `ChangeLog_2.1_to_2.2.md`).

### Version

- The app is versioned as **2.3** (`package.json` / `package-lock.json` 2.3.0).

### Validation rules

- **MDL-CLS-05 "ComponentClass or ComponentClassURI missing"** (new, Error). Every element whose Proteus 4.1.1 schema type allows `ComponentClass` / `ComponentClassURI` must have both, whether or not it has an `ID`. Not checked: ShapeCatalogue content, and `Symbol` subtypes (`InsulationSymbol`, `PipeFlowArrow`, `PipeSlopeSymbol`, `CustomSymbol`) by `ComponentClass`, or by element name when it has none. Previously an element without a `ComponentClass` was skipped by every model check.
  - An `InformationFlow` with no `ComponentClass` is now reported under MDL-CLS-05 instead of MDL-CLS-01.
- **SER-REQ-01 "Required attribute missing"** now also reports a `CenterLine` with no `ID`: every element whose schema type allows an `ID` must have one. `CenterLine` is the only such element where the schema makes `ID` optional; a missing required `ID` is already reported by the XSD check.

- **MDL-MUL-03 "Opposite multiplicity exceeded"** (new check, Error). An `Association` is one end of a model reference; the objects linked to a holder through the forward type, its inverse type on the linked object, or XML nesting (whole-part) are counted against the upper multiplicity of the reference property the holder's class declares (`Chamber`, `SensingLocation`, `ActuatingLocation`, `ActuatingElectricalLocation`, `PlantArea`, `PlantSystem`, `PlantTrain`, `ParentStructure`, `Systems`, `ReferencedConnector`, `ConnectorReference`, `Driver`, `DrivingTransmissionSystem`, `Source`, `Target`). Reported on the holder, listing the linked objects and how each is linked.

### Issue code register (`issueCodes.js`)

| Code | Change |
|---|---|
| MDL-CLS-05 "ComponentClass or ComponentClassURI missing" | New, implemented, Error, category Class usage |
| MDL-MUL-03 "Opposite multiplicity exceeded" | Implemented, Error, category Multiplicity |

82 codes are registered; 44 are implemented.

### Background image

- Opening a DEXPI file removes the previous background image, including one loaded with **BG Image**, and loads the `.png` with the same name, if there is one. The BG Controls bar opens and Blend is set to 0.35 (image at 65% opacity).
  - From the Folder tab (Open / Explorer) the `.png` is taken from the picked folder and its subfolders.
  - With **Load Proteus XML**, pick the `.xml` and its `.png` together (the picker now allows several files).
- A PNG's embedded placement, if any, is still applied. An image loaded with **BG Image** still starts at Blend 0.

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html`: version 2.3, the MDL-CLS-05 and MDL-MUL-03 rows, the per-check detail paragraphs (SER-IDN-03, MDL-CYC-01, GEO-ALN-01, GEO-MDL-01) moved out of section 8 into a separate, unpublished notes file, the implemented-code count, and the automatic background image (2.2 Loading files, 5.7 Background image).

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.2_to_2.3.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/folderValidate.js`, `src/rdlValidate.js`, `src/issueCodes.js`.
