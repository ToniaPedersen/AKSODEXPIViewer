import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor, isConnectivityRefProperty,
} from "./dexpiParser.js";
import { parseProteusPackage, SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES, TREE_CONTAINMENT_REF_PROPERTIES } from "./proteusParser.js";
import { validateProteusXsd } from "./xsdValidate.js";
import { validateAgainstRdl } from "./rdlValidate.js";
import { ISSUE_CODES, ALL_CODES } from "./issueCodes.js";
import { pickXmlFiles, pickDirectory, pickDirectoryForWrite, pngPathFor, writeFileAt, collectFolderElements, supportsDirectoryPicker, validateFiles, buildFolderReport } from "./folderValidate.js";
import { buildReportRows, buildTagIndex, locationFromModel, locationFromXsd } from "./reportColumns.js";
import { buildXlsxBlob } from "./xlsxBlob.js";
import { buildLineResolver } from "./lineResolve.js";
import ErrorExplorer from "./errorExplorer.jsx";
import { version as APP_VERSION } from "../package.json";
import { jsPDF } from "jspdf";

// Issue classification codes reported here come from issueCodes.js, shared by xsdValidate.js and rdlValidate.js.

const VALIDATION_CODE_LABELS = Object.fromEntries(
    ALL_CODES.map(code => [code, ISSUE_CODES[code].title])
);

// Default severity per code: Major -> Error, Minor -> Warning. The Config tab can override any code (see resolveValidationSeverity below).
const DEFAULT_VALIDATION_SEVERITIES = Object.fromEntries(
    ALL_CODES.map(code => [code, ISSUE_CODES[code].severity === "major" ? "error" : "warning"])
);

function resolveValidationSeverity(code, severityConfig) {
    if (severityConfig && severityConfig[code]) return severityConfig[code];
    if (DEFAULT_VALIDATION_SEVERITIES[code]) return DEFAULT_VALIDATION_SEVERITIES[code];
    return "error"; // unknown validation code: defaults to "error"
}

// DiscProfile.xml fetched at startup from the DISCDEXPI_2026Pack repo, so the viewer
// starts with a profile without one being picked. A profile loaded by hand replaces it.
const DEFAULT_PROFILE_URL = "https://raw.githubusercontent.com/ToniaPedersen/DISCDEXPI_2026Pack/main/Profile/xml/DiscProfile.xml";
const DEFAULT_PROFILE_NAME = "DiscProfile.xml (DISCDEXPI_2026Pack)";

const SEV_COLORS = { error: "#cf222e", warning: "#b45309", info: "#0969da" };
const SEV_LABELS = { error: "Error", warning: "Warning", info: "Info" };

// Display labels for "other" (non-upstream/downstream/group) connectivity ref types in the Connections tab.
// A property not listed here falls back to showing its raw string value.
const CONNECTION_TYPE_LABELS = {
    "direct item of Segment": "Direct Item of PipingNetworkSegment",
    "segment item (direct)": "Direct Items (PipingNetworkSegment)",
    "indirect item of System": "Indirect Item of PipingNetworkSystem",
    "system item (indirect)": "Indirect Items (PipingNetworkSystem)",
    "has logical start": "Has Logical Start",
    "has logical end": "Has Logical End",
    "is logical start of": "Is Logical Start Of",
    "is logical end of": "Is Logical End Of",
};

// GenericAttributes/@Set values treated as DEXPI-modeled attributes; others are hidden from the Data panel by default.
// Attributes with no Set are always shown.
const DEXPI_ATTRIBUTE_SETS = new Set(["DexpiAttributes", "DexpiCustomAttributes"]);

// ---------- BG image default placement (embedded in the PNG itself) --------
// The placement ({scale, offsetX, offsetY}) is stored in a tEXt chunk inside the PNG file itself. Only PNG images support this.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_PLACEMENT_KEYWORD = "dexpi:bgPlacement";

function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function png_concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    arrays.forEach(a => { out.set(a, pos); pos += a.length; });
    return out;
}

// Standard PNG CRC-32 (ISO 3309 / ITU-T V.42) over a chunk's type and data bytes, per the PNG spec.
const PNG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function png_crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = PNG_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function png_u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function png_readU32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

// Walks a PNG byte array's chunk structure, returning [{ type, dataStart, dataLength, chunkStart, chunkEnd }, ...] in file order.
// Stops at IEND or on a malformed chunk header.
function png_readChunks(bytes) {
    const chunks = [];
    let offset = 8; // past the 8-byte signature
    while (offset + 8 <= bytes.length) {
        const length = png_readU32be(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const chunkEnd = dataEnd + 4; // + CRC
        if (chunkEnd > bytes.length) break;
        chunks.push({ type, dataStart, dataLength: length, chunkStart: offset, chunkEnd });
        offset = chunkEnd;
        if (type === "IEND") break;
    }
    return chunks;
}

// Decodes a tEXt chunk's "Keyword\0Text" payload (Latin-1).
function png_decodeTextChunk(bytes, chunk) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength);
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    const keyword = String.fromCharCode(...data.subarray(0, nul));
    const text = String.fromCharCode(...data.subarray(nul + 1));
    return { keyword, text };
}

function png_buildTextChunk(keyword, text) {
    const kwBytes = Uint8Array.from(keyword, ch => ch.charCodeAt(0));
    const txtBytes = Uint8Array.from(text, ch => ch.charCodeAt(0));
    const typeBytes = Uint8Array.from("tEXt", ch => ch.charCodeAt(0));
    const data = png_concat(kwBytes, new Uint8Array([0]), txtBytes);
    const crc = png_crc32(png_concat(typeBytes, data));
    return png_concat(png_u32be(data.length), typeBytes, data, png_u32be(crc));
}

// Returns new PNG bytes with any existing placement tEXt chunk removed.
function png_stripPlacementChunk(bytes) {
    const chunks = png_readChunks(bytes);
    const keep = chunks.filter(c => {
        if (c.type !== "tEXt") return true;
        const kv = png_decodeTextChunk(bytes, c);
        return !(kv && kv.keyword === PNG_PLACEMENT_KEYWORD);
    });
    const parts = [bytes.subarray(0, 8)];
    keep.forEach(c => parts.push(bytes.subarray(c.chunkStart, c.chunkEnd)));
    return png_concat(...parts);
}

// Returns new PNG bytes with the given {scale, offsetX, offsetY} written as a tEXt chunk before IEND.
// Does not mutate the input; throws if the PNG has no IEND chunk.
function writePngEmbeddedPlacement(bytes, placement) {
    const stripped = png_stripPlacementChunk(bytes);
    const chunks = png_readChunks(stripped);
    if (!chunks.some(c => c.type === "IEND")) throw new Error("Not a valid PNG (no IEND chunk found).");
    const newChunk = png_buildTextChunk(PNG_PLACEMENT_KEYWORD, JSON.stringify({
        scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY,
    }));
    const parts = [stripped.subarray(0, 8)];
    chunks.forEach(c => {
        if (c.type === "IEND") parts.push(newChunk);
        parts.push(stripped.subarray(c.chunkStart, c.chunkEnd));
    });
    return png_concat(...parts);
}

// Reads the saved BG placement embedded in a PNG's tEXt metadata; returns {scale, offsetX, offsetY} or null.
function readPngEmbeddedPlacement(bytes) {
    try {
        if (!isPngBytes(bytes)) return null;
        for (const chunk of png_readChunks(bytes)) {
            if (chunk.type !== "tEXt") continue;
            const kv = png_decodeTextChunk(bytes, chunk);
            if (!kv || kv.keyword !== PNG_PLACEMENT_KEYWORD) continue;
            const parsedPlacement = JSON.parse(kv.text);
            if (parsedPlacement && Number.isFinite(parsedPlacement.scale) && Number.isFinite(parsedPlacement.offsetX) && Number.isFinite(parsedPlacement.offsetY)) {
                return { scale: parsedPlacement.scale, offsetX: parsedPlacement.offsetX, offsetY: parsedPlacement.offsetY };
            }
            return null;
        }
        return null;
    } catch {
        return null;
    }
}

// ---------- Data value formatting --------------------------------------------

/* Renders a parsed data value into a human-readable string or JSX. Handles PhysicalQuantity, DataReference, strings, numbers, booleans. */
function formatDataValue(value) {
    if (value === null || value === undefined) return { text: "—", uom: null };

    if (value && typeof value === "object" && value.kind === "PhysicalQuantity") {
        const num = value.value !== null && value.value !== undefined ? String(value.value) : "—";
        return { text: num, uom: value.unit || null, unitRef: value.unitRef || null };
    }

    if (value && typeof value === "object" && value.kind === "DataReference") {
        const short = value.value.split(".").pop().split("/").pop();
        return { text: short, uom: null, fullRef: value.value };
    }

    if (value && typeof value === "object" && typeof value.value === "string") {
        return { text: value.value, uom: null };
    }

    if (typeof value === "boolean") return { text: value ? "true" : "false", uom: null };

    return { text: String(value), uom: null };
}

// ---------- Styles -----------------------------------------------------------

const S = {
    app: (lc, rc) => ({ display: "grid", gridTemplateColumns: `${lc ? 44 : 340}px 1fr ${rc ? 44 : 340}px`, height: "100vh", fontFamily: "Arial, sans-serif", color: "#111", overflow: "hidden" }),
    panel: { borderRight: "1px solid #d0d7de", display: "flex", flexDirection: "column", background: "#fff", minWidth: 0, overflow: "hidden" },
    rPanel: { borderLeft: "1px solid #d0d7de", display: "flex", flexDirection: "column", background: "#fff", minWidth: 0, overflow: "hidden" },
    collapsed: { borderRight: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", justifyContent: "center" },
    rCollapsed: { borderLeft: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", justifyContent: "center" },
    toolbar: { padding: "10px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    scroll: { flex: 1, overflow: "auto" },
    section: { padding: 12, borderBottom: "1px solid #eef2f6" },
    btn: { padding: "6px 10px", border: "1px solid #c7ced6", background: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    btnSmall: { padding: "3px 7px", border: "1px solid #c7ced6", background: "white", borderRadius: 4, cursor: "pointer", fontSize: 12 },
    btnPrimary: { padding: "6px 10px", border: "1px solid #0969da", background: "#0969da", color: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    // Small bordered "remove" button, used for the DiscProfile.xml unload control and other destructive actions.
    btnDanger: { padding: "3px 7px", border: "1px solid #cf222e", background: "white", color: "#cf222e", borderRadius: 4, cursor: "pointer", fontSize: 12 },
    input: { width: "100%", padding: "6px 8px", border: "1px solid #c7ced6", borderRadius: 6, boxSizing: "border-box", fontSize: 13 },
    numBox: { width: 52, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    // Wide enough for an "nnn.nnnn" value (3 integer digits, 4 decimal places) without clipping.
    numBoxWide: { width: 88, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    tabBar: { display: "flex", gap: 0, borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    tab: (active) => ({ padding: "8px 14px", cursor: "pointer", fontWeight: active ? 700 : 400, fontSize: 13, color: active ? "#0969da" : "#57606a", background: "none", border: "none", borderBottom: active ? "2px solid #0969da" : "2px solid transparent" }),
    collapseBtn: { width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#57606a" },
    badge: (color) => ({ display: "inline-block", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: color || "#eef2f6", color: color ? "white" : "#444" }),
};

// Small rotating spinner shown while validation is running. CSS keyframes are injected via a <style> tag below.
const SPINNER_CSS = `
@keyframes dexpi-spin { to { transform: rotate(360deg); } }
.dexpi-spinner {
    display: inline-block; width: 10px; height: 10px; margin-right: 6px;
    border: 2px solid #c7ced6; border-top-color: #0969da; border-radius: 50%;
    animation: dexpi-spin 0.7s linear infinite; vertical-align: -1px;
}
`;
function Spinner() { return <span className="dexpi-spinner" aria-hidden="true" />; }

// ---------- EllipseArc SVG helper --------------------------------------------

function ellipseArcToPath(cx, cy, rx, ry, startDeg, endDeg, rotation) {
    const toRad = d => d * Math.PI / 180;
    const phiRad = toRad(rotation);
    const pt = (deg) => {
        const a = toRad(deg);
        const ca = Math.cos(a), sa = Math.sin(a);
        const cp = Math.cos(phiRad), sp = Math.sin(phiRad);
        return { x: cx + rx * cp * ca - ry * sp * sa, y: cy + rx * sp * ca + ry * cp * sa };
    };
    let span = endDeg - startDeg;
    if (span <= 0) span += 360;
    if (span >= 359.9) {
        const p1 = pt(startDeg), pmid = pt(startDeg + 180);
        return `M ${p1.x} ${p1.y} A ${rx} ${ry} ${rotation} 0 1 ${pmid.x} ${pmid.y} A ${rx} ${ry} ${rotation} 0 1 ${p1.x} ${p1.y}`;
    }
    const p1 = pt(startDeg), p2 = pt(endDeg);
    const largeArc = span > 180 ? 1 : 0;
    return `M ${p1.x} ${p1.y} A ${rx} ${ry} ${rotation} ${largeArc} 1 ${p2.x} ${p2.y}`;
}

// ---------- SVG Rendering ----------------------------------------------------

function renderPrimitive(primitive, key, textColorOverride = null, strokeMult = 1, showProfileLabels = false) {
    const fill = v => v?.style === "Transparent" ? "none" : (v?.color || "none");
    const sw = v => v * strokeMult;
    if (primitive.kind === "polyline") return <polyline key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "polygon") return <polygon key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "circle") return <circle key={key} cx={primitive.center.x} cy={primitive.center.y} r={primitive.radius} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "ellipse") return <ellipse key={key} cx={primitive.center.x} cy={primitive.center.y} rx={primitive.rx} ry={primitive.ry} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "rect") return <rect key={key} x={primitive.center.x - primitive.width / 2} y={primitive.center.y - primitive.height / 2} width={primitive.width} height={primitive.height} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "text") {
        const anchor = primitive.style.horizontal.toLowerCase().includes("left") ? "start" : primitive.style.horizontal.toLowerCase().includes("right") ? "end" : "middle";
        const baseline = primitive.style.vertical.toLowerCase().includes("bottom") ? "baseline" : primitive.style.vertical.toLowerCase().includes("top") ? "hanging" : "middle";
        const textFill = textColorOverride || parseColor(primitive.style.color);
        // Text display value: a validated own-reference (hasOwnValidatedTemplate) always uses resolvedTemplateValue.
        // With showProfileLabels on, a DiscProfile-catalogued label is blanked (its catalog overlay is drawn separately); other text shows its own literal value.
        // With showProfileLabels off, a DiscProfile-catalogued label shows the profile's resolved value when available, else nothing; other text shows its own literal value.
        const displayText = primitive.hasOwnValidatedTemplate
            ? (primitive.resolvedTemplateValue ?? "")
            : showProfileLabels
                ? (primitive.isDiscProfileLabel ? "" : (primitive.value ?? ""))
                : (primitive.isDiscProfileLabel
                    ? (primitive.hasProfileAttributeBacking && primitive.hasProfileAttributeValue ? primitive.validRawProfileText : "")
                    : (primitive.value ?? ""));
        // Text values can contain embedded line breaks; each line is rendered as its own <tspan>, with the block anchored around position.y.
        const lines = String(displayText ?? "").split(/\r\n|\r|\n/);
        const lineHeight = primitive.style.size * 1.2;
        const y0 = baseline === "hanging" ? primitive.position.y
            : baseline === "baseline" ? primitive.position.y - (lines.length - 1) * lineHeight
            : primitive.position.y - (lines.length - 1) * lineHeight / 2;
        return (
            <text key={key} fontFamily={primitive.style.font} fontSize={primitive.style.size} fill={textFill} textAnchor={anchor} transform={`rotate(${primitive.rotation} ${primitive.position.x} ${primitive.position.y})`}>
                {lines.map((line, i) => (
                    <tspan key={i} x={primitive.position.x} y={y0 + i * lineHeight} dominantBaseline={baseline}>{line}</tspan>
                ))}
            </text>
        );
    }
    if (primitive.kind === "ellipseArc") {
        const d = ellipseArcToPath(primitive.center.x, primitive.center.y, primitive.rx, primitive.ry, primitive.startAngle, primitive.endAngle, primitive.rotation);
        return <path key={key} d={d} fill="none" stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    }
    return null;
}

function highlightPrimitive(p, key, color) {
    const sw = Math.max((p.stroke?.width || 0.25) * 2.5, 0.9);
    if (p.kind === "polyline") return <polyline key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "polygon") return <polygon key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "circle") return <circle key={key} cx={p.center.x} cy={p.center.y} r={p.radius} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "ellipse") return <ellipse key={key} cx={p.center.x} cy={p.center.y} rx={p.rx} ry={p.ry} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "rect") return <rect key={key} x={p.center.x - p.width / 2} y={p.center.y - p.height / 2} width={p.width} height={p.height} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "ellipseArc") {
        const d = ellipseArcToPath(p.center.x, p.center.y, p.rx, p.ry, p.startAngle, p.endAngle, p.rotation);
        return <path key={key} d={d} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    }
    return null;
}

