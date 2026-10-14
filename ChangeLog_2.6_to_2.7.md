# Changelog

## 2.7

Changes from version 2.6 (see `ChangeLog_2.5_to_2.6.md`).

### Version

- The app is versioned as **2.7** (`package.json` / `package-lock.json` 2.7.0).

### BG Controls - Auto-fit and Save placement (from DEXPIViewer)

- **⤢ Auto-fit to drawing** finds the Scale / X / Y that lays the drawing over the BG image and shows the match %. Runs in a worker (`imageCompare.js`, `imageCompare.worker.js`, copied from DEXPIViewer).
- **💾 Save placement** replaces **⬇ Download PNG with placement**: the placement is written into the PNG under its own file name - straight into the file when it came from a validated folder or the **BG Image** dialog, otherwise through a Save dialog with the same name. **Clear Default** saves the same way.
- **BG Image** accepts a `.xml` picked together with its `.png` and loads both.

### Profile labels - alarm limits

- `HH` / `H` / `L` / `LL` LabelTemplates show `<level>=<AlarmValue><UoM>` (e.g. `HH=272Bar`) from the SignalConveyingFunction whose `PortStatusSpecialization` is `StatusHighHighPort` / `StatusHighPort` / `StatusLowPort` / `StatusLowLowPort`. The text is built from the profile's own template (quoted literals joined with `&`, plus the AlarmValue and its UoM), so a profile whose H/L templates are just `'H'` / `'L'` shows only `H` / `L`. Without a matching SignalConveyingFunction the label is not shown.
- Previously the `SignalConveyingFunction:<AlarmValue>` token used the first associated SignalConveyingFunction (often the incoming signal line, with no AlarmValue), so none of these labels were shown.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.5_to_2.6.md` (2.7 items moved out), `ChangeLog_2.6_to_2.7.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/imageCompare.js` (new), `src/imageCompare.worker.js` (new), `src/proteusParser.js`.
