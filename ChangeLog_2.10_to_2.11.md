# Changelog

## 2.11

Changes from version 2.10 (commit `16a3715` "Version 2.10"), including commit `bf151e5` (signal line styles and line weight). This release brings the image Compare from DEXPIViewer to the Proteus 4.1.1 viewer, aligns signal-line styles and line weight with DEXPIViewer, and keeps symbol text readable under rotation and mirroring.

### Version

- The app is versioned as **2.11** (`package.json` / `package-lock.json` 2.11.0, `README.md`, User Guide).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Image compare

The image compare already used by the auto-fit (`imageCompare.js`, `imageCompare.worker.js`) now has its full user interface, as in DEXPIViewer:

- **⇄ Compare** button and **Compare layer** checkbox in the BG controls.
- New left-panel **Compare** tab (shown while a BG image is loaded or a result exists): Run / Re-run compare, Auto-fit, progress, *Settings* (match tolerance, misplaced search radius, required match, smallest missing region), *View* Off / Markers / Difference, per-code filters with counts, *Show reviewed*, and CSV / JSON / Diff PNG downloads.
- Findings IMG-001 … IMG-011, each with Accept / Ignore / False positive and a comment. Review decisions are stored in the browser per drawing file.
- Markers on the drawing (a box per open finding, an arrow for Misplaced) and a Difference view with the drawing faded over the difference image. Clicking a finding selects the object and zooms to it.
- New right-panel **Compare** tab: the findings of the selected object (and its sub-components when **Sub-components** is ticked), with the count still open.
- A new drawing or BG image clears the result; moving the image after a run shows *The BG placement changed since this run*.
- Markers and the difference image are not part of PNG / PDF / DXF exports. Auto-fit and Save placement work as before.
- The compare runs in the same background worker as the auto-fit, so Compare and Auto-fit are disabled while the other is running. Review decisions are stored under the browser key `aksoDexpiViewer.imgCompare.<file name>`.

- `src/App.jsx`: compare state, worker call, issue list, markers, difference image, right-panel tab, exports.
- User Guide: new sections **5.9 Image compare** and **6.4 Compare tab**; *Interface Overview* lists the Compare tabs. `public/UserGuide.html` regenerated with `scripts/build-guide.py`.

### Signal-conveying line styles

`SignalConveyingFunctionTypeRepresentation` now decides the line style, also for **DEXPI 2.0** files (before, only Proteus `<InformationFlow>` lines were styled; DEXPI 2.0 lines kept the file's DashStyle and had no marks):

- `SignalConveying` → dashed, **3 mm dash / 3 mm gap** (was 3 / 2);
- every sub-type (`ElectricalSignalConveying`, `Hydraulic…`, `Bus…`, `Pneumatic…`, `Capillary…`, `Undefined…`, `ElectromagneticGuided…`) → **solid** line with its repeated mark, whatever DashStyle the file gives the line;
- `ElectromagneticUnguidedSignalConveying` → marks only, no line;
- `MeasuringLineFunction` (DEXPI 2.0) → solid, no marks.

Example: UPP-AIL-P-XB-20021-01, `SP71B621B060ED428EACF4650EAD3791DE_CL_1` (`ElectricalSignalConveying`, file DashStyle `Dash`) is now a solid line with italic E marks.

The marks were redrawn: about 2.5 mm tall and **centred on the line**, letters every **6.5 mm** starting 2.5 mm in, bus circles (radius 1.25 mm) every 10 mm starting 5 mm in, one mark in the middle of a line too short for that. They use the line's own colour and width. Before, the glyphs started at the mark point, repeated every 14 mm and were drawn 0.16 screen px thick, which made them nearly invisible.

- `src/dexpiParser.js`: `SIGNAL_CONVEYING_SOLID_TYPES`, `signalConveyingTypeFor()`, `objectTypeMap`; connector lines carry `signalConveyingType`.
- `src/proteusParser.js`, `src/dexpiParser.js`: `SIGNAL_CONVEYING_DASH_ARRAY` "3 3".
- `src/App.jsx`: `SIGNAL_MARK_GLYPHS`, `signalMarkStops()`, `SignalConveyingMarks`; `ConnectorLineSvg` draws the marks and hides the line for unguided signals.
- `src/imageCompare.js`: mark positions and glyph size follow the new marks (IMG-008 / IMG-011).

### Minimum line weight

No line is drawn thinner than **1 screen pixel**, at any zoom: connector lines, Proteus centerlines, symbol outlines and signal marks. Authored widths of 0.09–0.25 mm otherwise drew as faint sub-pixel lines. Thicker widths and **Line Boost** work as before (default 100%).

Dash lengths now follow Line Boost only. The DEXPI 2.0 DashStyle table was completed and aligned with DEXPIViewer: lengths are multiples of the line width with a 0.1 mm floor — Dot 1:2, ShortDash 2:2, Dash 4:2, LongDash 8:3, DashShortDash, LongDashShortDash, LongDashShortDashShortDash, DashDot, DashDotDot.

- `src/App.jsx`: `MIN_STROKE_PX`, viewport size (`ResizeObserver`) → `worldPerPx`; `renderPrimitive`, `ConnectorPolyline`, `ConnectorLineSvg`.
- `src/dexpiParser.js`: `parseStroke()` dash table.

### Symbol text under rotation and mirroring

Literal text that is part of a profile symbol's own graphics (e.g. `TS` in ND0227 Strainer T Temporary) now follows DISC DEXPI rule 'B' (Annex B), like the profile LabelTemplate overlays: never drawn with mirrored letters, left to right at 0°/180°, bottom to top at 90°/270°, with position and alignment following the rule. Before, it was turned and mirrored with the symbol. Example: UPP-AIL-P-XB-41020-01, `SP5C80FB4608364D348E739148D7A13360` (ND0227, mirrored).

- `src/App.jsx`: `readableAngle()`, `symbolTextPlacement()`; `SymbolGraphic` passes the placement to `renderPrimitive`.
- User Guide 5.6 *Rotation and mirroring*.