// Proteus centerline polylines (elementRole "connector"), unlike the "connectorLine" kind, so Line Boost is applied here too.
// Stroke width is non-scaling (constant screen-pixel width regardless of zoom).
function ConnectorPolyline({ prim, boostPct }) {
    const baseWidth = prim.stroke.width;
    const sw = baseWidth * (boostPct / 100);
    const rawDash = prim.stroke.dashArray || "";
    const scaledDash = (rawDash && baseWidth > 0 && sw !== baseWidth)
        ? rawDash.split(/\s+/).map(v => (parseFloat(v) * (sw / baseWidth)).toFixed(3)).join(" ")
        : rawDash;
    return <polyline points={prim.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={prim.stroke.color} strokeWidth={sw} strokeDasharray={scaledDash || undefined} vectorEffect="non-scaling-stroke" />;
}

// ---------- Signal-conveying line decorations -------------------------------
// Proteus InformationFlow CenterLines are decorated with a small repeated glyph based on the DEXPI SignalConveyingFunctionTypeRepresentation attribute (el.signalConveyingType); see SIGNAL_CONVEYING_MARKS below.
const SIGNAL_CONVEYING_MARKS = {
    ElectricalSignalConveying: "E",
    HydraulicSignalConveying: "L",
    BusSignalConveying: "O",
    PneumaticSignalConveying: "^",
    CapillarySignalConveying: "x",
    UndefinedSignalConveying: "/",
    ElectromagneticGuidedSignalConveying: "∿",
    ElectromagneticUnguidedSignalConveying: "∿",
};
// Representation values whose own line is hidden, leaving only the repeated mark.
const SIGNAL_MARK_HIDE_LINE_TYPES = new Set(["ElectromagneticUnguidedSignalConveying"]);
const SIGNAL_MARK_SPACING = 14;  // world units between repeated glyphs
const SIGNAL_MARK_HEIGHT = 2.4;  // glyph cap-height, world units
const SIGNAL_MARK_WIDTH = 1.6;   // glyph width, world units (E only - L's arms are square, see below)
const SIGNAL_MARK_STROKE = 0.16; // glyph stroke width, world units
const SIGNAL_MARK_LEAN = 0.55;   // horizontal shear per unit of y (~29 deg), E only
const SIGNAL_MARK_CIRCLE_RADIUS = 0.9; // "O" (Bus) circle radius, world units
const SIGNAL_MARK_CARET_WIDTH = 1.8;   // "^" (Pneumatic) chevron width, world units
const SIGNAL_MARK_X_WIDTH = 1.6;       // "x" (Capillary) cross width, world units
const SIGNAL_MARK_SLASH_WIDTH = 1.6;   // "/" (Undefined) stroke width, world units
const SIGNAL_MARK_WAVE_WIDTH = 2.4;    // "∿" (Electromagnetic Guided) one full wave cycle's width, world units

// Vector glyph paths for the marks above, built in a local frame where y=0 is the line the glyph sits on, and x=0 is the glyph's leading edge.
function buildSignalMarkPaths() {
    const h2 = SIGNAL_MARK_HEIGHT / 2;
    const w = SIGNAL_MARK_WIDTH;
    const lean = SIGNAL_MARK_LEAN;
    // Italic "E": lean is baked directly into each stroke's endpoints. y=0 passes through the glyph's middle bar.
    const lx = (x, y) => x - lean * y; // shifts top-of-glyph right, bottom left (standard italic lean)
    const tl = { x: lx(0, -h2), y: -h2 }, tr = { x: lx(w, -h2), y: -h2 };
    const bl = { x: lx(0, h2), y: h2 }, br = { x: lx(w, h2), y: h2 };
    const ml = { x: lx(0, 0), y: 0 }, mr = { x: lx(w * 0.75, 0), y: 0 };
    const ePath = `M${tl.x},${tl.y} L${tr.x},${tr.y} M${tl.x},${tl.y} L${bl.x},${bl.y} M${bl.x},${bl.y} L${br.x},${br.y} M${ml.x},${ml.y} L${mr.x},${mr.y}`;

    // Upright "L": vertical and horizontal arms are the same length; the line (y=0) passes through the middle of the vertical arm.
    const lTop = { x: 0, y: -h2 }, lBottom = { x: 0, y: h2 }, lFoot = { x: SIGNAL_MARK_HEIGHT, y: h2 };
    const lPath = `M${lTop.x},${lTop.y} L${lBottom.x},${lBottom.y} L${lFoot.x},${lFoot.y}`;

    // "O" (Bus): a small circle centered at y=0, drawn as two half-circle arcs.
    const r = SIGNAL_MARK_CIRCLE_RADIUS;
    const oPath = `M${r * 2},0 A${r},${r} 0 1 0 0,0 A${r},${r} 0 1 0 ${r * 2},0`;

    // "^" (Pneumatic): a chevron with its apex above the line and both feet below, symmetric about y=0.
    const cw = SIGNAL_MARK_CARET_WIDTH;
    const caretLeft = { x: 0, y: h2 }, caretApex = { x: cw / 2, y: -h2 }, caretRight = { x: cw, y: h2 };
    const caretPath = `M${caretLeft.x},${caretLeft.y} L${caretApex.x},${caretApex.y} L${caretRight.x},${caretRight.y}`;

    // "x" (Capillary): two diagonal strokes of a bounding box centered on y=0.
    const xw = SIGNAL_MARK_X_WIDTH;
    const xPath = `M0,${-h2} L${xw},${h2} M0,${h2} L${xw},${-h2}`;

    // "/" (Undefined): a single diagonal stroke, bottom-left to top-right, in a bounding box centered on y=0.
    const sw_ = SIGNAL_MARK_SLASH_WIDTH;
    const slashPath = `M0,${h2} L${sw_},${-h2}`;

    // "∿" (Electromagnetic Guided): one full wave cycle, built from two cubic-bezier humps, starting and ending on y=0.
    const ww = SIGNAL_MARK_WAVE_WIDTH;
    const waveQ = ww / 4;
    const wavePath = `M0,0 C${waveQ},${-h2} ${waveQ},${-h2} ${waveQ * 2},0 `
        + `C${waveQ * 3},${h2} ${waveQ * 3},${h2} ${ww},0`;

    return { E: ePath, L: lPath, O: oPath, "^": caretPath, x: xPath, "/": slashPath, "∿": wavePath };
}
const SIGNAL_MARK_PATHS = buildSignalMarkPaths();

// Marches at a fixed spacing along a polyline, returning {x, y, angleDeg} samples. angleDeg is normalized to (-90, 90] so glyphs stay upright.
function markPointsAlongPolyline(points, spacing, startOffset = spacing / 2) {
    const marks = [];
    if (!points || points.length < 2) return marks;
    let nextMark = startOffset;
    let accum = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angleDeg > 90) angleDeg -= 180;
        else if (angleDeg <= -90) angleDeg += 180;
        while (nextMark <= accum + len) {
            const t = (nextMark - accum) / len;
            marks.push({ x: p1.x + dx * t, y: p1.y + dy * t, angleDeg });
            nextMark += spacing;
        }
        accum += len;
    }
    return marks;
}

// Renders a small vector glyph repeated along an InformationFlow signal wire; see SIGNAL_CONVEYING_MARKS/SIGNAL_MARK_PATHS above.
function SignalConveyingMarks({ points, markKey, color }) {
    const d = SIGNAL_MARK_PATHS[markKey];
    if (!d) return null;
    const marks = markPointsAlongPolyline(points, SIGNAL_MARK_SPACING);
    if (marks.length === 0) return null;
    return (
        <g pointerEvents="none">
            {marks.map((m, i) => (
                <path key={i} d={d} fill="none" stroke={color} strokeWidth={SIGNAL_MARK_STROKE} strokeLinecap="round"
                    vectorEffect="non-scaling-stroke" transform={`translate(${m.x} ${m.y}) rotate(${m.angleDeg})`} />
            ))}
        </g>
    );
}

function ConnectorLineSvg({ el, nodePosMap, selected, connColor, boostPct }) {
    const { primitive: prim } = el;
    const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
    const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
    const pts = [src, ...prim.innerPoints, tgt].filter(Boolean);
    if (pts.length < 2) return null;
    const color = connColor || (selected ? "#d1242f" : prim.stroke.color);
    const baseWidth = prim.stroke.width;
    const sw = selected
        ? Math.max(baseWidth * 2, baseWidth + 0.4)
        : baseWidth * (boostPct / 100);
    const rawDash = prim.stroke.dashArray || "";
    const scaledDash = (!selected && rawDash && baseWidth > 0 && sw !== baseWidth)
        ? rawDash.split(/\s+/).map(v => (parseFloat(v) * (sw / baseWidth)).toFixed(3)).join(" ")
        : rawDash;
    const mid = Math.floor(pts.length / 2);
    const p1 = pts[mid - 1] || pts[0]; const p2 = pts[mid];
    const dx = p2.x - p1.x; const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len; const uy = dy / len;
    const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
    const ar = Math.max(baseWidth * 3, 1.5);
    return (
        <g>
            <polyline points={pts.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={scaledDash || undefined} vectorEffect={(selected || connColor) ? "non-scaling-stroke" : "none"} />
            {(selected || connColor) && (
                <polygon
                    points={`${mx},${my} ${mx - ux * ar - uy * ar * 0.5},${my - uy * ar + ux * ar * 0.5} ${mx - ux * ar + uy * ar * 0.5},${my - uy * ar - ux * ar * 0.5}`}
                    fill={color} stroke="none" vectorEffect="non-scaling-stroke"
                />
            )}
        </g>
    );
}

// Colour used when a graphical element is selected:
//   label elements  → orange
//   all other types → red
function selectionColor(elementRole) {
    return elementRole === "label" ? "#e06c00" : "#d1242f";
}

// ---------- Heat trace overlays ----------------------------------------------
// Uses dexpiParser.js's buildHeatTraceSet() (objectId -> "inline"|"nozzle"|"pif"|"piping"), computed from HeatTracingType inheritance down the tree.
const HT_COLOR  = "#e06000";
const HT_DASH   = "6 2 6 2";  // dash-dash pattern
const HT_SW     = 0.6;         // stroke width (SVG units)
const HT_OFF    = 1.5;         // offset distance (~1 pt) from pipe / symbol edge
const HT_THRESH = 0.15;        // |sin| or |cos| threshold for axis-alignment (~8.6 deg)

// Heat trace dashed line for a Proteus CenterLine polyline, using the polyline's own world-space points directly.
function HeatTracePolyline({ points }) {
    if (!points || points.length < 2) return null;
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        if (Math.abs(dy / len) < HT_THRESH) {
            // horizontal segment -> offset below
            segs.push({ x1: p1.x, y1: p1.y + HT_OFF, x2: p2.x, y2: p2.y + HT_OFF });
        } else if (Math.abs(dx / len) < HT_THRESH) {
            // vertical segment -> offset to the right
            segs.push({ x1: p1.x + HT_OFF, y1: p1.y, x2: p2.x + HT_OFF, y2: p2.y });
        }
        // diagonal -> skip
    }
    if (segs.length === 0) return null;
    return (
        <g pointerEvents="none">
            {segs.map((s, i) => (
                <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            ))}
        </g>
    );
}

// Computes the axis-aligned bounding box of a symbol in diagram space by transforming its local corners through the placement transform.
function symbolDiagramBBox(el) {
    const mirror = el.isMirrored ? -1 : 1;
    const rad = (el.rotation || 0) * Math.PI / 180;
    const cosR = Math.cos(rad), sinR = Math.sin(rad);
    const { minX, maxX, minY, maxY } = el.variant;
    const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].map(([lx, ly]) => {
        const sx = lx * el.scaleX * mirror;
        const sy = ly * el.scaleY;
        return { x: el.position.x + sx * cosR - sy * sinR,
                 y: el.position.y + sx * sinR + sy * cosR };
    });
    return {
        minX: Math.min(...corners.map(c => c.x)),
        maxX: Math.max(...corners.map(c => c.x)),
        minY: Math.min(...corners.map(c => c.y)),
        maxY: Math.max(...corners.map(c => c.y)),
    };
}

// Heat trace dashed line for an inline symbol (valve, fitting, nozzle).
// Orientation follows el.rotation: horizontal pipe -> line below; vertical pipe -> line to the right; otherwise below.
function HeatTraceSymbol({ el }) {
    const normRot = ((el.rotation || 0) % 360 + 360) % 360;
    const isVertical = (normRot > 75 && normRot < 105) || (normRot > 255 && normRot < 285);
    const bb = symbolDiagramBBox(el);
    if (isVertical) {
        const x = bb.maxX + HT_OFF;
        return <line x1={x} y1={bb.minY} x2={x} y2={bb.maxY}
            stroke={HT_COLOR} strokeWidth={HT_SW} strokeDasharray={HT_DASH}
            vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    } else {
        const y = bb.maxY + HT_OFF;
        return <line x1={bb.minX} y1={y} x2={bb.maxX} y2={y}
            stroke={HT_COLOR} strokeWidth={HT_SW} strokeDasharray={HT_DASH}
            vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    }
}

