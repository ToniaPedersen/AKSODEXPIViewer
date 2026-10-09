# Changelog

## 2.5

Changes from version 2.4 (see `ChangeLog_2.3_to_2.4.md`).

### Version

- The app is versioned as **2.5** (`package.json` / `package-lock.json` 2.5.0).

### MDL-REF-07 - source/target references (new check)

New **Warning**, needs model, all files: "Source/target reference missing, repeated, unresolved or of the wrong class". Each reference below is 0..1 in the DEXPI model, so every finding is a warning.

| Owner | Property | Carried in the Proteus XML as | Value class |
|---|---|---|---|
| SignalConveyingFunction (`InformationFlow`) | Source | `<Association Type="has logical start">` | (checked by MDL-REF-03/04) |
| SignalConveyingFunction (`InformationFlow`) | Target | `<Association Type="has logical end">` | (checked by MDL-REF-03/04) |
| ProcessSignalGeneratingFunction | SensingLocation | `<Association Type="is located in">` | SensingLocation |
| ActuatingFunction | Systems | `<Association Type="is fulfilled by">` | ActuatingSystem |
| ActuatingElectricalFunction | ActuatingElectricalLocation | `<Association Type="is located in">` | ActuatingElectricalLocation |
| PipingNetworkSegment | SourceItem | `<Connection FromID>` | PipingSourceItem (or another PipingNetworkSegment) |
| PipingNetworkSegment | TargetItem | `<Connection ToID>` | PipingTargetItem (or another PipingNetworkSegment) |

