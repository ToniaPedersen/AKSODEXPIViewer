# Changelog

## 2.4

Changes from version 2.3 (see `ChangeLog_2.2_to_2.3.md`).

### Version

- The app is versioned as **2.4** (`package.json` / `package-lock.json` 2.4.0).

### Attribute validation by rdl_uri

An attribute in the `DexpiAttributes` / `DexpiCustomAttributes` sets is now matched to the DEXPI model and the DiscProfile.xml extension by its `AttributeURI` only: it is valid when that URI is the `MetaData/rdl_uri` of a property declared for the element's class, directly or through a supertype. The `rdl_uri` is the only link. The attribute `Name` is no longer matched, and an attribute with no `AttributeURI` is not valid.

- **DEXPI 1.4 model side.** New `src/dexpiRdlUris.json`: the `rdl_uri` of every DEXPI 1.4 class (295) and data attribute (573), keyed by the names in `dexpi14Rdl.json`. Built by the new `scripts/build-rdl-uris.py` from the DEXPI 2.0 model files the DISC profile imports (`Plant.xml`, `Process.xml`, `Core.xml` in `DISCDEXPI_2026Pack/Profile/xml`), whose `rdl_uri` values are the ones the DEXPI 1.4 specification lists, plus `scripts/dexpi14-rdl-overrides.json` for what only the 1.4 specification carries (the `Custom<X>` attributes, the `MetaData` plant-structure attributes, `NominalCapacity(Volume)`, `TypeName` / `TypeURI`, the `ColumnSection` and `Pipe` class URIs). Only graphics and `DexpiModel` / `CustomAttribute` metadata properties have no `rdl_uri`; none of those occur in the DEXPI attribute sets.
- **Profile side.** The DataProperty `rdl_uri`s of the TypeURIAssignmentClass profile class, its profile superType chain and every ClassExtension on the classes in scope, as before. The DataProperty names are no longer indexed.
- **Checks affected** (`rdlValidate.js`): MDL-PRP-01 / MDL-PRP-05 / PRF-EXT-01 (unknown attribute), SER-VAL-04 (enum literal) and MDL-MUL-01 (cardinality) now resolve the model property through the `AttributeURI`; MDL-MUL-01 counts occurrences per `rdl_uri` and names the property as `Class.Property (rdl_uri)`. Messages name the URI that failed:
  - no `AttributeURI`: `Attribute "X" has no AttributeURI. An attribute is matched ... by its AttributeURI (the property's rdl_uri) only.`
  - a profile `rdl_uri` out of scope (PRF-EXT-01): `AttributeURI <uri> of "X" is a DiscProfile.xml property rdl_uri, but not one declared for <class> ...`
  - anything else: `AttributeURI <uri> of "X" is not the rdl_uri of a property declared for <class> or its supertypes ...`
- **DEXPI 1.x PropertyBreak attributes** (`profileRules.js`): accepted on `PropertyBreak` by `AttributeURI` only; `CompositionBreak` now has its URI (`http://sandbox.dexpi.org/rdl/CompositionBreakSpecialization`).
- **Unchanged:** `TypeNameAssignmentClass` / `TypeURIAssignmentClass` (CustomObject subtypes only), SER-VAL-01 (malformed name), and the DEXPI 1.x `<Name>AssignmentClass` reference to a DiscProfile.xml list (`TypeCodeAssignmentClass` etc.), which is still matched by name because the profile's ReferenceProperties carry no `rdl_uri`. PRF-SCP-02 (the profile's AllowedProperties list) is a name list and is unchanged.
- On the two sample files in the repo the findings are the same as in 2.3 (every attribute that matched by name also matches by `rdl_uri`); files whose attributes carry a wrong or missing `AttributeURI` now fail where they passed before.

### Class resolution by rdl_uri, PRF-EXT-04

- `ComponentClassURI` is now resolved like an AttributeURI: among the DEXPI 1.4 model class `rdl_uri`s (`dexpiRdlUris.json`), then the DiscProfile.xml classes. When it resolves to a model class, that class is the one every model check runs against (`validateAgainstRdl()` main loop, the DISC-scope element list, `collectElementUsage()` / Export Element…); `ComponentClass` is used only when the URI is missing or resolves to nothing. `Custom<X>` typing through `TypeURIAssignmentClass` is unchanged.
- **PRF-EXT-04** (implemented, Warning, all files, title now "ComponentClassURI disagrees with the class it claims"): reported when `ComponentClass` differs from the class the URI resolves to (model or profile; the 1.4/2.0 renames `Equipment`/`ProcessEquipment`, `DexpiModel`/`PlantModel` count as the same class), and when the URI resolves to nothing while the model has an `rdl_uri` for the `ComponentClass`. A missing URI stays MDL-CLS-05. Export Element… Classes IsValid is **No** on a PRF-EXT-04 element.
- `rdlValidate.js`: `MODEL_CLASS_BY_URI`, `resolveClassByUri()`, `effectiveComponentClass()`, `describeClassUriDisagreement()`; summary counter `classUriDisagreements`.

### PRF-SCP-02 is class-qualified

