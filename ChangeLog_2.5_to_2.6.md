# Changelog

## 2.6

Changes from version 2.5 (see `ChangeLog_2.4_to_2.5.md`).

### Version

- The app is versioned as **2.6** (`package.json` / `package-lock.json` 2.6.0).

### Suggest… - suggested syntax from the file and the DISC transfer requirements

The **Suggest a fix** dialog now builds the fix from the objects around the finding (coordinates, connections, existing IDs) and from the model patterns of the DISC DEXPI Pilot Transfer Requirements, instead of only showing generic syntax. New IDs use the next free number in the file (`ProcessSignalGeneratingFunction-n`, `ActuatingFunction-n`, `Nozzle-n`, `PipingNode-n` ...).

| Code | Suggested fix |
|---|---|
| MDL-REF-03 - signal line starting at a pipe item, nozzle or equipment | The line becomes a **MeasuringLineFunction** whose Source is a **ProcessSignalGeneratingFunction** inside the instrument (the instrument holding the line, or the one at its other end). The PSGF's SensingLocation (`is located in`) is the item, with `is the location of` added on the item. |
| MDL-REF-03 - signal line ending at a valve | Target is an **ActuatingFunction** in the sending instrument, `is fulfilled by` an **ActuatingSystem** with a ControlledActuator and an OperatedValveReference that `refers to` the valve. If the valve already has an ActuatingSystem that fulfils an ActuatingFunction, the line is pointed at that ActuatingFunction. |
| MDL-REF-03 - signal line ending at a motor or heater | Target is an **ActuatingElectricalFunction** located in a Nozzle on the equipment. |
| MDL-REF-03 - line drawn straight to equipment | A **Nozzle** owned by the equipment is added at the line's end point (Position + ConnectionPoints, no graphics). |
| MDL-REF-03 - abstract SignalOffPageConnector | ComponentClass changed to **FlowInSignalOffPageConnector** (line starts there) or **FlowOutSignalOffPageConnector** (line ends there). |
| SER-REQ-02 - empty `<GenericAttributes/>` | Delete the empty set, or fill it: a template of the owner class's DEXPI 1.4 data properties (name + AttributeURI). The notes name the `Raw_` file and ID to copy the values from, and list the element's other attribute sets. |
| SER-CNT-01 - GenericAttributes Number mismatch | Number set to the real count, or the names of the attributes present so the missing ones can be found in the `Raw_` file (keeping the declared Number). |
| MDL-CLS-05 / MDL-CLS-01 / PRF-SCP-01 on a COMOS Orphan container (OrphanPipingNetworkSystem, OrphanPipingNetworkSegment, OrphanInformationFlowCollectorDummy) | No class or URI is suggested. Each item is moved into the PipingNetworkSegment its node touches (or listed when it touches none); signal lines move to PlantModel; the empty container is deleted with the Associations pointing at it. |
| MDL-CLS-05 (other elements) | The ComponentClassURI is read only from the element's own XMpLant attributes, not from nested components. |
| MDL-CMP-03 - piping item without nodes | `<ConnectionPoints>` with the Default node and one `process` Node per connection (count from the Connections using the item); node 1 at the X,Y of the node or CenterLine end it touches. |
| PRF-SCP-01 (other classes) | Note: use a class the DISC profile allows - the real DEXPI class, or a `Custom<BaseClass>` with TypeName/TypeURI. |

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.4_to_2.5.md` (2.6 items moved out), `ChangeLog_2.5_to_2.6.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/suggestPrompt.js`.
