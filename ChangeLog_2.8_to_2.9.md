# Changelog

## 2.9

Changes from version 2.8.3 (commit `04b5862` "Version 2.8.3", 2026-10-29).

### Version

- The app is versioned as **2.9** (`package.json` / `package-lock.json` 2.9.0, `README.md`, User Guide).
- `README.md` links only this changelog. The earlier changelogs (`ChangeLog_0.0_to_2.1.md` … `ChangeLog_2.7_to_2.8.md`) stay in the repository.

### Panning as in xBridge

The drawing pans by dragging with the left or middle mouse button, as in xBridge (`MIMS_Bridge_DEXPI` `ModelCanvas.vue`). Holding **Space** is no longer needed or used. A press that moves 2 px or less is a click and selects as before; the click that ends a pan does not select. The toolbar hint "Scroll to zoom · Space+drag to pan" is removed. Double-clicking the drawing fits it to the window, like the **Fit** button (`fitDrawingToWindow()`). Mouse-wheel zoom now stays anchored under the cursor (it used the view from when the drawing was loaded).

`src/App.jsx`: `panDragRef` / `suppressClickRef` with pointer events on the drawing viewport replace `spaceDown`, `panStart` and the Space key listeners.

### Profile labels / Mixed labels checkboxes

| Checkbox | 2.8.3 | 2.9 |
|---|---|---|
| none | file `<Label>` texts | unchanged |
| **Profile labels** | profile LabelTemplate labels **and** the file's `<Label>` texts | the profile LabelTemplate labels and Note texts only; other `<Label>` texts are hidden. Leader lines only for Note labels and label symbols (e.g. ND0048 `SpecialItemLabel-21` in 26010) |
| **Mixed labels** (new) | — | `<Label>` texts that reference the label symbol's profile label attributes, showing only those values with the template's in-between literals; a placement with no such text shows its profile default label |

The two checkboxes are mutually exclusive. With **Mixed labels**, only literals allowed by the profile label are shown; the file's own literals (Text `String`, references without `ItemID`) are not. The separator between two values is the literal that stands before the second value's token in the profile template, so `0400 x 0150` (ND0077, template `<In>x<Out>`) shows `0400x0150`, and `/KILO/FB` (ND0029, template `<TrimType> <LockMechanism>`) shows `FB KILO`. Literals before the first or after the last value (`EL: `, `HH=`) are not shown.

Implementation:

- `src/proteusParser.js`: new `formatRepresentationGroupLabel()`, `labelTemplateParts()`, `variantLabelTemplateTexts()`. Each `lbl_` text carries `repGroupValue`; `lbl_`, `lblleader_` and `lbltpl_` elements carry `labelGroupId` (the placement whose profile labels are the default for that label). A Text that only resolves in the new mode is emitted too and hidden in the others.
- Note texts (`isNoteText`: every `ItemID` reference points at a Note) are drawn as in the file with **Profile labels** and **Mixed labels**; their Labels' leader lines carry `isNoteLabel`.
- Leader lines of a `<Label>` that places its own label symbol (ND0048, ND0248B …) carry `isSymbolLabel` and are drawn with **Profile labels** and **Mixed labels** too.
- `src/App.jsx`: `showMixedLabels` state, new checkbox, `drawnElements` filter replacing the old `lbltpl_` filter.
- `public/UserGuide.md` / `.html`: section 5.6 and the toolbar table.

Checked on FPQ-26055-CNV12: none 206 label texts; Profile labels 88 profile labels only; Mixed labels 73 label texts + 42 default labels on 71 placements. DISC_EXAMPLE-05-10 has no `<Label>` texts, so the new mode shows all 131 default labels.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.8_to_2.9.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/proteusParser.js`.
