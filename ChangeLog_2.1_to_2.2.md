# Changelog

## 2.2

Changes from version 2.1 (see `ChangeLog_0.0_to_2.1.md`).

### Version

- The app is versioned as **2.2** (`package.json` / `package-lock.json` 2.2.0).

### New category: Modelling conventions (GEO layer)

Checks with no specific schema, information model or profile rule behind them. They report as **Warning**.

- **GEO-MDL-01 "Actuating signal connector end on wrong object type"** (new). For each `InformationFlow`:
  - Source (`has logical start`) is an `ActuatingFunction`: the `Connection` `FromID`/`FromNode` must be a `ControlledActuator`.
  - Target (`has logical end`) is an `ActuatingFunction`: the `Connection` `ToID`/`ToNode` must be a `ControlledActuator`.
  - Target is an `ActuatingElectricalFunction`: the `Connection` `ToID`/`ToNode` must be a `Nozzle`.
  - `FromID`/`ToID` resolves by ID, TagName, or `<EquipmentTag>-<NozzleTag>`. A missing `Connection`, missing ID attribute or unresolved ID is also reported.

### Validation rules

- **GEO-ALN-01 "Connected items not coincident"** now also checks links between segments and systems:
  - A segment `Connection` end whose `FromID`/`ToID` points at another `PipingNetworkSegment` (the segment itself, or a component in it with no usable node number) must touch one of that segment's CenterLine end points or node positions. Applies to segments in the same `PipingNetworkSystem` and in different systems; the message says which. Previously an end connecting to another segment was skipped.
  - The segments of one `PipingNetworkSystem` must form a single linked network. Otherwise one finding on the system lists the separate groups.
  - An end already checked against a component node by the existing end check is not reported twice.
- **SER-IDN-03 "Reference does not resolve inside the file"** now also checks:
  - `Connection` `FromNode`/`ToNode`: must be a Node of the resolved target's `ConnectionPoints` (indexed from 0). Targets without `ConnectionPoints` are skipped.
  - `ConnectionPoints` `FlowIn`/`FlowOut`: must be one of its own Nodes (indexed from 0).
  - `Association` `TagName`: must match a `TagName` in the file.
  - `Association` `PersistentIDIdentifier` (+ `PersistentIDContext`): must match a `PersistentID` in the file.
  - An `Association`'s own `TagName` no longer counts as a declared tag when resolving `FromID`/`ToID` or tag references.
- **Vessel components**: a `CustomEquipment` whose TypeURIAssignmentClass resolves to `ProcessVesselComponent` or one of its subclasses (e.g. `TowerTray`) no longer raises **MDL-CLS-03**. It must be a `<Component>` element directly inside a Vessel `<Equipment>` (the profile's `VesselExtension.ProcessVesselComponents`), else **MDL-CMP-02**.
- **MDL-CYC-01 "Cyclic dependency"** (new check). Whole-part (including XML nesting), location, drive and fulfilment relations must not form a loop. Each cycle is reported once, listing the objects in it. Flow, signal and connection relations are not checked for loops.
  - Also reports self-references: a `Connection` `FromID`/`ToID` (with `FromNode`/`ToNode`) that points back at the element owning the connection, and an `InformationFlow` whose Source or Target is itself. MDL-REF-03, GEO-MDL-01 and SER-IDN-03 are unchanged and may also report the same case.

### Issue code register (`issueCodes.js`)

| Code | Change |
|---|---|
| GEO-ALN-01 "Connected items not coincident" | Severity Error → Warning (major → minor); scope extended as above |
| GEO-MDL-01 "Actuating signal connector end on wrong object type" | New, implemented, Warning, category Modelling conventions |
| MDL-CYC-01 "Cyclic dependency" | Now implemented (Error) |

81 codes are registered; 42 are implemented.

### Drawing view / export

- **Fit, Save PNG/PDF and folder Save PNG** now include text in the drawing bounds. Previously only geometry counted, so notes below the lowest line or symbol were cut off (e.g. notes 4-8 on FPQ-AKSO-P-XB-10001-01).

### User Guide

- `public/UserGuide.md` and the generated `public/UserGuide.html`: version 2.2, the GEO-ALN-01, GEO-MDL-01, SER-IDN-03 and MDL-CYC-01 rows and descriptions, and the implemented-code count. SER-IDN-03 was already implemented in 2.1 but was shown as not implemented in the guide.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.1_to_2.2.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/rdlValidate.js`, `src/profileRules.js`, `src/issueCodes.js`, `src/dexpiParser.js`.