- The profile's `AllowedProperties` entries are `<Package>.<Class>.<Property>`. PRF-SCP-02 used to accept an attribute when its bare name appeared anywhere in the list, whatever class the entry named (`LockMechanism` on a Pump passed). It now passes only when an entry names the property on the element's class, one of its supertypes (DEXPI 1.4 names and their 2.0 renames), its TypeURIAssignmentClass profile class and that class's superTypes, or a ClassExtension on one of those (`CheckValveExtension.LockMechanism` applies to a CheckValve). The property is identified through the AttributeURI (`rdl_uri`) resolved in that scope; a DEXPI 1.x `<Name>AssignmentClass` list reference by its bare name; an unresolvable attribute by its bare name as a last resort.
- Message: `Property "X" (<uri>) is not in the DISC profile's AllowedProperties list for <class>, its supertypes, its profile class or their ClassExtensions.` Title in `issueCodes.js`: "Property outside the DISC AllowedProperties list for its class".
- Side effect: `<Name>Specialization` attributes (`FailActionSpecialization`, `SlopeSpecialization`, `HeatTracingTypeSpecialization`, `PortStatusSpecialization`) were reported before because the suffix was not stripped for the list lookup; resolved through the `rdl_uri` they now pass. An element whose class or type URI is unknown now has its attributes reported (no class to qualify against).
- `buildProfileFacts()` adds `allowedClassProperties` (`<Class>.<Property>`, the last two segments of each entry); `checkDiscScope()` takes an `isAllowedProperty` resolver from `rdlValidate.js` (`makeAllowedPropertyCheck()`).

### SER-VAL-04 on list references

- A DEXPI 1.x `<Name>AssignmentClass` list reference (e.g. `TypeCodeAssignmentClass`) may have an empty value. SER-VAL-04 is raised, and Export Element… IsValid is **No**, only when the value is non-empty and not one of the list's values (name or abbreviation).

### Thermowell on CustomInlineMeasuringElement

- A `CustomInlineMeasuringElement` whose `TypeURIAssignmentClass` is the profile's Thermowell (`http://data.posccaesar.org/rdl/RDS418049`) is accepted, although Thermowell's profile superType is `Plant/Piping.Sensorwell` (which would otherwise require `CustomPipingComponent`, MDL-CLS-03). The pair is listed in `TYPE_URI_WRAPPER_EXCEPTIONS` in `rdlValidate.js`; it applies to MDL-CLS-03 and to IsValid on the Export Element… Classes sheet.
- The allowed attributes of such an element are those of `InlineMeasuringElement` (its DEXPI 1.4 model properties and supertypes, and the ClassExtensions on them, e.g. `InlineMeasuringElementExtension`), not Thermowell's profile chain (`Sensorwell`). This applies to MDL-PRP-01/05, PRF-EXT-01, PRF-SCP-02, SER-VAL-04, MDL-MUL-01 and Export Element… IsValid. `TypeNameAssignmentClass` / `TypeURIAssignmentClass` remain allowed as on any CustomObject subtype.

### CenterLine ID

- A `CenterLine` with no `ID` is no longer reported (2.3 added it to SER-REQ-01). `ID` is optional on `CenterLine` in the Proteus 4.1.1 schema; a missing required `ID` on any other element is still the XSD engine's SER-REQ-01.

### MDL-CMP-03 severity

- MDL-CMP-03 "Required sub-component missing" defaults to **Warning** (was Error). A finding is an Error only when the DEXPI 1.4 model requires the sub-component (reference property lower multiplicity ≥ 1): `rdlValidate.js` sets `severityOverride: "error"` on it, and the viewer's lists and the CSV/Excel reports honour `severityOverride` over the code's (configured) severity. `PipingNodeOwner.Nodes` is 0..* and `TransmissionSystem.Driver` 0..1, and "drives" has no model property, so today every MDL-CMP-03 is a Warning.

### Finding line numbers in CRLF files

- `lineResolve.js` counted one character per line end, so in a CRLF file the reported line drifted by one line per line of file (an InformationFlow at line 15038 was reported at 15243). Line starts are now taken from the actual line ends; LF files are unchanged.

### Export Element…

- **Classes** sheet: new column **D "Class RDL"** between SuperType and Count - the class `rdl_uri` (the DiscProfile.xml class's for a mapped `Custom<X>`, otherwise the DEXPI 1.4 model's, falling back to the file's `ComponentClassURI`). Rows are now also split by it.
- **Attributes** sheet: new column **E "Attribute RDL"** between Attribute and Count - the attribute's `AttributeURI`, the value the IsValid check matches against the `rdl_uri`s. Rows are now also split by it.
- IsValid on the Attributes sheet follows the `rdl_uri` rule above.

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html`: version 2.4; the two new Export Element… columns, the `rdl_uri` matching rule and the empty list value (4.3 Export Element…); in section 8 the class-by-`rdl_uri` / PRF-EXT-04 paragraph, the class-qualified PRF-SCP-02 paragraph, the Thermowell exception, the PropertyBreak attribute paragraph and table, the MDL-CMP-03 footnote, the PRF-EXT-04, PRF-SCP-02, MDL-CMP-03 and PRF-TRN-05 table rows, and the implemented count (45 of 82).

### Issue code register (`issueCodes.js`)

| Code | Change |
|---|---|
| PRF-EXT-04 "ComponentClassURI disagrees with the class it claims" | Implemented, Warning, needs model, all files |
| MDL-CMP-03 | Warning (was Error); Error per finding when the model requires the sub-component |
| PRF-TRN-05 "Zero or negative scale" | Warning (was Error) |
| PRF-SCP-02 | Title "Property outside the DISC AllowedProperties list for its class" |

45 of the 82 registered codes are implemented.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.3_to_2.4.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `scripts/build-rdl-uris.py` (new), `scripts/dexpi14-rdl-overrides.json` (new), `src/dexpiRdlUris.json` (new), `src/rdlValidate.js`, `src/profileRules.js`, `src/folderValidate.js`, `src/reportColumns.js`, `src/issueCodes.js`, `src/App.jsx`, `src/lineResolve.js`.