// Heat trace overlay for a ProcessInstrumentationFunction symbol: traces its outer boundary primitives (circle, ellipse, polygon), expanded outward.
// Falls back to a bounding-box rect when none is found.
function HeatTracePIF({ el }) {
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const pad = 1.5;

    const overlays = [];
    (el.variant.primitives || []).forEach((p, i) => {
        const key = `htpif_${i}`;
        if (p.kind === "circle") {
            overlays.push(
                <circle key={key} cx={p.center.x} cy={p.center.y} r={p.radius + pad}
                    fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        } else if (p.kind === "ellipse") {
            overlays.push(
                <ellipse key={key} cx={p.center.x} cy={p.center.y}
                    rx={p.rx + pad} ry={p.ry + pad}
                    transform={p.rotation ? `rotate(${p.rotation} ${p.center.x} ${p.center.y})` : undefined}
                    fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        } else if (p.kind === "polygon") {
            const outsetSW = (p.stroke?.width || 0.25) + pad * 2;
            overlays.push(
                <polygon key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")}
                    fill="none" stroke={HT_COLOR} strokeWidth={outsetSW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        }
        // polylines / text / rects are internal symbol details - not traced
    });

    if (overlays.length === 0) {
        const x = Math.min(el.variant.minX, el.variant.maxX) - pad;
        const y = Math.min(el.variant.minY, el.variant.maxY) - pad;
        const w = Math.abs(el.variant.maxX - el.variant.minX) + pad * 2;
        const h = Math.abs(el.variant.maxY - el.variant.minY) + pad * 2;
        overlays.push(
            <rect key="htpif_fb" x={x} y={y} width={w} height={h}
                fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
        );
    }

    return <g transform={transform} pointerEvents="none">{overlays}</g>;
}

function SymbolGraphic({ el, selected, connHighlight, onSelect, boostPct, boostSymbolOutlines }) {
    const symbolStrokeMult = boostSymbolOutlines ? boostPct / 100 : 1;
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const hitPad = 2.5;
    const hitX = Math.min(el.variant.minX, el.variant.maxX) - hitPad;
    const hitY = Math.min(el.variant.minY, el.variant.maxY) - hitPad;
    const hitW = Math.abs(el.variant.maxX - el.variant.minX) + hitPad * 2;
    const hitH = Math.abs(el.variant.maxY - el.variant.minY) + hitPad * 2;
    const hlColor = selected ? (connHighlight || selectionColor(el.elementRole)) : connHighlight || null;
    const connTintFill = connHighlight === "#0969da" ? "#dbeafe"
                       : connHighlight === "#1a7f37" ? "#dcfce7"
                       : connHighlight === "#8250df" ? "#f3e8ff"
                       : null;
    return (
        <g onClick={e => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            <g transform={transform}>
                <rect x={hitX} y={hitY} width={hitW} height={hitH} fill="transparent" stroke="none" pointerEvents="all" />
            </g>
            {connTintFill && <g transform={transform} pointerEvents="none">
                <rect x={el.variant.minX - 1} y={el.variant.minY - 1} width={(el.variant.maxX - el.variant.minX) + 2} height={(el.variant.maxY - el.variant.minY) + 2} fill={connTintFill} stroke={selected ? "#d1242f" : connHighlight} strokeWidth={selected ? 0.8 : 0.5} opacity={0.55} vectorEffect="non-scaling-stroke" />
            </g>}
            {hlColor && <g transform={transform} pointerEvents="none">{el.variant.primitives.map((p, i) => highlightPrimitive(p, `hl_${el.key}_${i}`, hlColor))}</g>}
            <g transform={transform} pointerEvents="none">
                {el.variant.primitives.map((p, i) => renderPrimitive(p, `${el.key}_${i}`, null, symbolStrokeMult))}
                {hlColor && <rect x={el.variant.minX - 0.8} y={el.variant.minY - 0.8} width={(el.variant.maxX - el.variant.minX) + 1.6} height={(el.variant.maxY - el.variant.minY) + 1.6} fill="none" stroke={hlColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </g>
        </g>
    );
}

function PrimitiveGraphic({ el, selected, connHighlight, onSelect, nodePosMap, boostPct, boostSymbolOutlines, showProfileLabels }) {
    const hitPad = 2.0;
    const hlColor = selected ? (connHighlight || selectionColor(el.elementRole)) : connHighlight || null;
    const prim = el.primitive;
    return (
        <g onClick={e => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            {prim?.kind === "circle" && <circle cx={prim.center.x} cy={prim.center.y} r={prim.radius + hitPad} fill="transparent" stroke="none" pointerEvents="all" />}
            {prim?.kind === "ellipse" && <ellipse cx={prim.center.x} cy={prim.center.y} rx={prim.rx + hitPad} ry={prim.ry + hitPad} fill="transparent" stroke="none" pointerEvents="all" />}
            {prim?.kind === "rect" && <rect x={prim.center.x - prim.width / 2 - hitPad} y={prim.center.y - prim.height / 2 - hitPad} width={prim.width + hitPad * 2} height={prim.height + hitPad * 2} fill="transparent" stroke="none" pointerEvents="all" />}
            {(prim?.kind === "polyline" || prim?.kind === "polygon") && <polyline points={prim.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((prim.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />}
            {el.kind === "connectorLine" && (() => {
                const s = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
                const t = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
                const pts = [s, ...prim.innerPoints, t].filter(Boolean);
                if (pts.length < 2) return null;
                return <polyline points={pts.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((prim.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />;
            })()}
            {hlColor && el.kind !== "connectorLine" && prim?.kind !== "text" && highlightPrimitive(prim, `hl_${el.key}`, hlColor)}
            {el.kind === "connectorLine"
                ? <ConnectorLineSvg el={el} nodePosMap={nodePosMap} selected={selected} connColor={connHighlight} boostPct={boostPct} />
                : SIGNAL_MARK_HIDE_LINE_TYPES.has(el.signalConveyingType)
                    ? null
                    : (prim?.kind === "polyline" && el.elementRole === "connector" && !selected)
                        ? <ConnectorPolyline prim={prim} boostPct={boostPct} />
                        : renderPrimitive(prim, el.key, prim?.kind === "text" ? hlColor : null, (boostSymbolOutlines && el.elementRole === "symbol") ? boostPct / 100 : 1, showProfileLabels)}
            {prim?.kind === "polyline" && el.signalConveyingType && SIGNAL_CONVEYING_MARKS[el.signalConveyingType] && (
                <SignalConveyingMarks points={prim.points} markKey={SIGNAL_CONVEYING_MARKS[el.signalConveyingType]}
                    color={selected ? (connHighlight || selectionColor(el.elementRole)) : (connHighlight || prim.stroke.color)} />
            )}
        </g>
    );
}

// ---------- Tree Node --------------------------------------------------------

function TreeNode({ node, selectedId, onSelect, expanded, setExpanded, level }) {
    const isOpen = expanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedId === node.objectId;
    return (
        <div>
            <div
                id={node.objectId ? `tree-node-${node.objectId}` : undefined}
                onClick={() => { if (!node.objectId) return; onSelect(node.objectId); }}
                style={{ padding: "3px 8px", paddingLeft: 8 + level * 14, background: isSelected ? "#dbeafe" : "transparent", cursor: "pointer", borderRadius: 4, marginBottom: 1, display: "flex", alignItems: "center", gap: 5 }}
            >
                <span onClick={e => { e.stopPropagation(); if (!hasChildren) return; setExpanded(prev => { const n = new Set(prev); n.has(node.id) ? n.delete(node.id) : n.add(node.id); return n; }); }} style={{ width: 14, display: "inline-block", textAlign: "center", flexShrink: 0, color: "#888" }}>
                    {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
                </span>
                <span style={{ fontWeight: isSelected ? 700 : 400, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
                <span style={{ fontSize: 10, color: node.type.startsWith("Plant/Unmapped.") ? "#cf222e" : "#aaa", fontWeight: 400, flexShrink: 0, marginLeft: "auto" }} title={node.type}>{node.type.split(".").pop()}</span>
            </div>
            {isOpen && node.children.map(child => (
                <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} expanded={expanded} setExpanded={setExpanded} level={level + 1} />
            ))}
        </div>
    );
}

// ---------- App --------------------------------------------------------------

export default function App() {
    const [leftCollapsed, setLeftCollapsed] = useState(false);
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftTab, setLeftTab] = useState("topology");
    const [rightTab, setRightTab] = useState("details");
    const [xsdStatus, setXsdStatus] = useState("idle"); // idle | running | done | error
    const [xsdResult, setXsdResult] = useState(null); // { valid, errors, rawOutput }
    const [xsdError, setXsdError] = useState("");
    const [mainXmlText, setMainXmlText] = useState("");
    const [discXmlText, setDiscXmlText] = useState("");
    const [mainFileLoaded, setMainFileLoaded] = useState(false);
    const [discFileLoaded, setDiscFileLoaded] = useState(false);
    const [mainFileName, setMainFileName] = useState("");
    const [discFileName, setDiscFileName] = useState("");
    const [parsed, setParsed] = useState(null);
    const [parseError, setParseError] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState(new Set());
    const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1000, h: 1000 });
    const [fullBounds, setFullBounds] = useState({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState(null);
    const [bgImage, setBgImage] = useState(null);
    const [showBgControls, setShowBgControls] = useState(false);
    // Draw-order override ("Send to Back"): view-only, session-scoped set of represented-object ids moved to the front of the paint order.
    // Reset when a file is (re)loaded. Never written to the parsed model or source XML.
    const [zOrderOverrides, setZOrderOverrides] = useState(new Set());
    // Object URL for the currently loaded BG image, tracked in a ref so it can be revoked on replacement or removal.
    const bgObjectUrlRef = useRef(null);
    // Connectivity checkbox: when checked, shows the upstream/downstream/group highlight for the selected object.
    // Gates connectivityHighlight below and the legend near the drawing canvas.
    const [showConnectivity, setShowConnectivity] = useState(false);
    // Whether selecting an object also highlights (red) its sub-components in the drawing, or just the object itself. Default false.
    const [selectHighlightSubComponents, setSelectHighlightSubComponents] = useState(false);
    // Line Boost: percentage multiplier on connector/centerline stroke width. 100 = unchanged.
    const [lineBoostPct, setLineBoostPct] = useState(100);
    const [boostSymbolOutlines, setBoostSymbolOutlines] = useState(false);
    // "Profile labels" checkbox. Default off: a DiscProfile-catalogued symbol's label shows the catalog's attribute-resolved LabelTemplate value instead of its literal exported text; other labels are unaffected.
    // Checked: every catalogued symbol's own <Label> text is hidden, and its LabelTemplate(s) are drawn instead as "lbltpl_"-prefixed overlays.
    const [showProfileLabels, setShowProfileLabels] = useState(false);
    const [showAllAttributes, setShowAllAttributes] = useState(false); // default: hide non-DEXPI attributes
    const [spaceDown, setSpaceDown] = useState(false);
    const [rdlStatus, setRdlStatus] = useState("idle"); // idle | running | done
    const [rdlResult, setRdlResult] = useState(null);
    // Validation codes currently folded (collapsed) in the unified Validation tab. A code not in this set renders expanded.
    // Reset whenever either engine's result changes.
    const [collapsedValidationCodes, setCollapsedValidationCodes] = useState(new Set());
    // Per-validation-code severity overrides (Error/Warning/Info), edited via the Config tab. Object keyed by code; no entry means use the default.
    const [severityConfig, setSeverityConfig] = useState({});
    // "All" | "Error" | "Warning" | "Info" - which severities are shown in the Validation tab's issue list.
    const [validationFilter, setValidationFilter] = useState("All");
    // Folder validation result: every XML in a picked folder, run through the same two engines. Null until a run has finished.
    const [folderResults, setFolderResults] = useState(null);
    const [folderProgress, setFolderProgress] = useState(null); // { done, total, name }
    const [folderFilter, setFolderFilter] = useState("All");
    const [folderName, setFolderName] = useState("");
    const [collapsedFolderFiles, setCollapsedFolderFiles] = useState(new Set());
    // Drill-down overlay over the folder run: Layer -> Category -> Code -> documents -> lines.
    const [explorerOpen, setExplorerOpen] = useState(false);
    // Startup fetch of DEFAULT_PROFILE_URL: "loading" | "loaded" | "error".
    const [defaultProfileState, setDefaultProfileState] = useState("loading");

    // Read by the startup profile fetch, which resolves after these have moved on.
    const mainXmlRef = useRef(""); mainXmlRef.current = mainXmlText;
    const discLoadedRef = useRef(false); discLoadedRef.current = discFileLoaded;

    const mainInputRef = useRef(null);
    const discInputRef = useRef(null);
    const bgInputRef = useRef(null);
    const folderInputRef = useRef(null);
    // Picked files kept by path, so a file can be reopened from its row in the Folder tab without re-picking the folder.
    const folderFilesRef = useRef(new Map());
    const folderCancelRef = useRef(false);
    const folderPngInputRef = useRef(null);
    const folderElemInputRef = useRef(null);
    const elemCancelRef = useRef(false);
    const pngCancelRef = useRef(false);
    // True while Save PNG… renders each file through the viewer; skips auto-validation and the BG overlay.
    const batchPngRef = useRef(false);
    const svgViewportRef = useRef(null);
    const svgElRef = useRef(null);
    const [exporting, setExporting] = useState(false);
    const [batchPng, setBatchPng] = useState(false);
    const [pngProgress, setPngProgress] = useState(null);
    const [pngResult, setPngResult] = useState(null);
    const [elemProgress, setElemProgress] = useState(null);

    const connectivityHighlight = useMemo(() => {
        if (!showConnectivity || !selectedId || !parsed?.connectivityMap) return { upstream: new Set(), downstream: new Set(), group: new Set() };
        return parsed.connectivityMap.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
    }, [showConnectivity, selectedId, parsed]);

    // DEXPI validation (rdlValidate.js): cross-references the file against the static DEXPI 1.4 model and the loaded DiscProfile.xml.
    // Runs itself whenever a file is parsed (see below); the toolbar's "Run Validation" button re-runs it on demand.
    // Runs via setTimeout(…, 0) so the "running" state renders before the (synchronous) check executes.
    const runRdlValidation = useCallback(() => {
        if (!parsed?.mainDoc) { setRdlStatus("idle"); setRdlResult(null); return; }
        setRdlStatus("running");
        setTimeout(() => {
            try {
                const result = validateAgainstRdl(parsed.mainDoc, parsed.discDoc, parsed.connectivityMap);
                setRdlResult(result);
            } catch (e) {
                console.error("DEXPI validation failed:", e);
                setRdlResult(null);
            } finally {
                setRdlStatus("done");
            }
        }, 0);
    }, [parsed]);

    // Refolds every validation code ("Collapse all") whenever xsdResult or rdlResult changes.
    useEffect(() => {
        const codes = new Set();
        (xsdResult?.errors || []).forEach(e => { if (e.issueCode) codes.add(e.issueCode); });
        (rdlResult?.findings || []).forEach(f => { if (f.code) codes.add(f.code); });
        setCollapsedValidationCodes(codes);
    }, [xsdResult, rdlResult]);

    // Every newly parsed file validates itself, so the Validation tab is populated by the time
    // the drawing is on screen. Re-parsing on a profile change re-validates against that profile.
    useEffect(() => {
        if (batchPngRef.current) return;
        if (!parsed?.mainDoc) { setRdlStatus("idle"); setRdlResult(null); return; }
        runRdlValidation();
    }, [parsed, runRdlValidation]);

    // The schema stage depends on the file text alone, so it re-runs only when that changes.
    useEffect(() => {
        if (mainXmlText) runXsdValidation(mainXmlText);
        else { setXsdStatus("idle"); setXsdResult(null); setXsdError(""); }
    }, [mainXmlText]);

    // Re-runs both engines on the loaded file. Each keeps its own status/result (xsdStatus/rdlStatus), both feeding the unified Validation tab.
    function runAllValidation() {
        runXsdValidation(mainXmlText);
        runRdlValidation();
    }
    // Resolves source lines for findings that don't carry one of their own; rebuilt when the loaded file changes.
    const lineOf = useMemo(() => buildLineResolver(mainXmlText), [mainXmlText]);

    // Unified issue list: merges xsdResult.errors and rdlResult.findings into one shape used by the Validation tab, Config tab, and Details pane.
    // Each issue's severity is resolved here (default per code, overridable via severityConfig).
    const allIssues = useMemo(() => {
        const list = [];
        // A schema message with no matching issueCode is shown under a null code rather than dropped or reassigned.
        (xsdResult?.errors || []).forEach((err, i) => {
            const code = err.issueCode || "SER-VAL-01";
            list.push({
                key: `xsd-${i}`, source: "xsd",
                code, codeLabel: VALIDATION_CODE_LABELS[code] || err.codeLabel,
                message: err.message, objectId: null,
                line: err.line ?? lineOf({ message: err.message }),
            });
        });
        // rdlValidate.js findings are already coded; nothing to map here.
        (rdlResult?.findings || []).forEach((f, i) => {
            list.push({
                key: `rdl-${i}`, source: "rdl",
                code: f.code, codeLabel: VALIDATION_CODE_LABELS[f.code] || f.code,
                message: f.message, objectId: f.objectId || null, line: lineOf(f),
            });
        });
        return list.map(issue => ({
            ...issue,
            severity: resolveValidationSeverity(issue.code, severityConfig),
        }));
    }, [xsdResult, rdlResult, severityConfig, lineOf]);

    // Every validation code seen in the current run, alphabetically; drives the Config tab's per-code severity editor.
    const allValidationCodes = useMemo(() => [...new Set(allIssues.map(i => i.code))].sort(), [allIssues]);

    // Per-severity counts across all issues; powers the All/Error/Warning/Info filter chips.
    const issueCounts = useMemo(() => {
        const c = { error: 0, warning: 0, info: 0 };
        allIssues.forEach(i => { c[i.severity] = (c[i.severity] || 0) + 1; });
        return c;
    }, [allIssues]);

    const filteredIssues = useMemo(() => (
        validationFilter === "All" ? allIssues : allIssues.filter(i => SEV_LABELS[i.severity] === validationFilter)
    ), [allIssues, validationFilter]);

    // code -> issue[], in first-seen order, built from the filtered list; powers the per-code expand/collapse groups.
    const issuesByCode = useMemo(() => {
        const map = new Map();
        filteredIssues.forEach(issue => {
            if (!map.has(issue.code)) map.set(issue.code, []);
            map.get(issue.code).push(issue);
        });
        return map;
    }, [filteredIssues]);

    // objectId -> issue[]; powers the Details pane's Issues tab. Only includes issues whose objectId resolves to a node in the topology.
    const issuesByObjectId = useMemo(() => {
        const map = new Map();
        allIssues.forEach(issue => {
            if (!issue.objectId || !parsed?.treeMap?.has(issue.objectId)) return;
            if (!map.has(issue.objectId)) map.set(issue.objectId, []);
            map.get(issue.objectId).push(issue);
        });
        return map;
    }, [allIssues, parsed]);

    // Folder findings flattened into one list, with the Config tab's severity overrides applied.
    const folderIssues = useMemo(() => {
        if (!folderResults) return [];
        const out = [];
        folderResults.forEach(r => (r.findings || []).forEach((f, i) => out.push({
            ...f,
            key: `${r.path}#${i}`,
            path: r.path,
            codeLabel: VALIDATION_CODE_LABELS[f.code] || f.code,
            severity: resolveValidationSeverity(f.code, severityConfig),
        })));
        return out;
    }, [folderResults, severityConfig]);

    const folderCounts = useMemo(() => {
        const c = { error: 0, warning: 0, info: 0 };
        folderIssues.forEach(i => { c[i.severity] = (c[i.severity] || 0) + 1; });
        return c;
    }, [folderIssues]);

    // path -> issues, filtered by the Folder tab's type chips. Files with nothing left are dropped.
    const folderByFile = useMemo(() => {
        const map = new Map();
        folderIssues.forEach(i => {
            if (folderFilter !== "All" && SEV_LABELS[i.severity] !== folderFilter) return;
            if (!map.has(i.path)) map.set(i.path, []);
            map.get(i.path).push(i);
        });
        return map;
    }, [folderIssues, folderFilter]);

    function rebuild(nextMain, nextDisc) {
        // A DiscProfile.xml is optional; only the main Proteus/DEXPI 1.4 XML is required to draw anything.
        if (!nextMain) return;
        try {
            const p = parseProteusPackage(nextMain, nextDisc);
            const b = boundsFromElements(p.graphics);
            setFullBounds(b);
            setParsed(p);
            setSelectedId(p.tree.objectId);
            setExpanded(new Set([p.tree.id, ...p.tree.children.slice(0, 5).map(c => c.id)]));
            setViewBox({ x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) });
            setParseError("");
            // Loading (or re-parsing) a file resets draw-order overrides.
            setZOrderOverrides(new Set());
        } catch (e) { setParseError(e.message || String(e)); }
    }

    async function handleMainFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setMainXmlText(txt); setMainFileLoaded(true);
        setMainFileName(file.name);
        setXsdStatus("idle"); setXsdResult(null); setXsdError("");
        rebuild(txt, discXmlText);
    }

    // xmlText is passed explicitly by the callers holding the just-read text; the `mainXmlText` state covers the rest.
    async function runXsdValidation(xmlText) {
        const text = xmlText ?? mainXmlText;
        if (!text) return;
        setXsdStatus("running"); setXsdError("");
        try {
            const result = await validateProteusXsd(text);
            setXsdResult(result);
            setXsdStatus("done");
        } catch (e) {
            setXsdError(e.message || String(e));
            setXsdStatus(e.schemaCompileError ? "schema-incompatible" : "error");
        }
    }
    // Directory picker where the browser has one, otherwise the folder input.
    async function handleFolderButton() {
        if (!supportsDirectoryPicker()) { folderInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectory();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runFolderValidation(picked.files, picked.name);
    }

    // Fallback path: <input webkitdirectory>.
    function handleFolderPick(e) {
        const picked = pickXmlFiles(e.target.files);
        const first = picked[0]?.webkitRelativePath || "";
        if (folderInputRef.current) folderInputRef.current.value = "";
        runFolderValidation(picked, first.includes("/") ? first.split("/")[0] : "");
    }

    // Save PNG…: writes <name>.png next to each .xml when the browser can write to the folder, otherwise downloads each PNG.
    async function handleSavePngButton() {
        if (!supportsDirectoryPicker()) { folderPngInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectoryForWrite();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderPngInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runFolderPng(picked.files, picked.name, picked.dirHandle);
    }

    function handleFolderPngPick(e) {
        const picked = pickXmlFiles(e.target.files);
        const first = picked[0]?.webkitRelativePath || "";
        if (folderPngInputRef.current) folderPngInputRef.current.value = "";
        runFolderPng(picked, first.includes("/") ? first.split("/")[0] : "", null);
    }

    const nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Renders each file through the drawing view, then restores the file that was open before.
    async function runFolderPng(files, name, dirHandle) {
        setLeftTab("folder");
        setPngResult(null);
        if (!files.length) { setPngResult({ folder: name, total: 0, saved: 0, failed: [], downloaded: !dirHandle }); return; }
        const prevText = mainXmlRef.current;
        pngCancelRef.current = false;
        batchPngRef.current = true;
        setBatchPng(true);
        const failed = [];
        let saved = 0;
        try {
            for (let i = 0; i < files.length; i++) {
                if (pngCancelRef.current) break;
                const file = files[i];
                const rel = file.relPath || file.webkitRelativePath || file.name;
                setPngProgress({ done: i, total: files.length, name: rel });
                try {
                    const p = parseProteusPackage(await file.text(), discXmlText);
                    const b = boundsFromElements(p.graphics);
                    setFullBounds(b);
                    setParsed(p);
                    setSelectedId(null);
                    setZOrderOverrides(new Set());
                    const vb = { x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) };
                    setViewBox(vb);
                    const want = `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
                    for (let f = 0; f < 60; f++) {
                        await nextPaint();
                        if (svgElRef.current?.getAttribute("viewBox") === want) break;
                    }
                    const canvas = await renderViewboxToCanvas({ matchScreenStrokes: true });
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
                    if (!blob) throw new Error("PNG encoding failed.");
                    if (dirHandle) await writeFileAt(dirHandle, pngPathFor(rel), blob);
                    else downloadBlob(blob, pngPathFor(file.name));
                    saved++;
                } catch (err) {
                    failed.push({ path: rel, error: err.message || String(err) });
                }
            }
        } finally {
            batchPngRef.current = false;
            setBatchPng(false);
            setPngProgress(null);
            if (prevText) rebuild(prevText, discXmlText);
            else setParsed(null);
        }
        setPngResult({ folder: name, total: files.length, saved, failed, downloaded: !dirHandle, cancelled: pngCancelRef.current });
    }

    // Export Element…: classes and DEXPI attributes used per file, as an .xlsx download.
    async function handleExportElementButton() {
        if (!supportsDirectoryPicker()) { folderElemInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectory();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderElemInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runExportElements(picked.files, picked.name);
    }

    function handleFolderElemPick(e) {
        const picked = pickXmlFiles(e.target.files);
        const first = picked[0]?.webkitRelativePath || "";
        if (folderElemInputRef.current) folderElemInputRef.current.value = "";
        runExportElements(picked, first.includes("/") ? first.split("/")[0] : "");
    }

    async function runExportElements(files, name) {
        setLeftTab("folder");
        if (!files.length) { alert("No .xml files found in that folder."); return; }
        elemCancelRef.current = false;
        setElemProgress({ done: 0, total: files.length, name: "" });
        try {
            const sheets = await collectFolderElements(files, discXmlText, {
                onProgress: setElemProgress,
                isCancelled: () => elemCancelRef.current,
            });
            const base = (name || "folder").replace(/[\\/:*?"<>|]+/g, "_");
            downloadBlob(buildXlsxBlob(sheets), `${base}-elements.xlsx`);
        } catch (err) {
            alert("Export Element failed: " + (err.message || String(err)));
        } finally {
            setElemProgress(null);
        }
    }

    // Validates every .xml found, against the currently loaded profile.
    async function runFolderValidation(files, name) {
        setLeftTab("folder");
        setFolderName(name || "");
        if (!files.length) { setFolderResults([]); setFolderProgress(null); return; }
        // Without a profile the PRF and GEO codes, and every DISC-scoped check,
        // produce nothing - confirm before running the whole folder that way.
        if (!discFileLoaded) {
            const go = window.confirm(
                `No DiscProfile.xml is loaded.\n\n` +
                `${files.length} file${files.length === 1 ? "" : "s"} will be checked against the XSD schema and the DEXPI 1.4 model only. ` +
                `The profile-dependent codes (PRF, GEO and the DISC-scoped checks) will not be evaluated and will report nothing.\n\n` +
                `Validate anyway?`
            );
            if (!go) { setFolderProgress(null); return; }
        }
        folderFilesRef.current = new Map(files.map(f => [f.relPath || f.webkitRelativePath || f.name, f]));
        folderCancelRef.current = false;
        setFolderResults(null);
        setFolderProgress({ done: 0, total: files.length, name: files[0].name });
        const results = await validateFiles(files, discXmlText, {
            onProgress: setFolderProgress,
            isCancelled: () => folderCancelRef.current,
        });
        setFolderResults(results);
        setFolderProgress(null);
        setCollapsedFolderFiles(new Set(results.map(r => r.path)));
    }

    // Loads one of the folder's files into the viewer itself.
    async function openFolderFile(path) {
        const file = folderFilesRef.current.get(path);
        if (!file) return;
        const txt = await file.text();
        setMainXmlText(txt); setMainFileLoaded(true); setMainFileName(file.name);
        setXsdStatus("idle"); setXsdResult(null); setXsdError("");
        rebuild(txt, discXmlText);
        setLeftTab("topology");
    }

    // Report rows for the loaded file, in the same layout as the folder run.
    function singleFileReportRows() {
        const tagById = buildTagIndex(parsed?.mainDoc);
        const findings = allIssues.map(i => ({
            code: i.code,
            message: i.message,
            objectId: i.objectId || "",
            line: i.line,
            location: i.source === "xsd"
                ? locationFromXsd(i.message)
                : locationFromModel(tagById.get(i.objectId), i.message),
        }));
        return buildReportRows(
            [{ path: mainFileName || "validation", findings }],
            code => SEV_LABELS[resolveValidationSeverity(code, severityConfig)]
        );
    }

    function folderReportRows() {
        return buildFolderReport(folderResults || [], code => SEV_LABELS[resolveValidationSeverity(code, severityConfig)]);
    }
    function downloadFolderXlsx() {
        const { columns, rows } = folderReportRows();
        downloadBlob(buildXlsxBlob([{ name: "Findings", columns, rows }]), "folder-validation.xlsx");
    }
    function downloadFolderCsv() {
        const { columns, rows } = folderReportRows();
        downloadCSV(rows, columns.map(c => c.header), "folder-validation.csv");
    }

    // Fetches the shared DiscProfile.xml. Runs once at startup and again from the
    // "Retry" button; a profile already loaded by hand is left alone.
    const loadDefaultProfile = useCallback(async () => {
        setDefaultProfileState("loading");
        try {
            const res = await fetch(DEFAULT_PROFILE_URL, { cache: "no-cache" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const txt = await res.text();
            if (discLoadedRef.current) { setDefaultProfileState("loaded"); return; }
            setDiscXmlText(txt); setDiscFileLoaded(true); setDiscFileName(DEFAULT_PROFILE_NAME);
            setDefaultProfileState("loaded");
            if (mainXmlRef.current) rebuild(mainXmlRef.current, txt);
        } catch (e) {
            console.warn("Default DiscProfile.xml could not be loaded:", e);
            setDefaultProfileState("error");
        }
    }, []);

    useEffect(() => { loadDefaultProfile(); }, [loadDefaultProfile]);

    async function handleDiscFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setDiscXmlText(txt); setDiscFileLoaded(true);
        setDiscFileName(file.name);
        rebuild(mainXmlText, txt);
    }
    // Unloads the DiscProfile.xml and redraws the already-loaded Proteus file without one.
    // Clears the file input's value so picking the same file again still fires onChange.
    function clearDiscFile() {
        setDiscXmlText(""); setDiscFileLoaded(false); setDiscFileName("");
        if (discInputRef.current) discInputRef.current.value = "";
        rebuild(mainXmlText, "");
    }
    async function handleBgFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const isPng = isPngBytes(bytes);
            // Looks for a placement embedded in this PNG's metadata and uses it in place of the auto-fit default when present.
            const embedded = isPng ? readPngEmbeddedPlacement(bytes) : null;
            const placement = embedded || { scale: 1, offsetX: 0, offsetY: 0 };

            if (bgObjectUrlRef.current) URL.revokeObjectURL(bgObjectUrlRef.current);
            const src = URL.createObjectURL(new Blob([bytes], { type: file.type || (isPng ? "image/png" : "") }));
            bgObjectUrlRef.current = src;

            // Loads the image's raw pixel dimensions so the overlay can be fit into the drawing's coordinate space, preserving aspect ratio.
            const probe = new Image();
            const base = {
                // BG Image Default Placement: a newly loaded BG image starts centered (blend 0).
                src, blend: 0, scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY, visible: true,
                // sourceBytes/isPng/fileName/embeddedPlacement support the Clear/Download-default controls; see clearBgDefault()/downloadBgPlacementPng().
                sourceBytes: bytes, isPng, fileName: file.name, embeddedPlacement: embedded,
            };
            probe.onload = () => setBgImage({ ...base, naturalWidth: probe.naturalWidth, naturalHeight: probe.naturalHeight });
            probe.onerror = () => setBgImage({ ...base, naturalWidth: 0, naturalHeight: 0 });
            probe.src = src;
        } catch (err) {
            alert("Could not read the selected image: " + (err.message || String(err)));
        }
        e.target.value = "";
    }

    // Embeds the current Scale/X/Y into a copy of the loaded PNG's bytes and downloads it. The original file is never modified.
    function downloadBgPlacementPng() {
        if (!bgImage?.isPng || !bgImage.sourceBytes) return;
        try {
            const placement = { scale: bgImage.scale, offsetX: bgImage.offsetX, offsetY: bgImage.offsetY };
            const updated = writePngEmbeddedPlacement(bgImage.sourceBytes, placement);
            const blob = new Blob([updated], { type: "image/png" });
            const base = (bgImage.fileName || "background").replace(/\.png$/i, "");
            downloadBlob(blob, `${base}-placement.png`);
            setBgImage(b => b && ({ ...b, sourceBytes: updated, embeddedPlacement: placement }));
        } catch (err) {
            alert("Could not save the placement into the PNG: " + (err.message || String(err)));
        }
    }

    // Removes the embedded placement from the in-memory PNG bytes and downloads the result. Does not change the currently displayed placement.
    function clearBgDefault() {
        if (!bgImage?.isPng || !bgImage.sourceBytes) return;
        try {
            const updated = png_stripPlacementChunk(bgImage.sourceBytes);
            const blob = new Blob([updated], { type: "image/png" });
            const base = (bgImage.fileName || "background").replace(/\.png$/i, "");
            downloadBlob(blob, `${base}-placement.png`);
            setBgImage(b => b && ({ ...b, sourceBytes: updated, embeddedPlacement: null }));
        } catch (err) {
            alert("Could not clear the embedded placement: " + (err.message || String(err)));
        }
    }

    // Export: rasterizes what's on screen inside the SVG viewport (drawing plus BG image overlay) by cloning the <svg> node.
    // Targets a fixed output resolution (long edge in px) rather than scaling the viewBox's native units directly, regardless of their magnitude.
    const EXPORT_LONG_EDGE_PX = 3000;

    async function renderViewboxToCanvas(opts = {}) {
        const svgEl = svgElRef.current;
        if (!svgEl) throw new Error("Drawing is not ready yet.");
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const vb = svgEl.viewBox?.baseVal;
        const aspect = vb && vb.width > 0 && vb.height > 0 ? vb.width / vb.height : viewBox.w / viewBox.h;
        const pxW = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX : EXPORT_LONG_EDGE_PX * aspect));
        const pxH = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX / aspect : EXPORT_LONG_EDGE_PX));
        clone.setAttribute("width", String(pxW));
        clone.setAttribute("height", String(pxH));
        // Line widths are non-scaling (screen pixels); scale them so the PNG keeps the on-screen line weight, Line Boost included.
        if (opts.matchScreenStrokes && vb && vb.width > 0 && svgEl.clientWidth > 0 && svgEl.clientHeight > 0) {
            const screenScale = Math.min(svgEl.clientWidth / vb.width, svgEl.clientHeight / vb.height);
            const ratio = (pxW / vb.width) / screenScale;
            if (Number.isFinite(ratio) && ratio > 0) {
                clone.querySelectorAll('[vector-effect="non-scaling-stroke"]').forEach(n => {
                    const w = parseFloat(n.getAttribute("stroke-width"));
                    n.setAttribute("stroke-width", String((Number.isFinite(w) ? w : 1) * ratio));
                });
            }
        }

        const svgStr = new XMLSerializer().serializeToString(clone);
        const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error("Could not rasterize the drawing for export."));
                im.src = url;
            });
            const canvas = document.createElement("canvas");
            canvas.width = pxW;
            canvas.height = pxH;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff"; // the viewport's own background - SVG itself is transparent
            ctx.fillRect(0, 0, pxW, pxH);
            ctx.drawImage(img, 0, 0, pxW, pxH);
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function exportFileBaseName() {
        return (parsed?.meta?.drawingNumber || "dexpi-drawing").replace(/[\\/:*?"<>|]+/g, "_");
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }

    // CSV export for the unified Validation tab.
    function downloadCSV(rows, headers, filename) {
        const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const csv = [headers.join(","), ...rows.map(r => r.map(escape).join(","))].join("\r\n");
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), filename);
    }

    // Config tab: per-code severity overrides, held in plain React state (not persisted) unless exported/re-imported as JSON.
    function updateSeverity(code, level) {
        setSeverityConfig(prev => {
            const next = { ...prev };
            if (level === null) delete next[code];
            else next[code] = level;
            return next;
        });
    }
    function exportSeverityConfig() {
        // Exports the full effective config for every code seen in the current run.
        const full = {};
        allValidationCodes.forEach(code => { full[code] = resolveValidationSeverity(code, severityConfig); });
        downloadBlob(new Blob([JSON.stringify(full, null, 2)], { type: "application/json" }), "validation-severity-config.json");
    }
    async function importSeverityConfig(e) {
        const file = e.target.files?.[0]; if (!file) return;
        try {
            setSeverityConfig(JSON.parse(await file.text()));
        } catch (_) {
            alert("Invalid config file.");
        }
        e.target.value = "";
    }

    async function exportAsPng() {
        setExporting(true);
        try {
            const canvas = await renderViewboxToCanvas();
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
            downloadBlob(blob, `${exportFileBaseName()}.png`);
        } catch (e) {
            alert(e.message || String(e));
        } finally {
            setExporting(false);
        }
    }

    async function exportAsPdf() {
        setExporting(true);
        try {
            const canvas = await renderViewboxToCanvas();
            const jpegData = canvas.toDataURL("image/jpeg", 0.95);
            // Page size matches the exported canvas's aspect ratio (long edge fixed at 420mm/A3).
            const aspect = canvas.width / canvas.height;
            const longEdgeMm = 420;
            const wMm = aspect >= 1 ? longEdgeMm : longEdgeMm * aspect;
            const hMm = aspect >= 1 ? longEdgeMm / aspect : longEdgeMm;
            const pdf = new jsPDF({ orientation: aspect >= 1 ? "landscape" : "portrait", unit: "mm", format: [wMm, hMm] });
            pdf.addImage(jpegData, "JPEG", 0, 0, wMm, hMm);
            pdf.save(`${exportFileBaseName()}.pdf`);
        } catch (e) {
            alert(e.message || String(e));
        } finally {
            setExporting(false);
        }
    }

    const filteredTree = useMemo(() => {
        if (!parsed) return null;
        const q = search.trim().toLowerCase();
        if (!q) return parsed.tree;
        const filter = node => {
            const terms = [node.label, node.objectId, node.type, node.tagName, ...node.persistentIdentifiers.map(p => p.value)].filter(Boolean);
            const match = terms.some(v => String(v).toLowerCase().includes(q));
            const children = node.children.map(filter).filter(Boolean);
            return match || children.length ? { ...node, children } : null;
        };
        return filter(parsed.tree);
    }, [parsed, search]);

    const selectedNode = useMemo(() => parsed?.treeMap?.get(selectedId) || null, [parsed, selectedId]);
    const selectedRepresentedIds = useMemo(() => {
        if (!selectedNode) return new Set();
        // Sub-components checkbox gates highlighting beyond the selected object. Off: only the selected node is highlighted.
        // On: tree descendants plus non-connectivity Association/ref targets are included too.
        if (!selectHighlightSubComponents) {
            return new Set(selectedNode.objectId ? [selectedNode.objectId] : []);
        }
        const ids = collectDescendantObjectIds(selectedNode);
        // Connectivity refs (upstream/downstream/group) and Segment/System containment refs are excluded here; they drive separate highlighting elsewhere, not selection highlighting.
        selectedNode.refs
            .filter(ref => !isConnectivityRefProperty(ref.property)
                && !SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES.has(ref.property)
                && !TREE_CONTAINMENT_REF_PROPERTIES.has(ref.property))
            .forEach(ref => ref.objects.forEach(id => { if (id) ids.add(id); }));
        return ids;
    }, [selectedNode, selectHighlightSubComponents]);

    // Every represented-object id with at least one associated graphic element in the current drawing; gates the "Send to Back" control.
    const representedIdsWithGraphics = useMemo(() => {
        const s = new Set();
        parsed?.graphics?.elements?.forEach(el => { if (el.representedId) s.add(el.representedId); });
        return s;
    }, [parsed]);

    // Paint-order list handed to the renderer: elements in zOrderOverrides move to the front of the array (drawn first, ends up behind everything else), stable within each group.
    const paintOrderElements = useMemo(() => {
        const all = parsed?.graphics?.elements;
        if (!all) return [];
        if (zOrderOverrides.size === 0) return all;
        const sentToBack = [];
        const rest = [];
        all.forEach(el => {
            if (el.representedId && zOrderOverrides.has(el.representedId)) sentToBack.push(el);
            else rest.push(el);
        });
        return [...sentToBack, ...rest];
    }, [parsed, zOrderOverrides]);

    // Toggles "Send to Back" for the currently selected object only, without touching selection or highlighting.
    const toggleSendToBack = useCallback(() => {
        if (!selectedId) return;
        setZOrderOverrides(prev => {
            const next = new Set(prev);
            if (next.has(selectedId)) next.delete(selectedId);
            else next.add(selectedId);
            return next;
        });
    }, [selectedId]);

    const handleSelect = useCallback((id) => {
        if (!id) return;
        setSelectedId(id);
        setSearch("");
        if (parsed) {
            const ancestors = findAncestors(parsed.tree, id);
            setExpanded(prev => new Set([...prev, ...ancestors]));
        }
    }, [parsed]);

    useEffect(() => {
        if (!selectedId) return;
        const h = requestAnimationFrame(() => { document.getElementById(`tree-node-${selectedId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
        return () => cancelAnimationFrame(h);
    }, [selectedId]);

    useEffect(() => {
        const el = svgViewportRef.current;
        if (!el) return;
        const onWheel = e => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const factor = e.deltaY > 0 ? 1.12 : 0.88;
            const mx = ((e.clientX - rect.left) / rect.width) * viewBox.w + viewBox.x;
            const my = ((e.clientY - rect.top) / rect.height) * viewBox.h + viewBox.y;
            setViewBox(v => clampViewBox({ x: mx - (mx - v.x) * factor, y: my - (my - v.y) * factor, w: v.w * factor, h: v.h * factor }, fullBounds));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [fullBounds]);

    useEffect(() => {
        const onKeyDown = e => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); setSpaceDown(true); } };
        const onKeyUp   = e => { if (e.code === "Space") { setSpaceDown(false); setIsPanning(false); setPanStart(null); } };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
    }, []);

    // Revokes the current BG image object URL when the app unmounts.
    useEffect(() => {
        return () => { if (bgObjectUrlRef.current) URL.revokeObjectURL(bgObjectUrlRef.current); };
    }, []);

    function expandAll() { if (!parsed) return; const ids = new Set(); flattenTree(parsed.tree).forEach(n => ids.add(n.id)); setExpanded(ids); }
    function collapseAll() { if (!parsed) return; setExpanded(new Set([parsed.tree.id])); }

    // The overlay is placed in the drawing's coordinate space (fullBounds) as an <image> inside the same <svg viewBox=...>, so it pans/zooms with the drawing.
    const boundsW = Math.max(1, fullBounds.maxX - fullBounds.minX);
    const boundsH = Math.max(1, fullBounds.maxY - fullBounds.minY);
    // Blend slider (-1..1, 0 = center): cross-fades the BG image and the DEXPI drawing's opacity.
    // Positive fades the BG image out; negative fades the drawing out.
    const bgBlend = bgImage?.blend ?? 0;
    const drawingOpacity = bgBlend < 0 && !batchPng ? 1 + bgBlend : 1;
    const bgOpacity = bgBlend > 0 ? 1 - bgBlend : 1;
    const bgPlacement = useMemo(() => {
        if (!bgImage) return null;
        let baseW = boundsW, baseH = boundsH, baseX = fullBounds.minX, baseY = fullBounds.minY;
        if (bgImage.naturalWidth && bgImage.naturalHeight) {
            // "Contain"-fits the image into fullBounds, centered.
            const imgAspect = bgImage.naturalWidth / bgImage.naturalHeight;
            const boundsAspect = boundsW / boundsH;
            if (imgAspect > boundsAspect) { baseW = boundsW; baseH = boundsW / imgAspect; }
            else { baseH = boundsH; baseW = boundsH * imgAspect; }
            baseX = fullBounds.minX + (boundsW - baseW) / 2;
            baseY = fullBounds.minY + (boundsH - baseH) / 2;
        }
        return {
            x: baseX + bgImage.offsetX,
            y: baseY + bgImage.offsetY,
            width: baseW * bgImage.scale,
            height: baseH * bgImage.scale,
        };
    }, [bgImage, fullBounds, boundsW, boundsH]);
    // Tints the overlay a mid-dark blue while preserving the image's luminance (mix-blend-mode "color").
    const BG_TINT_COLOR = "#1e3a5f";

    const d = parsed?._diagnostics;

    // Combined status across both validation engines: one running/not-yet-run state for the unified tab. Each engine's own error state still surfaces separately.
    const validationRunning = xsdStatus === "running" || rdlStatus === "running";
    const validationStarted = xsdStatus !== "idle" || rdlStatus !== "idle";

    return (
        <div style={S.app(leftCollapsed, rightCollapsed)}>
            <style>{SPINNER_CSS}</style>

            {/* LEFT PANEL */}
            {leftCollapsed ? (
                <div style={S.collapsed}><button style={S.collapseBtn} onClick={() => setLeftCollapsed(false)} title="Expand">{">"}</button></div>
            ) : (
                <div style={S.panel}>
                    <div style={S.toolbar}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>DEXPI 1.4 / DISC Profile Viewer <span style={{ fontWeight: 400, fontSize: 12, color: "#57606a" }} title={`Version ${APP_VERSION}`}>v{APP_VERSION.split(".").slice(0, 2).join(".")}</span></div>
                                {/* Opens public/UserGuide.html in a new tab; the app keeps its state. */}
                                <a
                                    href={`${import.meta.env.BASE_URL}UserGuide.html`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Open the User Guide"
                                    aria-label="Open the User Guide"
                                    style={{
                                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                                        width: 22, height: 22, flexShrink: 0, borderRadius: 5,
                                        border: "1px solid #d0d7de", background: "white",
                                        color: "#57606a", textDecoration: "none",
                                    }}
                                >
                                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M8 4.2C7.3 3.1 6.1 2.6 4 2.6H1.8v9.6H4c1.8 0 3.2.4 4 1.2" />
                                        <path d="M8 4.2c.7-1.1 1.9-1.6 4-1.6h2.2v9.6H12c-1.8 0-3.2.4-4 1.2" />
                                        <path d="M8 4.2v9.2" />
                                    </svg>
                                </a>
                            </div>
                            <button style={S.collapseBtn} onClick={() => setLeftCollapsed(true)}>{"<"}</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={{ ...S.btn, background: mainFileLoaded ? "#eaf2ff" : "white" }} onClick={() => mainInputRef.current?.click()}>{mainFileLoaded ? "✓ " : ""}Load Proteus XML</button>
                            <button style={{ ...S.btn, background: discFileLoaded ? "#eaf2ff" : "white" }} onClick={() => discInputRef.current?.click()}>{discFileLoaded ? "✓ " : ""}Load DiscProfile.xml</button>
                        </div>
                        <input ref={mainInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleMainFile} />
                        {/* webkitdirectory turns this into a folder picker; files are read in the browser, nothing is uploaded. */}
                        <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderPick} />
                        <input ref={folderPngInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderPngPick} />
                        <input ref={folderElemInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderElemPick} />
                        <input ref={discInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleDiscFile} />
                        {(mainFileName || discFileName) && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a" }}>
                                {mainFileName && (
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={mainFileName}>
                                        Proteus XML: <span style={{ fontWeight: 600, color: "#24292f" }}>{mainFileName}</span>
                                    </div>
                                )}
                                {discFileName && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={discFileName}>
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            DiscProfile: <span style={{ fontWeight: 600, color: "#24292f" }}>{discFileName}</span>
                                        </span>
                                        <button
                                            onClick={clearDiscFile}
                                            title="Unload DiscProfile.xml and view the Proteus file without a profile"
                                            style={{ ...S.btnDanger, padding: "1px 6px", flexShrink: 0 }}
                                        >x</button>
                                    </div>
                                )}
                            </div>
                        )}
                        {!discFileLoaded && defaultProfileState === "loading" && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a", display: "flex", alignItems: "center" }}><Spinner />Loading default DiscProfile.xml…</div>
                        )}
                        {!discFileLoaded && defaultProfileState === "error" && (
                            <div style={{ marginTop: 6, fontSize: 11, color: "#9a6700", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span>Default DiscProfile.xml unavailable — load one by hand, or</span>
                                <button style={S.btnSmall} onClick={loadDefaultProfile}>Retry</button>
                            </div>
                        )}
                        {d && (
                            <div style={{ marginTop: 8, fontSize: 11, color: "#57606a" }}>
                                {d.totalObjects} objects · {d.classMatchedViaRule1} class-mapped via TypeURI rule
                            </div>
                        )}
                        {/* Single trigger for both XSD and DEXPI/RDL validation; results merge into the Validation tab below. */}
                        <button
                            style={{ ...S.btnPrimary, marginTop: 8, width: "100%" }}
                            onClick={runAllValidation}
                            disabled={!mainFileLoaded || xsdStatus === "running" || rdlStatus === "running"}
                            title="Both engines run automatically when a file is opened; this re-runs them on the file already loaded."
                        >
                            Run Validation
                        </button>
                        {(xsdStatus === "running" || rdlStatus === "running") && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a", display: "flex", alignItems: "center" }}><Spinner />Validating…</div>
                        )}
                    </div>

                    <div style={S.tabBar}>
                        <button style={S.tab(leftTab === "topology")} onClick={() => setLeftTab("topology")}>Topology</button>
                        <button style={S.tab(leftTab === "validation")} onClick={() => setLeftTab("validation")} title="XSD schema violations and DEXPI 1.4 model/Profile findings in one list, each with a validation code and type (Error/Warning/Info). Runs automatically when a file is opened.">
                            Validation{validationRunning ? "…" : allIssues.length ? ` (${allIssues.length})` : ""}
                        </button>
                        <button style={S.tab(leftTab === "folder")} onClick={() => setLeftTab("folder")} title="Findings for every file in the last validated folder, grouped by file.">
                            Folder{folderProgress ? "…" : folderIssues.length ? ` (${folderIssues.length})` : ""}
                        </button>
                        {/* Config tab hidden: its panel below still works, but nothing switches to it. Restore by putting the tab button back. */}
                    </div>

                    {leftTab === "topology" && (
                        <div style={S.scroll}>
                            <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6" }}>
                                <input style={S.input} placeholder="Search tag, type, ID, persistent ID..." value={search} onChange={e => setSearch(e.target.value)} />
                            </div>
                            <div style={{ padding: "4px 8px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 6 }}>
                                <button style={S.btnSmall} onClick={expandAll}>Expand all</button>
                                <button style={S.btnSmall} onClick={collapseAll}>Collapse all</button>
                                {parsed && <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>{parsed.flatTree.length} objects</span>}
                            </div>
                            <div style={{ padding: 6 }}>
                                {parseError && <div style={{ color: "#cf222e", padding: 8, fontSize: 13 }}>{parseError}</div>}
                                {filteredTree ? (
                                    <TreeNode node={filteredTree} selectedId={selectedId} onSelect={handleSelect} expanded={expanded} setExpanded={setExpanded} level={0} />
                                ) : (
                                    !parseError && <div style={{ color: "#888", fontSize: 13, padding: 8 }}>Load both files to view the topology.</div>
                                )}
                            </div>
                        </div>
                    )}

                    {leftTab === "validation" && (
                        <div style={S.scroll}>
                            {!validationStarted && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
                                    {mainFileLoaded ? 'Click "Run Validation" in the toolbar to check this file against the XSD schema and the DEXPI 1.4 model/Profile.' : "Load a Proteus XML file first."}
                                </div>
                            )}
                            {validationRunning && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13, display: "flex", alignItems: "center" }}><Spinner />Validating…</div>
                            )}
                            {xsdStatus === "error" && (
                                <div style={{ padding: "12px 16px", color: "#cf222e", fontSize: 13 }}>XSD schema validation failed to run: {xsdError}</div>
                            )}
                            {xsdStatus === "schema-incompatible" && (
                                <div style={{ padding: 12 }}>
                                    <div style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", display: "flex", alignItems: "center", gap: 8 }}>
                                        <span style={S.badge("#9a6700")}>XSD schema validation unavailable</span>
                                        <span style={{ fontSize: 11, color: "#888" }}>ProteusPIDSchema 4.1.1 disc.xsd</span>
                                    </div>
                                    <div style={{ marginTop: 10, padding: 10, background: "#fff8e6", border: "1px solid #f0d78c", borderRadius: 6, fontSize: 13, color: "#4d3800", lineHeight: 1.5 }}>
                                        {xsdError}
                                    </div>
                                </div>
                            )}
                            {rdlStatus === "done" && !rdlResult && (
                                <div style={{ padding: "12px 16px", color: "#cf222e", fontSize: 13 }}>DEXPI RDL/Profile validation failed to run - see the browser console for details.</div>
                            )}
                            {!validationRunning && validationStarted && (xsdResult || rdlResult) && (
                                <>
                                    <div style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        {allIssues.length === 0
                                            ? <span style={S.badge("#1a7f37")}>No issues found</span>
                                            : <span style={S.badge("#cf222e")}>{allIssues.length} issue{allIssues.length === 1 ? "" : "s"}</span>}
                                        <span style={{ fontSize: 11, color: "#888" }}>
                                            {xsdResult ? "ProteusPIDSchema 4.1.1 disc.xsd" : ""}
                                            {xsdResult && rdlResult ? " + " : ""}
                                            {rdlResult ? `DEXPI 1.4 model/Profile (${rdlResult.summary.totalObjects} objects)` : ""}
                                        </span>
                                        {allIssues.length > 0 && (
                                            <button
                                                style={{ ...S.btnSmall, marginLeft: "auto" }}
                                                onClick={() => {
                                                    const { columns, rows } = singleFileReportRows();
                                                    downloadCSV(rows, columns.map(c => c.header), `${mainFileName || "validation"}.csv`);
                                                }}
                                            >CSV</button>
                                        )}
                                    </div>
                                    {xsdResult?.filteredOut?.count > 0 && (
                                        <div style={{ padding: "6px 10px", fontSize: 11, color: "#57606a", background: "#f6f8fa", borderBottom: "1px solid #eef2f6" }} title={xsdResult.filteredOut.sets.join(", ")}>
                                            {xsdResult.filteredOut.count} non-DEXPI attribute group{xsdResult.filteredOut.count === 1 ? "" : "s"} ({xsdResult.filteredOut.sets.length} vendor Set{xsdResult.filteredOut.sets.length === 1 ? "" : "s"}) excluded from XSD validation — only Set="DexpiAttributes"/"DexpiCustomAttributes" are checked.
                                        </div>
                                    )}
                                    {/* Severity filter/count chips: click to show only issues of that type. */}
                                    <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                                        {["All", "Error", "Warning", "Info"].map(f => {
                                            const count = f === "All" ? allIssues.length : (issueCounts[f.toLowerCase()] || 0);
                                            const active = validationFilter === f;
                                            return (
                                                <button
                                                    key={f}
                                                    style={{ ...S.btnSmall, background: active ? "#0969da" : "white", color: active ? "white" : "#111", borderColor: active ? "#0969da" : "#c7ced6" }}
                                                    onClick={() => setValidationFilter(f)}
                                                >{f} ({count})</button>
                                            );
                                        })}
                                    </div>
                                    {issuesByCode.size > 1 && (
                                        <div style={{ padding: "4px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 6 }}>
                                            <button style={S.btnSmall} onClick={() => setCollapsedValidationCodes(new Set())}>Expand all</button>
                                            <button style={S.btnSmall} onClick={() => setCollapsedValidationCodes(new Set(issuesByCode.keys()))}>Collapse all</button>
                                        </div>
                                    )}
                                    {issuesByCode.size === 0 ? (
                                        <div style={{ padding: 16, color: "#888", fontSize: 13 }}>No issues{validationFilter !== "All" ? ` of type "${validationFilter}"` : ""}.</div>
                                    ) : [...issuesByCode.entries()].map(([code, items]) => {
                                        const isFolded = collapsedValidationCodes.has(code);
                                        const codeLabel = items[0]?.codeLabel || VALIDATION_CODE_LABELS[code] || code;
                                        const codeSeverity = resolveValidationSeverity(code, severityConfig);
                                        return (
                                            <div key={code}>
                                                <div
                                                    onClick={() => setCollapsedValidationCodes(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; })}
                                                    style={{ padding: "6px 10px", fontWeight: 600, fontSize: 12, background: "#f6f8fa", borderBottom: "1px solid #eef2f6", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                                                >
                                                    <span style={{ width: 12, display: "inline-block", textAlign: "center", flexShrink: 0, color: "#888", fontWeight: 400 }}>{isFolded ? "▸" : "▾"}</span>
                                                    <span style={S.badge(SEV_COLORS[codeSeverity])}>{SEV_LABELS[codeSeverity]}</span>
                                                    <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#24292f" }}>{code}</span>
                                                    <span>{codeLabel} ({items.length})</span>
                                                </div>
                                                {!isFolded && items.map((issue, i) => {
                                                    const isNavable = !!(issue.objectId && parsed?.treeMap?.has(issue.objectId));
                                                    const isActive = isNavable && issue.objectId === selectedId;
                                                    return (
                                                        <div key={issue.key ?? i}
                                                            onClick={() => { if (isNavable) { handleSelect(issue.objectId); setRightTab("issues"); } }}
                                                            style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", cursor: isNavable ? "pointer" : "default", borderLeft: isActive ? "3px solid #0969da" : "3px solid transparent", background: isActive ? "#f0f7ff" : "transparent", transition: "background 0.1s" }}
                                                        >
                                                            {/* Top line: rule code, type, and line/nav icon. Second line: the validation error's descriptive label, separate from the free-text message below it. */}
                                                            <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                                                                <span style={S.badge(SEV_COLORS[issue.severity])}>{SEV_LABELS[issue.severity]}</span>
                                                                <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#24292f" }}>{issue.code}</span>
                                                                {issue.line != null && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>line {issue.line}</span>}
                                                                {isNavable && <span title="Click to highlight element" style={{ fontSize: 10, color: "#0969da", marginLeft: 2 }}>⊕</span>}
                                                            </div>
                                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#57606a", marginBottom: 2 }}>{issue.codeLabel}</div>
                                                            <div style={{ fontSize: 12, color: "#333", marginBottom: 2 }}>{issue.message}</div>
                                                            {issue.objectId && (
                                                                <div style={{ fontSize: 11, color: isNavable ? "#0969da" : "#57606a", fontFamily: "monospace" }}>
                                                                    {isNavable ? "↳ " : ""}{issue.objectId}
                                                                    {!isNavable && <span style={{ color: "#cf222e", marginLeft: 4 }} title="No graphical representation found">⚠ no symbol</span>}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    )}

                    {leftTab === "folder" && (
                        <div style={S.scroll}>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid #eef2f6" }}>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress} onClick={handleFolderButton} title="Validate every .xml in a folder, and its subfolders, against the loaded profile. The browser asks permission to read the folder; the files stay on this machine and nothing is uploaded.">
                                    Validate…
                                </button>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress} onClick={handleSavePngButton} title="Render every .xml in a folder, and its subfolders, and save each as a .png next to it. The browser asks permission to write to the folder.">
                                    Save PNG…
                                </button>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress} onClick={handleExportElementButton} title="Export every class (including TypeURIAssignmentClass-mapped profile classes) and every DexpiAttributes / DexpiCustomAttributes attribute used in a folder's .xml files, with counts and validity, as an Excel file.">
                                    Export Element…
                                </button>
                            </div>
                            {elemProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div style={{ display: "flex", alignItems: "center" }}>
                                        <Spinner />Reading {Math.min(elemProgress.done + 1, elemProgress.total)} of {elemProgress.total}…
                                    </div>
                                    <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{elemProgress.name}</div>
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { elemCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {pngProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div style={{ display: "flex", alignItems: "center" }}>
                                        <Spinner />Saving PNG {Math.min(pngProgress.done + 1, pngProgress.total)} of {pngProgress.total}…
                                    </div>
                                    <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pngProgress.name}</div>
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { pngCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {!pngProgress && pngResult && (
                                <div style={{ margin: "8px 12px", padding: "8px 10px", fontSize: 12, background: pngResult.failed.length ? "#fff8c5" : "#dafbe1", border: "1px solid #eef2f6", borderRadius: 6 }}>
                                    <div style={{ display: "flex", alignItems: "center" }}>
                                        <span>
                                            {pngResult.total === 0
                                                ? "No .xml files found in that folder."
                                                : `${pngResult.saved} of ${pngResult.total} PNG${pngResult.total === 1 ? "" : "s"} ${pngResult.downloaded ? "downloaded" : `saved to ${pngResult.folder || "the folder"}`}${pngResult.cancelled ? " (stopped)" : ""}.`}
                                        </span>
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => setPngResult(null)}>×</button>
                                    </div>
                                    {pngResult.failed.map(f => (
                                        <div key={f.path} style={{ marginTop: 4, fontFamily: "monospace", fontSize: 11 }} title={f.error}>{f.path}: {f.error}</div>
                                    ))}
                                </div>
                            )}
                            {folderProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div style={{ display: "flex", alignItems: "center" }}>
                                        <Spinner />Validating {Math.min(folderProgress.done + 1, folderProgress.total)} of {folderProgress.total}…
                                    </div>
                                    {folderProgress.name && (
                                        <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folderProgress.name}</div>
                                    )}
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { folderCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {!folderProgress && !pngProgress && !elemProgress && !folderResults && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13, lineHeight: 1.5 }}>
                                    Each button works on every .xml file in a folder and its subfolders:
                                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                                        <li><b>Validate…</b> checks each file against the same two engines.</li>
                                        <li><b>Save PNG…</b> saves each drawing as a .png next to its file, using the drawing toolbar's Profile labels, Line Boost and Include symbol outlines settings.</li>
                                        <li><b>Export Element…</b> downloads an Excel file listing the classes and DEXPI attributes used in each file, with counts and whether each is valid.</li>
                                    </ul>
                                    <div style={{ marginTop: 8, padding: "8px 10px", background: "#f6f8fa", border: "1px solid #eef2f6", borderRadius: 6 }}>
                                        <b>Nothing is uploaded.</b> The files are read and processed inside this browser, on this machine, and are never sent to a server.
                                        The browser asks permission first; its wording ("view and copy", or "upload") is the browser asking whether this page may <i>read</i> those files into itself.
                                        <b>Save PNG…</b> also asks to <i>edit</i> files in the folder, so it can write the PNGs there. Browsers that can't write to a folder download them instead.
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        {discFileLoaded
                                            ? <>Profile in use: <b>{discFileName}</b>.</>
                                            : "No DiscProfile.xml is loaded, so profile-dependent codes will not be evaluated."}
                                    </div>
                                </div>
                            )}
                            {!folderProgress && folderResults?.length === 0 && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13 }}>No .xml files found in that folder.</div>
                            )}
                            {!folderProgress && folderResults?.length > 0 && (
                                <>
                                    <div style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        {folderIssues.length === 0
                                            ? <span style={S.badge("#1a7f37")}>No issues found</span>
                                            : <span style={S.badge("#cf222e")}>{folderIssues.length} issue{folderIssues.length === 1 ? "" : "s"}</span>}
                                        <span style={{ fontSize: 11, color: "#888" }} title="Validated in this browser - no file was uploaded">
                                            {folderName ? `${folderName} · ` : ""}
                                            {folderResults.length} file{folderResults.length === 1 ? "" : "s"}
                                            {discFileLoaded ? ` · ${discFileName}` : " · no profile"}
                                            {" · checked in this browser, nothing uploaded"}
                                        </span>
                                    </div>
                                    <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                                        {["All", "Error", "Warning", "Info"].map(f => {
                                            const count = f === "All" ? folderIssues.length : (folderCounts[f.toLowerCase()] || 0);
                                            const active = folderFilter === f;
                                            return (
                                                <button
                                                    key={f}
                                                    style={{ ...S.btnSmall, background: active ? "#0969da" : "white", color: active ? "white" : "#111", borderColor: active ? "#0969da" : "#c7ced6" }}
                                                    onClick={() => setFolderFilter(f)}
                                                >{f} ({count})</button>
                                            );
                                        })}
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => setExplorerOpen(true)} disabled={!folderIssues.length} title="Drill down Layer -> Category -> Code, then into the documents and lines each code was raised on.">Explorer</button>
                                        <button style={S.btnSmall} onClick={downloadFolderCsv} disabled={!folderResults.length}>CSV</button>
                                        <button style={S.btnSmall} onClick={downloadFolderXlsx} disabled={!folderResults.length}>Excel</button>
                                    </div>
                                    <div style={{ padding: "4px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 6 }}>
                                        <button style={S.btnSmall} onClick={() => setCollapsedFolderFiles(new Set())}>Expand all</button>
                                        <button style={S.btnSmall} onClick={() => setCollapsedFolderFiles(new Set(folderResults.map(r => r.path)))}>Collapse all</button>
                                    </div>
                                    {folderResults.map(r => {
                                        const items = folderByFile.get(r.path) || [];
                                        if (!items.length && folderFilter !== "All" && !r.error) return null;
                                        const isFolded = collapsedFolderFiles.has(r.path);
                                        return (
                                            <div key={r.path}>
                                                <div
                                                    onClick={() => setCollapsedFolderFiles(prev => { const n = new Set(prev); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; })}
                                                    style={{ padding: "6px 10px", background: "#f6f8fa", borderBottom: "1px solid #eef2f6", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                                                >
                                                    <span style={{ width: 12, textAlign: "center", flexShrink: 0, color: "#888", fontSize: 12 }}>{isFolded ? "▸" : "▾"}</span>
                                                    <span style={{ fontWeight: 600, fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.path}>{r.path}</span>
                                                    {r.error
                                                        ? <span style={S.badge("#cf222e")}>failed</span>
                                                        : items.length === 0
                                                            ? <span style={S.badge("#1a7f37")}>clean</span>
                                                            : <span style={{ fontSize: 11, color: "#57606a" }}>{items.length}</span>}
                                                    <button
                                                        style={{ ...S.btnSmall, flexShrink: 0 }}
                                                        onClick={ev => { ev.stopPropagation(); openFolderFile(r.path); }}
                                                        title="Load this file into the viewer"
                                                    >Open</button>
                                                </div>
                                                {!isFolded && r.error && (
                                                    <div style={{ padding: "8px 10px", fontSize: 12, color: "#cf222e", borderBottom: "1px solid #eef2f6" }}>{r.error}</div>
                                                )}
                                                {!isFolded && r.note && (
                                                    <div style={{ padding: "4px 10px", fontSize: 11, color: "#9a6700", background: "#fff8e6", borderBottom: "1px solid #eef2f6" }}>{r.note}</div>
                                                )}
                                                {!isFolded && items.map(issue => (
                                                    <div key={issue.key} style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6" }}>
                                                        <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                                                            <span style={S.badge(SEV_COLORS[issue.severity])}>{SEV_LABELS[issue.severity]}</span>
                                                            <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#24292f" }}>{issue.code}</span>
                                                            {issue.line != null && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>line {issue.line}</span>}
                                                        </div>
                                                        <div style={{ fontSize: 12, fontWeight: 600, color: "#57606a", marginBottom: 2 }}>{issue.codeLabel}</div>
                                                        <div style={{ fontSize: 12, color: "#333" }}>{issue.message}</div>
                                                        {issue.objectId && (
                                                            <div style={{ fontSize: 11, color: "#57606a", fontFamily: "monospace" }}>{issue.objectId}</div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    )}

                    {/* Not reachable while the Config tab button is hidden. */}
                    {leftTab === "config" && (
                        <div style={S.scroll}>
                            <div style={S.section}>
                                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Validation Type Configuration</div>
                                <div style={{ fontSize: 11, color: "#57606a", marginBottom: 10, lineHeight: 1.5 }}>
                                    Each code defaults to its classification severity - Major shows as Error, Minor as Warning. Change any code's type here; the Validation tab's list, counts and filter chips update immediately, without re-running validation.
                                </div>
                                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                                    <button style={S.btnSmall} onClick={exportSeverityConfig} disabled={allValidationCodes.length === 0}>Export JSON</button>
                                    <label style={{ ...S.btnSmall, cursor: "pointer" }}>Import JSON<input type="file" accept=".json" style={{ display: "none" }} onChange={importSeverityConfig} /></label>
                                    {Object.keys(severityConfig).length > 0 && (
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => setSeverityConfig({})}>Reset all</button>
                                    )}
                                </div>
                                {allValidationCodes.length === 0 ? (
                                    <div style={{ color: "#888", fontSize: 13 }}>Run validation first to see codes.</div>
                                ) : allValidationCodes.map(code => {
                                    const effective = resolveValidationSeverity(code, severityConfig);
                                    const overridden = !!severityConfig[code];
                                    const label = VALIDATION_CODE_LABELS[code] || code;
                                    return (
                                        <div key={code} style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 4, background: overridden ? "#f0f7ff" : "transparent" }}>
                                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV_COLORS[effective], flexShrink: 0, display: "inline-block" }} />
                                            <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, color: "#24292f", flexShrink: 0, width: 82 }}>{code}</span>
                                            <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>{label}</span>
                                            <select value={effective} onChange={e => updateSeverity(code, e.target.value)} style={{ fontSize: 12, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4 }}>
                                                <option value="error">Error</option>
                                                <option value="warning">Warning</option>
                                                <option value="info">Info</option>
                                            </select>
                                            {overridden && <button title="Reset to default" style={{ fontSize: 10, padding: "1px 5px", border: "1px solid #c7ced6", borderRadius: 4, cursor: "pointer", background: "white", color: "#57606a" }} onClick={() => updateSeverity(code, null)}>↺</button>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* CENTER PANEL */}
            <div style={{ position: "relative", overflow: "hidden", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
                <div style={{ ...S.toolbar, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parsed?.meta?.drawingNumber || ""}</div>
                        <div style={{ fontSize: 12, color: "#57606a" }}>{parsed?.meta?.drawingName || ""}{parsed?.meta?.subtitle ? ` - ${parsed.meta.subtitle}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn} onClick={() => { if (!parsed) return; const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); }} title="Fit drawing to window">Fit</button>
                        {zOrderOverrides.size > 0 && (
                            <button style={S.btn} onClick={() => setZOrderOverrides(new Set())} title="Clear every 'Send to Back' draw-order override and restore the file's original paint order">
                                Reset Z-Order ({zOrderOverrides.size})
                            </button>
                        )}
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a" }} title="Connector/centerline stroke width as a percentage of its original width. 100% = unchanged; raise it to bulk up thin lines to match a BG reference image's line weight.">
                            Line Boost
                            <input type="number" min={1} step={1} value={lineBoostPct} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v > 0) setLineBoostPct(v); }} style={S.numBox} title="Line width, as a percentage of its original width" />
                            %
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, symbol outline strokes are boosted by the same Line Boost percentage as connector/centerlines. When unchecked, only connector/centerlines are affected.">
                            <input type="checkbox" checked={boostSymbolOutlines} onChange={e => setBoostSymbolOutlines(e.target.checked)} />
                            Include symbol outlines
                        </label>
                        <button style={S.btn} disabled={!parsed || exporting} onClick={exportAsPng} title="Save the current view (drawing + BG image, if any) as a PNG">{exporting ? "..." : "Save PNG"}</button>
                        <button style={S.btn} disabled={!parsed || exporting} onClick={exportAsPdf} title="Save the current view (drawing + BG image, if any) as a PDF">{exporting ? "..." : "Save PDF"}</button>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Connectivity mode: highlights the upstream (blue), downstream (green), and group (purple) connections of the selected object. Hidden by default - check this box to show the highlight.">
                            <input type="checkbox" checked={showConnectivity} onChange={e => setShowConnectivity(e.target.checked)} />
                            Connectivity
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, selecting an object also highlights (red) all of its sub-components in the drawing. When unchecked, only the selected object itself is highlighted.">
                            <input type="checkbox" checked={selectHighlightSubComponents} onChange={e => setSelectHighlightSubComponents(e.target.checked)} />
                            Sub-components
                        </label>
                        {discFileLoaded && (
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Toggle between a DiscProfile-catalogued symbol's own exported label text and the loaded DiscProfile.xml's attribute-resolved LabelTemplate value for it - checked shows the catalog's LabelTemplate(s) as an overlay (even for symbols with no Label XML of their own); unchecked shows the profile's resolved value in place of the original literal text.">
                                <input type="checkbox" checked={showProfileLabels} onChange={e => setShowProfileLabels(e.target.checked)} />
                                Profile labels
                            </label>
                        )}
                        <button style={S.btn} onClick={() => bgInputRef.current?.click()} title="Overlay an image behind the drawing">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBgFile} />
                        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>Scroll to zoom · Space+drag to pan</span>
                    </div>
                </div>

                {bgImage && showBgControls && (
                    <div style={{ padding: "6px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }} title="Blend between the BG image and the DEXPI drawing. Center (0): both fully visible. Drag right: the BG image fades out, the drawing stays fully visible. Drag left: the drawing fades out, the BG image stays fully visible.">
                            Blend
                            <input type="range" min={-1} max={1} step={0.05} value={bgImage.blend} onChange={e => setBgImage(b => ({ ...b, blend: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Scale
                            <input type="range" min={0.1} max={3} step={0.05} value={bgImage.scale} onChange={e => setBgImage(b => ({ ...b, scale: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={0.01} max={20} step={0.01} value={bgImage.scale} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v > 0) setBgImage(b => ({ ...b, scale: v })); }} style={S.numBox} title="Scale factor" />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            X
                            <input type="range" min={-boundsW} max={boundsW} step={Math.max(0.01, boundsW / 500)} value={bgImage.offsetX} onChange={e => setBgImage(b => ({ ...b, offsetX: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={Math.max(0.01, boundsW / 500)} value={bgImage.offsetX} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetX: v })); }} style={S.numBoxWide} title="X offset, in drawing units, from the auto-fit position" />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Y
                            <input type="range" min={-boundsH} max={boundsH} step={Math.max(0.01, boundsH / 500)} value={bgImage.offsetY} onChange={e => setBgImage(b => ({ ...b, offsetY: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={Math.max(0.01, boundsH / 500)} value={bgImage.offsetY} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetY: v })); }} style={S.numBoxWide} title="Y offset, in drawing units, from the auto-fit position" />
                        </label>
                        <button style={S.btnSmall} onClick={() => setBgImage(b => ({ ...b, scale: 1, offsetX: 0, offsetY: 0 }))} title="Reset to the auto-fit (centered, aspect-correct) placement">Reset fit</button>
                        {/* Embeds this PNG's current placement into a downloaded copy so a future load starts pre-aligned. Only PNG files support an embedded default. */}
                        <button
                            style={{ ...S.btnSmall, borderColor: "#0969da", color: "#0969da" }}
                            disabled={!bgImage.isPng}
                            onClick={downloadBgPlacementPng}
                            title={bgImage.isPng
                                ? "Embed the current Scale / X / Y into a copy of this PNG and download it, so the next time this image is loaded it starts at this placement instead of the auto-fit - the original file you selected is left untouched"
                                : "Only PNG images support an embedded placement default - this file isn't a PNG"}
                        >
                            ⬇ Download PNG with placement
                        </button>
                        {bgImage.isPng && bgImage.embeddedPlacement && (
                            <button style={S.btnSmall} onClick={clearBgDefault} title="Download a copy of this PNG with the saved placement default removed">
                                Clear Default
                            </button>
                        )}
                        <button style={{ ...S.btnSmall, color: "#cf222e" }} onClick={() => { if (bgObjectUrlRef.current) { URL.revokeObjectURL(bgObjectUrlRef.current); bgObjectUrlRef.current = null; } setBgImage(null); setShowBgControls(false); }}>Remove</button>
                    </div>
                )}

                {parseError && <div style={{ color: "#cf222e", padding: "8px 12px", fontSize: 13 }}>{parseError}</div>}

                <div ref={svgViewportRef} style={{ flex: 1, position: "relative", background: "white", cursor: isPanning ? "grabbing" : spaceDown ? "grab" : "default", overflow: "hidden" }}
                    onMouseDown={e => { if (e.button !== 0 || !spaceDown) return; e.preventDefault(); setIsPanning(true); setPanStart({ x: e.clientX, y: e.clientY, view: viewBox }); }}
                    onMouseMove={e => {
                        if (!isPanning || !panStart || !svgViewportRef.current) return;
                        const rect = svgViewportRef.current.getBoundingClientRect();
                        const dx = ((e.clientX - panStart.x) / rect.width) * panStart.view.w;
                        const dy = ((e.clientY - panStart.y) / rect.height) * panStart.view.h;
                        setViewBox(clampViewBox({ ...panStart.view, x: panStart.view.x - dx, y: panStart.view.y - dy }, fullBounds));
                    }}
                    onMouseUp={() => { setIsPanning(false); setPanStart(null); }}
                    onMouseLeave={() => { setIsPanning(false); setPanStart(null); }}
                >
                    <svg ref={svgElRef} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} width="100%" height="100%" style={{ display: "block" }} onAuxClick={e => e.preventDefault()}>
                        {bgImage && bgPlacement && !batchPng && (
                            <g style={{ display: bgImage.visible ? "inline" : "none", opacity: bgOpacity, pointerEvents: "none" }}>
                                <image href={bgImage.src} x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} preserveAspectRatio="none" />
                                <rect x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} fill={BG_TINT_COLOR} style={{ mixBlendMode: "color" }} />
                            </g>
                        )}
                        <g opacity={drawingOpacity}>
                        {paintOrderElements
                            // "lbltpl_"-prefixed keys are catalog-LabelTemplate overlay texts for DiscProfile-catalogued symbols; hidden when the Profile labels checkbox is off.
                            // Iterates paintOrderElements (not the raw parsed list) so "Send to Back" overrides affect both paint and click order.
                            .filter(el => showProfileLabels || !el.key.startsWith("lbltpl_"))
                            .map(el => {
                            const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                            const ch = connectivityHighlight;
                            const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                            if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} />;
                            return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} showProfileLabels={showProfileLabels} />;
                        })}
                        </g>
                        {/* Heat-trace overlays: rendered on top, only when a DiscProfile.xml is loaded and at least one object has an active HeatTracingType. */}
                        {parsed?.heatTraceSet?.size > 0 && parsed.graphics.elements.map(el => {
                            // Never draw heat-trace overlays on label or annotation elements
                            if (el.elementRole === "label") return null;
                            // Proteus CenterLine polylines bridge through htSegmentId: HeatTracingType inheritance applies to the owning PipingNetworkSegment, not the synthetic CenterLine node, so the lookup uses the segment's id.
                            if (el.htSegmentId && el.primitive?.kind === "polyline" && parsed.heatTraceSet.has(el.htSegmentId)) {
                                return <HeatTracePolyline key={`ht_${el.key}`} points={el.primitive.points} />;
                            }
                            const htType = el.representedId ? parsed.heatTraceSet.get(el.representedId) : null;
                            if (!htType) return null;
                            if ((htType === "inline" || htType === "nozzle") && el.kind === "symbolUsage")
                                return <HeatTraceSymbol key={`ht_${el.key}`} el={el} />;
                            if (htType === "pif" && el.kind === "symbolUsage")
                                return <HeatTracePIF key={`ht_${el.key}`} el={el} />;
                            return null;
                        })}
                    </svg>
                    {showConnectivity && selectedId && (
                        <div style={{ position: "absolute", bottom: 10, left: 10, background: "rgba(255,255,255,0.9)", padding: "5px 10px", borderRadius: 6, border: "1px solid #d0d7de", fontSize: 11, display: "flex", gap: 8 }}>
                            <span style={{ color: "#d1242f" }}>o Selected</span>
                            <span style={{ color: "#0969da" }}>o Upstream</span>
                            <span style={{ color: "#1a7f37" }}>o Downstream</span>
                            <span style={{ color: "#8250df" }}>o Group</span>
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT PANEL */}
            {rightCollapsed ? (
                <div style={S.rCollapsed}><button style={S.collapseBtn} onClick={() => setRightCollapsed(false)}>{"<"}</button></div>
            ) : (
                <div style={S.rPanel}>
                    <div style={S.toolbar}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontWeight: 700 }}>Details</div>
                            <button style={S.collapseBtn} onClick={() => setRightCollapsed(true)}>{">"}</button>
                        </div>
                    </div>
                    <div style={S.tabBar}>
                        {[
                            ["details", "Object"],
                            ["connectivity", "Connections"],
                            ["issues", `Issues${selectedId && issuesByObjectId.has(selectedId) ? ` (${issuesByObjectId.get(selectedId).length})` : ""}`],
                        ].map(([t, label]) => (
                            <button key={t} style={S.tab(rightTab === t)} onClick={() => setRightTab(t)}>{label}</button>
                        ))}
                    </div>
                    <div style={S.scroll}>
                        {rightTab === "details" && (
                            <>
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedNode?.label || "No selection"}</div>
                                    <div style={{ fontSize: 12, color: "#57606a" }}>{selectedNode?.type || ""}</div>
                                    {selectedNode?.componentClass && (
                                        // Proteus/DEXPI 1.4 only: the raw ComponentClass attribute as written in the source XML, shown alongside the resolved DEXPI 2.0 `type` above it.
                                        // Not set for native DEXPI 2.0 files.
                                        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 5 }}>
                                            <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.3 }}>ComponentClass</span>
                                            <span style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 600, padding: "1px 6px", background: "#f0f7ff", color: "#0969da", borderRadius: 4 }}>
                                                {selectedNode.componentClass}
                                            </span>
                                        </div>
                                    )}
                                    {selectedNode?.objectId && (
                                        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                            <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{selectedNode.objectId}</div>
                                            {/* Only offered when the selected object has at least one associated graphic. */}
                                            {representedIdsWithGraphics.has(selectedNode.objectId) && (
                                                <button
                                                    style={{ ...S.btnSmall, background: zOrderOverrides.has(selectedNode.objectId) ? "#eaf2ff" : "white", color: zOrderOverrides.has(selectedNode.objectId) ? "#0969da" : "#111", flexShrink: 0 }}
                                                    onClick={toggleSendToBack}
                                                    title={zOrderOverrides.has(selectedNode.objectId)
                                                        ? "Restore this object's symbol(s) to their original position in the paint order"
                                                        : "Move this object's symbol behind everything else in the drawing, so overlapping or nested items underneath it become clickable/selectable"}
                                                >
                                                    {zOrderOverrides.has(selectedNode.objectId) ? "↺ Restore order" : "⇩ Send to Back"}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {selectedNode?.objectId && zOrderOverrides.has(selectedNode.objectId) && (
                                        // Indicator that this object's draw order is currently overridden.
                                        <div style={{ marginTop: 6, fontSize: 11, color: "#0969da", background: "#eaf2ff", display: "inline-block", padding: "2px 7px", borderRadius: 999, fontWeight: 600 }}>
                                            Sent to back
                                        </div>
                                    )}
                                    {selectedNode?.persistentIdentifiers?.length > 0 && (
                                        <div style={{ marginTop: 10 }}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Persistent Identifiers</div>
                                            {selectedNode.persistentIdentifiers.map((pid, i) => (
                                                <div key={i} style={{ fontSize: 12, marginBottom: 5 }}>
                                                    <div style={{ color: "#888", fontSize: 11 }}>{pid.context || "No context"}</div>
                                                    <div style={{ wordBreak: "break-all" }}>{pid.value}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div style={S.section}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                                        <div style={{ fontWeight: 600, fontSize: 12 }}>Data</div>
                                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#57606a", cursor: "pointer" }} title='Non-DEXPI attributes are those not in a GenericAttributes group with Set="DexpiAttributes" or "DexpiCustomAttributes"'>
                                            <input type="checkbox" checked={showAllAttributes} onChange={e => setShowAllAttributes(e.target.checked)} />
                                            Show non-DEXPI attributes
                                        </label>
                                    </div>
                                    {(() => {
                                        const allData = selectedNode?.data || [];
                                        const visibleData = showAllAttributes
                                            ? allData
                                            : allData.filter(d => d.set === undefined || DEXPI_ATTRIBUTE_SETS.has(d.set));
                                        const hiddenCount = allData.length - visibleData.length;
                                        if (!allData.length) return <div style={{ color: "#888", fontSize: 12 }}>No data.</div>;
                                        return (
                                            <>
                                                {visibleData.map((d2, i) => {
                                                    const fmt = formatDataValue(d2.value);
                                                    const shortProp = d2.property.split("/").pop();
                                                    return (
                                                        <div key={`${d2.property}_${i}`} style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                            <div style={{ fontSize: 11, color: "#888", marginBottom: 1 }} title={d2.property}>{shortProp}</div>
                                                            <div style={{ fontSize: 13, display: "flex", alignItems: "baseline", gap: 5 }}>
                                                                <span style={{ fontWeight: 500 }}>{fmt.text}</span>
                                                                {fmt.uom && (
                                                                    <span style={{ fontSize: 11, color: "#0969da", fontWeight: 600, padding: "0 4px", background: "#ddf4ff", borderRadius: 3 }} title={fmt.unitRef || fmt.uom}>
                                                                        {fmt.uom}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {d2.property !== shortProp && (
                                                                <div style={{ fontSize: 10, color: "#aaa", marginTop: 1 }}>{d2.property}</div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                                {!showAllAttributes && hiddenCount > 0 && (
                                                    <div style={{ fontSize: 11, color: "#888", padding: "2px 2px 0" }}>
                                                        {hiddenCount} non-DEXPI attribute{hiddenCount === 1 ? "" : "s"} hidden
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                                {(() => {
                                    // Proteus/DEXPI 1.4 only; always empty for native DEXPI 2.0 files. Keyed by the id of whichever element owns the ComponentName+Position that placed the symbol, so selecting it shows what placed it.
                                    // Populated for any ComponentName+Position element, even one that didn't resolve to a drawable symbol.
                                    const ref = parsed?.graphics?.symbolReferences?.get(selectedId);
                                    if (!ref) return null;
                                    const vec = v => v ? `X="${v.x}" Y="${v.y}" Z="${v.z}"` : null;
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Symbol Reference</div>
                                            <div style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                <div style={{ fontSize: 11, color: "#888", marginBottom: 1 }}>SymbolRegistrationNumberAssignmentClass</div>
                                                <div style={{ fontSize: 13, fontWeight: 500 }}>{ref.regNum || "—"}</div>
                                            </div>
                                            <div style={{ padding: "4px 6px", background: "#f9fafb", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>
                                                {ref.axis && <div>{`<Axis ${vec(ref.axis)} />`}</div>}
                                                {ref.reference && <div>{`<Reference ${vec(ref.reference)} />`}</div>}
                                                {ref.scale && <div>{`<Scale ${vec(ref.scale)} />`}</div>}
                                                {!ref.axis && !ref.reference && !ref.scale && <div style={{ fontFamily: "inherit", color: "#888" }}>No Axis/Reference/Scale on this element's Position.</div>}
                                            </div>
                                        </div>
                                    );
                                })()}
                                {(() => {
                                    // Label Symbol Reference: an owner object can carry its own nested <Label ComponentName="..."> placing a separate symbol, distinct from the owner's own Symbol Reference.
                                    // labelSymbolReferencesByOwner is keyed by the owner's id.
                                    const labelRefs = parsed?.graphics?.labelSymbolReferencesByOwner?.get(selectedId);
                                    if (!labelRefs?.length) return null;
                                    const vec = v => v ? `X="${v.x}" Y="${v.y}" Z="${v.z}"` : null;
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Label Symbol Reference{labelRefs.length > 1 ? "s" : ""}</div>
                                            {labelRefs.map((ref, i) => (
                                                <div key={ref.labelId || i} style={{ marginBottom: i < labelRefs.length - 1 ? 10 : 0 }}>
                                                    <div
                                                        style={{ fontSize: 11, color: parsed?.treeMap?.has(ref.labelId) ? "#0969da" : "#888", marginBottom: 4, cursor: parsed?.treeMap?.has(ref.labelId) ? "pointer" : "default" }}
                                                        onClick={() => parsed?.treeMap?.has(ref.labelId) && handleSelect(ref.labelId)}
                                                    >
                                                        {ref.labelId}
                                                    </div>
                                                    <div style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                        <div style={{ fontSize: 11, color: "#888", marginBottom: 1 }}>SymbolRegistrationNumberAssignmentClass</div>
                                                        <div style={{ fontSize: 13, fontWeight: 500 }}>{ref.regNum || "—"}</div>
                                                    </div>
                                                    <div style={{ padding: "4px 6px", background: "#f9fafb", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>
                                                        {ref.axis && <div>{`<Axis ${vec(ref.axis)} />`}</div>}
                                                        {ref.reference && <div>{`<Reference ${vec(ref.reference)} />`}</div>}
                                                        {ref.scale && <div>{`<Scale ${vec(ref.scale)} />`}</div>}
                                                        {!ref.axis && !ref.reference && !ref.scale && <div style={{ fontFamily: "inherit", color: "#888" }}>No Axis/Reference/Scale on this Label's Position.</div>}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })()}
                                {(() => {
                                    // Notes: Note ItemIDs referenced by any DependantAttribute on this element's (or its nested Labels') Text templates.
                                    const noteIds = parsed?.graphics?.noteReferencesByOwner?.get(selectedId);
                                    if (!noteIds?.length) return null;
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Note{noteIds.length > 1 ? "s" : ""}</div>
                                            {noteIds.map((noteId, i) => (
                                                <div
                                                    key={noteId || i}
                                                    style={{ fontSize: 13, color: parsed?.treeMap?.has(noteId) ? "#0969da" : "#888", marginBottom: i < noteIds.length - 1 ? 4 : 0, cursor: parsed?.treeMap?.has(noteId) ? "pointer" : "default" }}
                                                    onClick={() => parsed?.treeMap?.has(noteId) && handleSelect(noteId)}
                                                >
                                                    {noteId}
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })()}
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>References / Associations</div>
                                    {selectedNode?.refs?.length ? selectedNode.refs.map((r, i) => (
                                        <div key={i} style={{ marginBottom: 5 }}>
                                            <div style={{ fontSize: 11, color: "#888" }}>{r.property}</div>
                                            <div style={{ fontSize: 12 }}>
                                                {r.objects.map((oid, j) => (
                                                    <span key={j} style={{ cursor: parsed?.treeMap?.has(oid) ? "pointer" : "default", color: parsed?.treeMap?.has(oid) ? "#0969da" : "#cf222e", marginRight: 5 }} onClick={() => parsed?.treeMap?.has(oid) && handleSelect(oid)}>{oid}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )) : <div style={{ color: "#888", fontSize: 12 }}>No references.</div>}
                                </div>
                                {(() => {
                                    if (!selectedNode?.objectId || !parsed?.flatTree) return null;
                                    const parent = parsed.flatTree.find(n =>
                                        n.objectId && n.objectId !== selectedNode.objectId &&
                                        n.children.some(c => c.objectId === selectedNode.objectId)
                                    ) || null;
                                    if (!parent) return null;
                                    const typeSuffix = parent.type.split(".").pop();
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Parent Component</div>
                                            <div
                                                onClick={() => handleSelect(parent.objectId)}
                                                style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", background: "#f9fafb", borderRadius: 4, cursor: "pointer", border: "1px solid #eef2f6" }}
                                            >
                                                <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {parent.label || parent.objectId || typeSuffix}
                                                </span>
                                                <span style={{ fontSize: 10, color: "#aaa", flexShrink: 0 }}>{typeSuffix}</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                                {selectedNode?.children?.length > 0 && (
                                    <div style={S.section}>
                                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                                            Sub-Components ({selectedNode.children.length})
                                        </div>
                                        {selectedNode.children.map((child, i) => {
                                            const typeSuffix = child.type.split(".").pop();
                                            return (
                                                <div key={i}
                                                    onClick={() => child.objectId && handleSelect(child.objectId)}
                                                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", marginBottom: 3, background: "#f9fafb", borderRadius: 4, cursor: child.objectId ? "pointer" : "default", border: "1px solid #eef2f6" }}
                                                >
                                                    <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.label || undefined}>
                                                        {child.objectId || child.label || typeSuffix}
                                                    </span>
                                                    <span style={{ fontSize: 10, color: "#aaa", flexShrink: 0 }}>{typeSuffix}</span>
                                                    {child.children.length > 0 && (
                                                        <span style={{ fontSize: 10, color: "#888", flexShrink: 0 }}>+{child.children.length}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                        {rightTab === "connectivity" && (
                            <div style={S.section}>
                                {!selectedNode ? <div style={{ color: "#888", fontSize: 12 }}>Select an object.</div> : (() => {
                                    const conn = parsed?.connectivityMap?.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
                                    const makeList = (ids, color, label) => (
                                        <div style={{ marginBottom: 12 }}>
                                            <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 4 }}>{label} ({ids.size})</div>
                                            {ids.size === 0 ? <div style={{ fontSize: 12, color: "#888" }}>None</div> : [...ids].map(id => {
                                                const n = parsed?.treeMap?.get(id);
                                                // Suffix comes from the node's own `type` (e.g. "Plant/Segment.CenterLine" -> "CenterLine"), not a ComponentClass lookup.
                                                const suffix = (n?.type || "").split(".").pop();
                                                return (
                                                    <div key={id}
                                                        style={{ fontSize: 12, padding: "3px 6px", cursor: "pointer", borderRadius: 3, marginBottom: 2, background: "#f9fafb", border: `1px solid #e1e4e8`, display: "flex", alignItems: "center", gap: 5 }}
                                                        onClick={() => handleSelect(id)}
                                                        title={n?.label && n.label !== id ? n.label : undefined}
                                                    >
                                                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</span>
                                                        <span style={{ fontSize: 10, color: "#888", flexShrink: 0 }}>{suffix}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                    // Refs not classified into upstream/downstream/group are structural/Association relationships (e.g. Segment/System containment, signal "has logical start/end").
                                    // Grouped by their raw ref.property and rendered as separate labeled sections below Group.
                                    const otherGroups = new Map(); // property -> Set<id>
                                    (selectedNode.refs || []).forEach(r => {
                                        if (isConnectivityRefProperty(r.property)) return;
                                        if (!otherGroups.has(r.property)) otherGroups.set(r.property, new Set());
                                        r.objects.forEach(id => id && otherGroups.get(r.property).add(id));
                                    });
                                    return (
                                        <div>
                                            {makeList(conn.upstream,   "#0969da", "Upstream Node")}
                                            {makeList(conn.downstream, "#1a7f37", "Downstream Node")}
                                            {makeList(conn.group,      "#8250df", "Group")}
                                            {[...otherGroups.entries()].map(([property, ids]) => (
                                                <React.Fragment key={property}>
                                                    {makeList(ids, "#57606a", CONNECTION_TYPE_LABELS[property] || property)}
                                                </React.Fragment>
                                            ))}
                                        </div>
                                    );
                                })()}
                            </div>
                        )}
                        {rightTab === "issues" && (
                            <div style={S.section}>
                                {!selectedNode ? (
                                    <div style={{ color: "#888", fontSize: 12 }}>Select an object.</div>
                                ) : !validationStarted ? (
                                    <div style={{ color: "#888", fontSize: 12 }}>Run validation first (toolbar "Run Validation" button) to see issues for this object.</div>
                                ) : (() => {
                                    const nodeIssues = issuesByObjectId.get(selectedId) || [];
                                    if (nodeIssues.length === 0) return <div style={{ color: "#888", fontSize: 12 }}>No validation issues for this object.</div>;
                                    return nodeIssues.map((issue, i) => (
                                        <div key={issue.key ?? i} style={{ padding: "8px 0", borderBottom: i < nodeIssues.length - 1 ? "1px solid #eef2f6" : "none" }}>
                                            <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                                                <span style={S.badge(SEV_COLORS[issue.severity])}>{SEV_LABELS[issue.severity]}</span>
                                                <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#24292f" }}>{issue.code}</span>
                                            </div>
                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#57606a", marginBottom: 2 }}>{issue.codeLabel}</div>
                                            <div style={{ fontSize: 12, color: "#333" }}>{issue.message}</div>
                                        </div>
                                    ));
                                })()}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {explorerOpen && folderResults?.length > 0 && (
                <ErrorExplorer
                    issues={folderIssues}
                    files={folderFilesRef.current}
                    folderName={folderName}
                    fileCount={folderResults.length}
                    onOpenFile={path => { setExplorerOpen(false); openFolderFile(path); }}
                    onClose={() => setExplorerOpen(false)}
                />
            )}
        </div>
    );
}