- Findings: **missing** (no reference), **multiple** (more than one), **unresolved** (the ID matches no object in the file), **class** (the referenced object's ComponentClass does not descend from the value class).
- SignalConveyingFunction Source/Target get only missing/multiple; unresolved and wrong class are already MDL-REF-04 / MDL-REF-03.
- Not checked: Systems on ProcessSignalGeneratingFunction and ActuatingElectricalFunction (not used in these files), and off-page connectors.
- Not checked: **ActuatingFunction.ActuatingLocation** - the location is always the ControlledActuator, covered by GEO-MDL-01 (the check was first included, then removed).
- A SignalConveyingFunction with **PortStatus** set (GenericAttribute with AttributeURI `http://sandbox.dexpi.org/rdl/PortStatusSpecialization`, a non-empty value other than `NULL`) never has a Target, so no "has no Target reference" finding is raised for it.
- A referenced object with an unknown or missing ComponentClass is left to MDL-CLS-01 / MDL-CLS-05.
- `rdlValidate.js`: `MODEL_ASSOCIATION_REFERENCES`, `SEGMENT_CONNECTION_REFERENCES`; summary counters `modelReferencesChecked` / `modelReferenceIssues`.

### Suggest… (help on a finding for Copilot)

- Every finding now has a **Suggest…** button - in the Validation tab, the Folder tab results, the other finding list in `App.jsx`, and on the line rows of the error explorer.
- It opens a **Suggest a fix** dialog (`src/suggestDialog.jsx`) with a ready-made, editable question about the finding: code, title, category, type, message, object, file and line, the element's XML (up to 60 lines, or ±5 lines around the reported line), and a summary of the DEXPI 1.4 model class (supertypes and up to 40 properties with multiplicity), plus a short note on the Proteus conventions (GenericAttributes, Associations, Connections, nested components).
- **Suggested fix for MDL-REF-07 "has no … reference"**: when the missing reference can be derived from the file, the text shows the corrected XML instead of the generic instruction - the element with the `<Association>` added, the matching reverse association on the other object if it is missing too, and why that object was chosen:
  - Source, Target, Systems, SensingLocation, ActuatingElectricalLocation: from the single object that already carries the reverse association (`is logical start of`, `is logical end of`, `fulfills`, `is the location of`).
- Buttons: **Copy & open Copilot** (copies and opens https://m365.cloud.microsoft/chat), **Copy**, **Close** (or Esc). Nothing is sent from the app; there is no login or AI integration.
- New `src/suggestPrompt.js` (`buildSuggestPrompt()`); folder-run findings read the file text from the picked folder when the button is pressed.

### Suggest… - red/green view of the fix

- The **Suggest a fix** dialog now shows the finding visually instead of only the Copilot text:
  - **In the file**: the element with line numbers; the lines the finding is about are red, unrelated stretches are folded. Lines in tool-specific GenericAttributes sets (ComosProperties, XMpLant ...) and in nested child objects are not marked.
  - **Suggested fix / Expected syntax**: a diff - red "-" remove/replace, green "+" add - with notes. Filled in from the file where possible: MDL-REF-07 (missing reverse-carried reference; segment Connection syntax with the object at the first/last CenterLine coordinate), GEO-ALN-01 (split a CenterLine under an inline item, bridge a gap of up to 10 mm, or what to move), SER-STR-01 (where the element belongs - nearest segment of the system, or the instrument holding the signal line; PipeFlowArrow in a signal line -> Symbol), MDL-CLS-05, MDL-CLS-02, PRF-EXT-04, SER-FMT-04, PRF-TRN-05, GEO-GRD-01/02, MDL-PRP-05 / PRF-SCP-02 (symbol registration to the ShapeCatalogue), SER-IDN-03, GEO-MDL-01, PRF-LBL-02, MDL-REF-03. Notes only for MDL-MUL-03, MDL-REF-05, GEO-NCT-01, MDL-CMP-03, PRF-SYM-01/02, MDL-CLS-01, PRF-SCP-01, SER-VAL-04.
  - **Question for Copilot** is folded; it now includes the marked XML (`>>`), the suggested change as a `diff` block and the reference sources (DEXPI 1.4 XMI, DiscProfile.xml, Proteus 4.1.1 schema, ProteusXML repository).
- Schema findings: the element named in the message is looked up within a few lines of the reported line, because libxml2 line numbers can be off by one in files over 65 535 lines.
- Line numbers in the dialog count CRLF, CR and LF as one line break, as the finding lines do.
- `src/suggestPrompt.js`: new `buildSuggestion()` (returns text, current lines, fix rows, script); `buildSuggestPrompt()` kept and returns the text. `src/suggestDialog.jsx` and `src/App.jsx` updated.

### BG image from the same-named .png

- Opening a DEXPI file first removes the current BG image, then loads the `.png` with the same name as the BG image (65% BG opacity, BG Controls shown).
- **Load Proteus XML**: the `.png` is taken from the files picked with the XML or, when none is picked, from the last folder granted to **Validate Folder…** (one `.png` with that base name). The browser cannot read a file next to a single picked file, so outside a granted folder the `.png` still has to be picked with the XML. Picking the same file again now reloads it.
- **Validate Folder…**: the folder's `.png` files are kept as soon as access is granted, including when the run is cancelled at the "No DiscProfile.xml" prompt or the folder has no `.xml`; opening a file from the Folder tab or the error explorer loads its `.png`.
- A BG image still loading from the previous file can no longer appear over the new one.

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html`: version 2.5; MDL-REF-07 row in section 8; implemented count 46 of 83.
- New **4.5 Suggest… — help on a finding**: what the text contains, the MDL-REF-07 suggested fix and how the referenced object is found, and the dialog's buttons; the Suggest… button added to 4.2 Validation tab, 4.3 Folder tab and 4.4 Error explorer.
- 2.2 Loading files and 5.7 Background image: picking the `.xml` and `.png` together in **Load Proteus XML**, the fallback to the last validated folder, the old BG image removed first, and where the `.png` is found for each way of opening a file.
- 4.3 Folder tab: the folder permission also covers the `.png` files, kept as soon as access is granted.
- 10 Troubleshooting: new entry "Background image does not load with the file"

### Issue code register (`issueCodes.js`)

| Code | Change |
|---|---|
| MDL-REF-07 "Source/target reference missing, repeated, unresolved or of the wrong class" | New, implemented, Warning, needs model, all files |

46 of the 83 registered codes are implemented.

### Dependencies

- `package-lock.json`: `dompurify` 3.4.15 → 3.4.16, `source-map-js` 1.2.1 → 1.2.2.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.4_to_2.5.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/errorExplorer.jsx`, `src/issueCodes.js`, `src/rdlValidate.js`, `src/suggestDialog.jsx` (new), `src/suggestPrompt.js` (new).
