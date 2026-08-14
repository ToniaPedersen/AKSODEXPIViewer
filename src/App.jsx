import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor, isConnectivityRefProperty,
} from "./dexpiParser.js";
import { parseProteusPackage, SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES, TREE_CONTAINMENT_REF_PROPERTIES } from "./proteusParser.js";
import { jsPDF } from "jspdf";
import {
    isPngBytes, readPngEmbeddedPlacement, writePngEmbeddedPlacement, png_stripPlacementChunk,
} from "./pngPlacement.js";

// Connections tab: friendly display labels for the "other" (non-upstream/
// downstream/group) ref types produced by proteusParser.js's
// deriveProteusFlowConnectivity() - Segment/System containment and signal
// Association types. Any property not listed here falls back to showing its
// raw string as-is (e.g. pre-existing Association types like "is located
// in"), so this map only needs entries where the raw internal property key
// (deliberately plain, to avoid colliding with isConnectivityRefProperty()'s
// substring matching - see that function's doc comment) isn't already a
// good enough display label on its own.
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

// GenericAttributes/@Set values that carry real DEXPI-modeled attributes.
// Everything else (vendor/tool-specific Sets, or GenericAttributes with no
// Set at all) is hidden from the Data panel by default - see
// proteusParser.js's resolveObjectData() for where each data entry's `set`
// field comes from. Entries with `set === undefined` (native DEXPI 2.x files,
// which have no GenericAttributes/Set concept at all) are always shown.
const DEXPI_ATTRIBUTE_SETS = new Set(["DexpiAttributes", "DexpiCustomAttributes"]);

// ---------- Data value formatting --------------------------------------------

/**
 * Render a parsed data value into a human-readable string or JSX.
 * Handles PhysicalQuantity (UoM), DataReference (enums), strings, numbers, etc.
 */
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
    input: { width: "100%", padding: "6px 8px", border: "1px solid #c7ced6", borderRadius: 6, boxSizing: "border-box", fontSize: 13 },
    numBox: { width: 52, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    // Wide enough for an "nnn.nnnn" value (3 integer digits, 4 decimal places) without clipping.
    numBoxWide: { width: 88, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    tabBar: { display: "flex", gap: 0, borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    tab: (active) => ({ padding: "8px 14px", cursor: "pointer", fontWeight: active ? 700 : 400, fontSize: 13, color: active ? "#0969da" : "#57606a", background: "none", border: "none", borderBottom: active ? "2px solid #0969da" : "2px solid transparent" }),
    collapseBtn: { width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#57606a" },
    badge: (color) => ({ display: "inline-block", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: color || "#eef2f6", color: color ? "white" : "#444" }),
};


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

function renderPrimitive(primitive, key, textColorOverride = null, strokeMult = 1) {
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
        // Proteus/DEXPI Text String values can carry embedded line breaks
        // (XML char refs like &#xA; decode to real \n characters before we
        // ever see them here). A single SVG <text> doesn't auto-wrap on \n,
        // so each line is rendered as its own <tspan>, stacked vertically,
        // with the block anchored (top/middle/bottom) around position.y the
        // same way a single line would be - so single-line text renders
        // identically to before.
        const lines = String(primitive.value ?? "").split(/\r\n|\r|\n/);
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

// Proteus/DISC files (parsed via proteusParser.js) represent pipe/instrument
// centerlines as plain "primitive" polylines (elementRole "connector"), NOT
// as the "connectorLine" kind that dexpiParser.js's own pipeline produces -
// so Line Boost has to be applied here too. Width is a non-scaling-stroke
// (constant screen-pixel width regardless of zoom), matching this element's
// original rendering - boostPct=100 is a no-op, so nothing changes unless
// the user raises it.
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
// Proteus InformationFlow (signal/instrument wire) CenterLines are decorated
// according to the DEXPI custom attribute SignalConveyingFunctionType-
// Representation (Set="DexpiCustomAttributes") - see proteusParser.js's
// buildProteusGraphics(), which carries the raw attribute value through as
// el.signalConveyingType. Each entry here is the small glyph repeated along
// the line's length for that representation value; only
// "ElectricalSignalConveying" (italic "E"), "HydraulicSignalConveying"
// (upright "L"), "BusSignalConveying" (small circle),
// "PneumaticSignalConveying" (a "^" chevron), "CapillarySignalConveying"
// (a small "x"), "UndefinedSignalConveying" (a small "/") and
// "ElectromagneticGuidedSignalConveying"/"ElectromagneticUnguidedSignal-
// Conveying" (a small "∿" sine-wave squiggle) have a defined convention so
// far - plain "SignalConveying" is left undecorated until its own
// convention is specified.
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
// Representation values whose own drawn CenterLine should be hidden
// entirely, leaving only the repeated mark - used for
// ElectromagneticUnguidedSignalConveying, which (unlike a guided wire) has
// no physical conductor to draw a continuous line for.
const SIGNAL_MARK_HIDE_LINE_TYPES = new Set(["ElectromagneticUnguidedSignalConveying"]);
const SIGNAL_MARK_SPACING = 14;  // world units between repeated glyphs
const SIGNAL_MARK_HEIGHT = 2.4;  // glyph cap-height, world units
const SIGNAL_MARK_WIDTH = 1.6;   // glyph width, world units (E only - L's arms are square, see below)
const SIGNAL_MARK_STROKE = 0.16; // glyph stroke width, world units - thin, close to the line's own weight
const SIGNAL_MARK_LEAN = 0.55;   // horizontal shear per unit of y (~29 deg) - a pronounced italic slant, E only
const SIGNAL_MARK_CIRCLE_RADIUS = 0.9; // "O" (Bus) circle radius, world units
const SIGNAL_MARK_CARET_WIDTH = 1.8;   // "^" (Pneumatic) chevron width, world units
const SIGNAL_MARK_X_WIDTH = 1.6;       // "x" (Capillary) cross width, world units
const SIGNAL_MARK_SLASH_WIDTH = 1.6;   // "/" (Undefined) stroke width, world units
const SIGNAL_MARK_WAVE_WIDTH = 2.4;    // "∿" (Electromagnetic Guided) one full wave cycle's width, world units

// Vector glyph paths for the marks above, drawn as monoline strokes rather
// than system-font text: font-based dominant-baseline centering doesn't
// reliably land on a letter's own visual middle (varies by browser/font),
// and font glyphs don't give exact control over stroke weight or slant
// angle. Each path is built in a local frame where y=0 is the line the
// glyph sits on - so placing a mark at (x, y) on the polyline with y=0 in
// this local frame puts the glyph precisely on the line (not just its
// bounding box), and x=0 is the glyph's leading edge along the line's own
// direction.
function buildSignalMarkPaths() {
    const h2 = SIGNAL_MARK_HEIGHT / 2;
    const w = SIGNAL_MARK_WIDTH;
    const lean = SIGNAL_MARK_LEAN;
    // Italic "E": lean is baked directly into each stroke's endpoints
    // (rather than an SVG skewX transform) so it reads correctly regardless
    // of the per-mark rotation applied afterwards. y=0 (the line) passes
    // through the glyph's middle bar.
    const lx = (x, y) => x - lean * y; // shifts top-of-glyph right, bottom left (standard italic lean)
    const tl = { x: lx(0, -h2), y: -h2 }, tr = { x: lx(w, -h2), y: -h2 };
    const bl = { x: lx(0, h2), y: h2 }, br = { x: lx(w, h2), y: h2 };
    const ml = { x: lx(0, 0), y: 0 }, mr = { x: lx(w * 0.75, 0), y: 0 };
    const ePath = `M${tl.x},${tl.y} L${tr.x},${tr.y} M${tl.x},${tl.y} L${bl.x},${bl.y} M${bl.x},${bl.y} L${br.x},${br.y} M${ml.x},${ml.y} L${mr.x},${mr.y}`;

    // Upright "L": vertical and horizontal arms are the same length
    // (SIGNAL_MARK_HEIGHT), and the line (y=0) passes through the middle of
    // the vertical arm, which runs from -h2 to +h2 with the horizontal arm
    // extending right from its foot.
    const lTop = { x: 0, y: -h2 }, lBottom = { x: 0, y: h2 }, lFoot = { x: SIGNAL_MARK_HEIGHT, y: h2 };
    const lPath = `M${lTop.x},${lTop.y} L${lBottom.x},${lBottom.y} L${lFoot.x},${lFoot.y}`;

    // "O" (Bus): a small circle whose center sits at y=0, so the line
    // passes straight through its middle. Drawn as two half-circle arcs
    // (the usual SVG trick for a full circle in one path, since a single
    // arc command can't span 360deg), positioned so it starts at its own
    // leading edge (x=0) the same way the other glyphs do.
    const r = SIGNAL_MARK_CIRCLE_RADIUS;
    const oPath = `M${r * 2},0 A${r},${r} 0 1 0 0,0 A${r},${r} 0 1 0 ${r * 2},0`;

    // "^" (Pneumatic): a chevron whose apex sits above the line and whose
    // two feet sit below it, symmetric about y=0 so the line runs through
    // the vertical middle of the shape (same convention as the "L" arm and
    // "O" circle above).
    const cw = SIGNAL_MARK_CARET_WIDTH;
    const caretLeft = { x: 0, y: h2 }, caretApex = { x: cw / 2, y: -h2 }, caretRight = { x: cw, y: h2 };
    const caretPath = `M${caretLeft.x},${caretLeft.y} L${caretApex.x},${caretApex.y} L${caretRight.x},${caretRight.y}`;

    // "x" (Capillary): two diagonal strokes corner-to-corner of a bounding
    // box centered on y=0. Diagonals of a rectangle always cross at its
    // center, so the line automatically runs straight through the cross
    // point without any extra alignment math.
    const xw = SIGNAL_MARK_X_WIDTH;
    const xPath = `M0,${-h2} L${xw},${h2} M0,${h2} L${xw},${-h2}`;

    // "/" (Undefined): a single diagonal stroke, bottom-left to top-right,
    // within a bounding box centered on y=0 - its midpoint therefore falls
    // exactly on the line, same "diagonal of a centered box" trick as "x".
    const sw_ = SIGNAL_MARK_SLASH_WIDTH;
    const slashPath = `M0,${h2} L${sw_},${-h2}`;

    // "∿" (Electromagnetic Guided): one full sine-like wave cycle, built
    // from two symmetric cubic-bezier humps. It starts and ends on y=0 and
    // also crosses y=0 at its midpoint, so - like the other marks - the
    // line runs straight through its vertical center throughout.
    const ww = SIGNAL_MARK_WAVE_WIDTH;
    const waveQ = ww / 4;
    const wavePath = `M0,0 C${waveQ},${-h2} ${waveQ},${-h2} ${waveQ * 2},0 `
        + `C${waveQ * 3},${h2} ${waveQ * 3},${h2} ${ww},0`;

    return { E: ePath, L: lPath, O: oPath, "^": caretPath, x: xPath, "/": slashPath, "∿": wavePath };
}
const SIGNAL_MARK_PATHS = buildSignalMarkPaths();

// Marches at a fixed spacing along a polyline's arc length and returns a
// {x, y, angleDeg} sample at each step. angleDeg follows the local segment's
// direction but is normalized to stay within (-90, 90] so the glyph is
// always drawn upright/readable regardless of which way the line's points
// happen to be ordered.
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

// Renders a small italic vector glyph (e.g. "E" for ElectricalSignalConveying)
// repeated along an InformationFlow signal wire's drawn length - see
// SIGNAL_CONVEYING_MARKS/SIGNAL_MARK_PATHS above.
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
//   label elements  → orange  (they are annotation overlays, not primary symbols)
//   all other types → red
function selectionColor(elementRole) {
    return elementRole === "label" ? "#e06c00" : "#d1242f";
}

// ---------- Heat trace overlays ----------------------------------------------
// Ported from the main DEXPIViewer app's src/App.jsx (same constants/visual
// style, so heat tracing looks identical here) - see
// dexpiParser.js's buildHeatTraceSet() for how parsed.heatTraceSet
// (objectId -> "inline"|"nozzle"|"pif"|"piping") is computed from
// HeatTracingType inheritance down the tree.
const HT_COLOR  = "#e06000";
const HT_DASH   = "6 2 6 2";  // dash-dash pattern
const HT_SW     = 0.6;         // stroke width (SVG units)
const HT_OFF    = 1.5;         // offset distance (~1 pt) from pipe / symbol edge
const HT_THRESH = 0.15;        // |sin| or |cos| threshold for axis-alignment (~8.6 deg)

// Heat trace dashed line for a Proteus CenterLine polyline (a segment's own
// pipe-routing geometry - see proteusParser.js's buildProteusGraphics()).
// Unlike DEXPIViewer's native-DEXPI HeatTraceConnectorLine (which resolves
// its points from a sourceRef/targetRef/nodePosMap), a Proteus polyline
// already carries its own absolute world-space points directly, so this is
// a simplified variant of the same per-segment horizontal/vertical offset
// logic, with no point-resolution step needed.
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

// Computes the axis-aligned bounding box of a symbol in diagram (world)
// space by transforming all four local corners through the full placement
// transform - used by HeatTraceSymbol below to place its offset line
// correctly for any rotation/mirror.
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
// Orientation is determined from el.rotation: horizontal pipe -> line 1 pt
// below the symbol in diagram space; vertical pipe -> line 1 pt right of the
// symbol; corner/diagonal -> line 1 pt below (default).
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

// Heat trace overlay for a ProcessInstrumentationFunction symbol: traces the
// actual outer boundary primitives of the symbol (circle, ellipse, polygon)
// expanded outward, so it follows the real symbol shape rather than a
// bounding-box rectangle. Falls back to a bounding-box rect when no boundary
// primitive is found.
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

function PrimitiveGraphic({ el, selected, connHighlight, onSelect, nodePosMap, boostPct, boostSymbolOutlines }) {
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
                        : renderPrimitive(prim, el.key, prim?.kind === "text" ? hlColor : null, (boostSymbolOutlines && el.elementRole === "symbol") ? boostPct / 100 : 1)}
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
    const [rightTab, setRightTab] = useState("details");
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
    // Part A - Draw-Order Override ("Send to Back"): a Set of represented-
    // object ids whose graphic(s) have been moved to the front of the paint
    // order (so they render/click *behind* everything else). View-only,
    // in-memory, reset on every (re)parse - see rebuild() below.
    const [zOrderOverrides, setZOrderOverrides] = useState(new Set());
    // Connectivity checkbox: checking it SHOWS the upstream/downstream/group
    // highlight for the selected object; unchecked (the default) hides it.
    // See connectivityHighlight below and the legend near the drawing
    // canvas, both of which gate on this flag alone - previously this also
    // OR'd in "rightTab === 'connectivity'" so the highlight would appear
    // whenever the Connections tab was open regardless of the checkbox,
    // which made the checkbox appear broken/ignored while browsing
    // connections there. The checkbox is now the sole control.
    const [showConnectivity, setShowConnectivity] = useState(false);
    // Whether selecting an object also highlights (red) all of its
    // sub-components in the drawing, or just the object itself - see
    // selectedRepresentedIds below. Default false: selecting a large
    // container (e.g. a PipingNetworkSegment or System) no longer paints
    // its entire subtree red by default.
    const [selectHighlightSubComponents, setSelectHighlightSubComponents] = useState(false);
    // Line Boost: percentage multiplier on connector/centerline stroke width.
    // 100 = unchanged (no-op), so nothing is boosted until the user raises it.
    const [lineBoostPct, setLineBoostPct] = useState(100);
    const [boostSymbolOutlines, setBoostSymbolOutlines] = useState(false);
    // Opacity of the drawing's own DEXPI/Proteus graphics (the symbols,
    // lines, and labels parsed from the loaded Proteus XML) - independent of
    // the separate BG Image opacity control below. 1 = fully opaque (no-op).
    const [drawingOpacity, setDrawingOpacity] = useState(1);
    // Whether LabelTemplate-synthesized labels (drawn when an object carries
    // no <Label> XML of its own - see proteusParser.js's buildProteusGraphics()
    // label fallback) are shown in the drawing. Default false; check the box
    // to see labels synthesized from the loaded DiscProfile.xml's
    // LabelTemplate definitions for symbols with no explicit Label XML.
    const [showProfileLabels, setShowProfileLabels] = useState(false);
    const [showAllAttributes, setShowAllAttributes] = useState(false); // default: hide non-DEXPI attributes
    const [spaceDown, setSpaceDown] = useState(false);

    const mainInputRef = useRef(null);
    const discInputRef = useRef(null);
    const bgInputRef = useRef(null);
    const svgViewportRef = useRef(null);
    const svgElRef = useRef(null);
    const [exporting, setExporting] = useState(false);
    // Part B - BG Image Default Placement: the object URL currently backing
    // bgImage's displayed <image>, so it can be revoked on replace/remove/
    // unmount without leaking blob URLs.
    const bgObjectUrlRef = useRef(null);

    const connectivityHighlight = useMemo(() => {
        if (!showConnectivity || !selectedId || !parsed?.connectivityMap) return { upstream: new Set(), downstream: new Set(), group: new Set() };
        return parsed.connectivityMap.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
    }, [showConnectivity, selectedId, parsed]);

    function rebuild(nextMain, nextDisc) {
        if (!nextMain || !nextDisc) return;
        try {
            const p = parseProteusPackage(nextMain, nextDisc);
            const b = boundsFromElements(p.graphics);
            setFullBounds(b);
            setParsed(p);
            setSelectedId(p.tree.objectId);
            setExpanded(new Set([p.tree.id, ...p.tree.children.slice(0, 5).map(c => c.id)]));
            setViewBox({ x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) });
            setParseError("");
            // FR-6: loading/reloading a file clears all draw-order overrides.
            setZOrderOverrides(new Set());
        } catch (e) { setParseError(e.message || String(e)); }
    }

    async function handleMainFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setMainXmlText(txt); setMainFileLoaded(true);
        setMainFileName(file.name);
        rebuild(txt, discXmlText);
    }

    async function handleDiscFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setDiscXmlText(txt); setDiscFileLoaded(true);
        setDiscFileName(file.name);
        rebuild(mainXmlText, txt);
    }
    // Part B - BG Image Default Placement (FR-2, FR-7). Reads the picked
    // file as raw bytes (not a base64 data URL - the file's own bytes are
    // what Save/Update/Clear/Download operate on) and checks the PNG magic
    // signature. If it's a PNG carrying a valid embedded
    // dexpi:bgPlacement default (readPngEmbeddedPlacement - falls back to
    // null on a non-PNG, missing, or corrupted/foreign chunk per FR-7), that
    // placement seeds scale/offsetX/offsetY instead of the auto-fit values.
    // The image itself is displayed via an object URL over those same raw
    // bytes, revoked on replace/remove/unmount (bgObjectUrlRef).
    async function handleBgFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        e.target.value = "";
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const isPng = isPngBytes(bytes);
        const embeddedPlacement = isPng ? readPngEmbeddedPlacement(bytes) : null;
        const placement = embeddedPlacement || { scale: 1, offsetX: 0, offsetY: 0 };

        if (bgObjectUrlRef.current) { URL.revokeObjectURL(bgObjectUrlRef.current); bgObjectUrlRef.current = null; }
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.type || (isPng ? "image/png" : "") }));
        bgObjectUrlRef.current = objectUrl;

        const base = {
            objectUrl, sourceBytes: bytes, isPng, fileName: file.name,
            embeddedPlacement,
            opacity: 0.4, scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY, visible: true,
        };
        // Load the raw pixel dimensions so the overlay can be fit into the
        // drawing's coordinate space (fullBounds) preserving aspect ratio,
        // instead of guessing a scale in unrelated CSS-pixel units.
        const probe = new Image();
        probe.onload = () => { setBgImage({ ...base, naturalWidth: probe.naturalWidth, naturalHeight: probe.naturalHeight }); };
        probe.onerror = () => { setBgImage({ ...base, naturalWidth: 0, naturalHeight: 0 }); };
        probe.src = objectUrl;
    }

    // Revoke the current BG image object URL on unmount only - replacement/
    // removal revoke it inline at the point of change (handleBgFile, Remove).
    useEffect(() => {
        return () => { if (bgObjectUrlRef.current) URL.revokeObjectURL(bgObjectUrlRef.current); };
    }, []);

    // Embeds the current Scale / X / Y directly into a copy of the loaded
    // PNG's bytes and downloads it in one action - no separate "save" step.
    // The originally-selected file on disk is never modified; see
    // downloadBgPlacementPng() just below for the actual download.
    function clearBgDefault() {
        setBgImage(b => {
            if (!b || !b.isPng || !b.embeddedPlacement) return b;
            try {
                const newBytes = png_stripPlacementChunk(b.sourceBytes);
                const blob = new Blob([newBytes], { type: "image/png" });
                const base = (b.fileName || "image.png").replace(/\.png$/i, "");
                downloadBlob(blob, `${base}-placement.png`);
                return { ...b, sourceBytes: newBytes, embeddedPlacement: null };
            } catch (err) {
                alert("Could not clear the placement default: " + (err.message || String(err)));
                return b;
            }
        });
    }

    // Embeds the current Scale / X / Y into a copy of the loaded PNG's bytes
    // and immediately downloads it - the one action that replaces the old
    // two-step "Save as Default" then "Download PNG with placement" flow.
    // The originally-selected file on disk is never modified.
    function downloadBgPlacementPng() {
        setBgImage(b => {
            if (!b || !b.isPng) return b;
            try {
                const placement = { scale: b.scale, offsetX: b.offsetX, offsetY: b.offsetY };
                const newBytes = writePngEmbeddedPlacement(b.sourceBytes, placement);
                const blob = new Blob([newBytes], { type: "image/png" });
                const base = (b.fileName || "image.png").replace(/\.png$/i, "");
                downloadBlob(blob, `${base}-placement.png`);
                return { ...b, sourceBytes: newBytes, embeddedPlacement: placement };
            } catch (err) {
                alert("Could not save the placement into the PNG: " + (err.message || String(err)));
                return b;
            }
        });
    }

    // Export: rasterizes exactly what's currently on screen inside the SVG
    // viewport - the DEXPI drawing plus the BG image overlay, since (per the
    // fix above) the overlay now lives inside the same <svg viewBox=...> tree
    // rather than as a separate HTML element. Cloning that one <svg> node is
    // therefore enough to capture both layers together.
    //
    // viewBox.w/h are in the drawing's own native coordinate units, which have
    // no fixed relationship to CSS pixels and can be arbitrarily large or small
    // depending on the source file - multiplying them directly by a "pixel
    // scale" could ask the browser for a many-thousand-megapixel canvas and
    // crash the tab. Instead we target a fixed output resolution (long edge in
    // px) regardless of the viewBox's native magnitude.
    const EXPORT_LONG_EDGE_PX = 3000;

    async function renderViewboxToCanvas() {
        const svgEl = svgElRef.current;
        if (!svgEl) throw new Error("Drawing is not ready yet.");
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const aspect = viewBox.w / viewBox.h;
        const pxW = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX : EXPORT_LONG_EDGE_PX * aspect));
        const pxH = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX / aspect : EXPORT_LONG_EDGE_PX));
        clone.setAttribute("width", String(pxW));
        clone.setAttribute("height", String(pxH));

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
            // Page is sized to match the exported canvas's aspect ratio (long
            // edge fixed at 420mm/A3) - DEXPI/Proteus drawing coordinates aren't
            // reliably real-world units here, so this is a print-friendly fit
            // rather than a dimensionally-accurate scale.
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
        // Sub-components checkbox (see its state declaration above) is now
        // the sole gate for any red highlighting beyond the selected object
        // itself - unchecked (the default) means ONLY selectedNode's own id
        // is highlighted, full stop. Checked restores the prior behavior:
        // every tree descendant PLUS every non-connectivity Association/ref
        // target (e.g. an InformationFlow signal wire whose "has logical
        // end" Association points at the selected instrument) is included
        // too - previously that ref-based highlighting ran unconditionally,
        // which meant selecting e.g. a ProcessInstrumentationFunction lit up
        // every signal wire logically wired to it even with this box off.
        if (!selectHighlightSubComponents) {
            return new Set(selectedNode.objectId ? [selectedNode.objectId] : []);
        }
        const ids = collectDescendantObjectIds(selectedNode);
        // Connectivity refs (upstream/downstream/group - see
        // isConnectivityRefProperty()'s doc comment in dexpiParser.js) are
        // deliberately excluded here: they exist only to drive the separate
        // blue/green/purple connectivity highlight, and since "selected"
        // (red) always wins over that color, letting them leak in here would
        // make e.g. an upstream CenterLine neighbor render as if it were
        // itself selected - regardless of whether connectivity mode is even on.
        // Segment/System containment refs (see
        // SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES's doc comment in
        // proteusParser.js) are excluded for the same reason: they're
        // structural bookkeeping, not a real cross-reference - without this,
        // selecting any one member of a PipingNetworkSegment/System would
        // red-highlight the whole segment/system (and, transitively, anything
        // else - like a LineLabel-* line-number Label - that references it
        // back), rather than only when the segment/system itself is selected.
        selectedNode.refs
            .filter(ref => !isConnectivityRefProperty(ref.property)
                && !SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES.has(ref.property)
                && !TREE_CONTAINMENT_REF_PROPERTIES.has(ref.property))
            .forEach(ref => ref.objects.forEach(id => { if (id) ids.add(id); }));
        return ids;
    }, [selectedNode, selectHighlightSubComponents]);

    // Part A - Draw-Order Override ("Send to Back"). Every represented id
    // that has at least one associated graphic element - gates FR-1's
    // control so it's only offered where there's actually something to
    // reorder (see edge case: pure-graphic elements with no full model
    // object still qualify, since this is keyed off el.representedId, not
    // the tree).
    const representedIdsWithGraphics = useMemo(() => {
        const ids = new Set();
        parsed?.graphics?.elements?.forEach(el => { if (el.representedId) ids.add(el.representedId); });
        return ids;
    }, [parsed]);

    // The reordered list the SVG render loop actually iterates over:
    // elements whose represented id is in zOrderOverrides move to the
    // front, stable within that group; everything else keeps its original
    // relative order. O(n), and === parsed.graphics.elements (by content,
    // new array identity only when overrides are non-empty) when there are
    // no overrides.
    const paintOrderElements = useMemo(() => {
        const elements = parsed?.graphics?.elements;
        if (!elements) return [];
        if (zOrderOverrides.size === 0) return elements;
        const front = [];
        const rest = [];
        for (const el of elements) {
            if (el.representedId && zOrderOverrides.has(el.representedId)) front.push(el);
            else rest.push(el);
        }
        return [...front, ...rest];
    }, [parsed, zOrderOverrides]);

    // Adds/removes the currently selected object from the override set -
    // FR-2/FR-3's "Send to Back" / "Restore order" toggle.
    function toggleSendToBack() {
        if (!selectedId) return;
        setZOrderOverrides(prev => {
            const next = new Set(prev);
            if (next.has(selectedId)) next.delete(selectedId);
            else next.add(selectedId);
            return next;
        });
    }

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

    function expandAll() { if (!parsed) return; const ids = new Set(); flattenTree(parsed.tree).forEach(n => ids.add(n.id)); setExpanded(ids); }
    function collapseAll() { if (!parsed) return; setExpanded(new Set([parsed.tree.id])); }

    // The overlay is placed in the *drawing's* coordinate space (fullBounds),
    // not raw CSS/screen pixels - previously it was an absolutely-positioned
    // HTML <img> sized off the viewport div, so it only ever lined up with the
    // DEXPI drawing at the exact pan/zoom level it was calibrated at: the SVG
    // content moves and rescales with viewBox, but a plain HTML sibling doesn't,
    // so panning or zooming immediately dragged the two out of alignment again
    // (looked like a scaling bug, was really a "wrong coordinate system" bug).
    // Rendering it as an <image> inside the same <svg viewBox=...> ties it to
    // the identical transform as the drawing, so it now pans/zooms in lockstep.
    const boundsW = Math.max(1, fullBounds.maxX - fullBounds.minX);
    const boundsH = Math.max(1, fullBounds.maxY - fullBounds.minY);
    const bgPlacement = useMemo(() => {
        if (!bgImage) return null;
        let baseW = boundsW, baseH = boundsH, baseX = fullBounds.minX, baseY = fullBounds.minY;
        if (bgImage.naturalWidth && bgImage.naturalHeight) {
            // "Contain"-fit the image into fullBounds, centered, so scale=1/offset=0
            // starts out already aligned to the drawing extents instead of an
            // arbitrary default.
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
    // Tints the overlay a mid-dark blue while preserving the image's original
    // luminance/detail (mix-blend-mode "color" replaces hue+saturation only).
    const BG_TINT_COLOR = "#1e3a5f";

    const d = parsed?._diagnostics;

    return (
        <div style={S.app(leftCollapsed, rightCollapsed)}>
            {/* LEFT PANEL */}
            {leftCollapsed ? (
                <div style={S.collapsed}><button style={S.collapseBtn} onClick={() => setLeftCollapsed(false)} title="Expand">{">"}</button></div>
            ) : (
                <div style={S.panel}>
                    <div style={S.toolbar}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>DEXPI 1.3.1 / DISC Profile Viewer</div>
                            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                                <a href="UserGuide.html" target="_blank" rel="noopener noreferrer"
                                    style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", border: "1px solid #c7ced6", color: "#57606a", textDecoration: "none", fontSize: 12, fontWeight: 700 }}
                                    title="Open user guide">?</a>
                                <button style={S.collapseBtn} onClick={() => setLeftCollapsed(true)}>{"<"}</button>
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={{ ...S.btn, background: mainFileLoaded ? "#eaf2ff" : "white" }} onClick={() => mainInputRef.current?.click()}>{mainFileLoaded ? "✓ " : ""}Load Proteus XML</button>
                            <button style={{ ...S.btn, background: discFileLoaded ? "#eaf2ff" : "white" }} onClick={() => discInputRef.current?.click()}>{discFileLoaded ? "✓ " : ""}Load DiscProfile.xml</button>
                        </div>
                        <input ref={mainInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleMainFile} />
                        <input ref={discInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleDiscFile} />
                        {(mainFileName || discFileName) && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a" }}>
                                {mainFileName && (
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={mainFileName}>
                                        Proteus XML: <span style={{ fontWeight: 600, color: "#24292f" }}>{mainFileName}</span>
                                    </div>
                                )}
                                {discFileName && (
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={discFileName}>
                                        DiscProfile: <span style={{ fontWeight: 600, color: "#24292f" }}>{discFileName}</span>
                                    </div>
                                )}
                            </div>
                        )}
                        {(!mainFileLoaded || !discFileLoaded) && (
                            <div style={{ marginTop: 8, fontSize: 12, color: "#57606a" }}>Load both a Proteus 4.1.1 / DEXPI 1.3 XML file and a DEXPI 2.x DiscProfile.xml to view the drawing.</div>
                        )}
                        {d && (
                            <div style={{ marginTop: 8, fontSize: 11, color: "#57606a" }}>
                                {d.totalObjects} objects · {d.classMatchedViaRule1} class-mapped via TypeURI rule
                            </div>
                        )}
                    </div>

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
                </div>
            )}

            {/* CENTER PANEL */}
            <div style={{ position: "relative", overflow: "hidden", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
                <div style={{ ...S.toolbar, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {mainFileName && (
                        <div style={{ fontSize: 12, color: "#57606a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240, flexShrink: 0 }} title={mainFileName}>
                            Proteus XML: <span style={{ fontWeight: 600, color: "#24292f" }}>{mainFileName}</span>
                        </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parsed?.meta?.drawingNumber || ""}</div>
                        <div style={{ fontSize: 12, color: "#57606a" }}>{parsed?.meta?.drawingName || ""}{parsed?.meta?.subtitle ? ` - ${parsed.meta.subtitle}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn} onClick={() => { if (!parsed) return; const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); }} title="Fit drawing to window">Fit</button>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a" }} title="Connector/centerline stroke width as a percentage of its original width. 100% = unchanged; raise it to bulk up thin lines to match a BG reference image's line weight.">
                            Line Boost
                            <input type="number" min={1} step={1} value={lineBoostPct} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v > 0) setLineBoostPct(v); }} style={S.numBox} title="Line width, as a percentage of its original width" />
                            %
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, symbol outline strokes are boosted by the same Line Boost percentage as connector/centerlines. When unchecked, only connector/centerlines are affected.">
                            <input type="checkbox" checked={boostSymbolOutlines} onChange={e => setBoostSymbolOutlines(e.target.checked)} />
                            Include symbol outlines
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a" }} title="Opacity of the drawing's DEXPI graphics (symbols, lines, and labels parsed from the Proteus XML). Lower it to see through the drawing, e.g. when comparing against a BG reference image.">
                            Opacity
                            <input type="range" min={0} max={1} step={0.05} value={drawingOpacity} onChange={e => setDrawingOpacity(parseFloat(e.target.value))} style={{ width: 70 }} />
                            <input type="number" min={0} max={1} step={0.01} value={drawingOpacity} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setDrawingOpacity(Math.min(1, Math.max(0, v))); }} style={S.numBox} title="Opacity (0-1)" />
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
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Labels synthesized from the loaded DiscProfile.xml's LabelTemplate definitions, shown for symbols whose object carries no Label XML element of its own.">
                            <input type="checkbox" checked={showProfileLabels} onChange={e => setShowProfileLabels(e.target.checked)} />
                            Profile labels
                        </label>
                        {zOrderOverrides.size > 0 && (
                            <button style={S.btn} onClick={() => setZOrderOverrides(new Set())} title="Clear every 'Send to Back' draw-order override in one action">
                                Reset Z-Order ({zOrderOverrides.size})
                            </button>
                        )}
                        <button style={S.btn} onClick={() => bgInputRef.current?.click()} title="Overlay an image behind the drawing">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBgFile} />
                    </div>
                </div>

                {bgImage && showBgControls && (
                    <div style={{ padding: "6px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="checkbox" checked={bgImage.visible} onChange={e => setBgImage(b => ({ ...b, visible: e.target.checked }))} /> Visible
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Opacity
                            <input type="range" min={0} max={1} step={0.05} value={bgImage.opacity} onChange={e => setBgImage(b => ({ ...b, opacity: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={0} max={1} step={0.01} value={bgImage.opacity} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, opacity: Math.min(1, Math.max(0, v)) })); }} style={S.numBox} title="Opacity (0-1)" />
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
                        <button
                            style={{ ...S.btnSmall, opacity: bgImage.isPng ? 1 : 0.5, cursor: bgImage.isPng ? "pointer" : "not-allowed" }}
                            disabled={!bgImage.isPng}
                            onClick={downloadBgPlacementPng}
                            title={bgImage.isPng
                                ? "Embed the current Scale / X / Y into a copy of this PNG and download it, so the next time this image is loaded it starts at this placement instead of the auto-fit - the original file you selected is left untouched"
                                : "Only PNG supports an embedded placement default"}
                        >
                            ⬇ Download PNG with placement
                        </button>
                        {bgImage.isPng && bgImage.embeddedPlacement && (
                            <button style={S.btnSmall} onClick={clearBgDefault} title="Download a copy of this PNG with the saved placement default removed">Clear Default</button>
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
                        {bgImage && bgPlacement && (
                            <g style={{ display: bgImage.visible ? "inline" : "none", opacity: bgImage.opacity, pointerEvents: "none" }}>
                                <image href={bgImage.objectUrl} x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} preserveAspectRatio="none" />
                                <rect x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} fill={BG_TINT_COLOR} style={{ mixBlendMode: "color" }} />
                            </g>
                        )}
                        <g opacity={drawingOpacity}>
                        {paintOrderElements
                            // "lbltpl_"-prefixed keys are the LabelTemplate-synthesized
                            // labels (see buildProteusGraphics()'s label fallback in
                            // proteusParser.js) - hidden here when the Profile labels
                            // checkbox is off, leaving real <Label> XML-derived text
                            // (key prefix "lbl_") untouched either way.
                            //
                            // Part A - Draw-Order Override: paintOrderElements (not
                            // parsed.graphics.elements directly) is what determines
                            // paint/click order here, so a "Send to Back" override
                            // takes effect immediately with no other change to this loop.
                            .filter(el => showProfileLabels || !el.key.startsWith("lbltpl_"))
                            .map(el => {
                            const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                            const ch = connectivityHighlight;
                            const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                            if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} />;
                            return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} />;
                        })}
                        </g>
                        {/* Heat-trace overlays - rendered on top, only when a DiscProfile.xml
                            is loaded and at least one object resolves to an active
                            HeatTracingType (see dexpiParser.js's buildHeatTraceSet()). */}
                        {parsed?.heatTraceSet?.size > 0 && parsed.graphics.elements.map(el => {
                            // Never draw heat-trace overlays on label or annotation elements
                            if (el.elementRole === "label") return null;
                            // Proteus CenterLine polylines bridge through htSegmentId (see
                            // proteusParser.js's buildProteusGraphics()) since the synthetic
                            // CenterLine tree node itself is never RDL-eligible for
                            // HeatTracingType inheritance - only its owning
                            // PipingNetworkSegment is, so the lookup below uses the
                            // segment's id rather than el.representedId (the CenterLine's
                            // own id) for this one case.
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
                        {[["details", "Object"], ["connectivity", "Connections"]].map(([t, label]) => (
                            <button key={t} style={S.tab(rightTab === t)} onClick={() => setRightTab(t)}>{label}</button>
                        ))}
                    </div>
                    <div style={S.scroll}>
                        {rightTab === "details" && (
                            <>
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedNode?.label || "No selection"}</div>
                                    <div style={{ fontSize: 12, color: "#57606a" }}>{selectedNode?.type || ""}</div>
                                    {selectedNode?.objectId && (
                                        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                            <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{selectedNode.objectId}</div>
                                            {representedIdsWithGraphics.has(selectedNode.objectId) && (
                                                <>
                                                    <button
                                                        style={S.btnSmall}
                                                        onClick={toggleSendToBack}
                                                        title="Move this object's symbol behind everything else in the drawing, so overlapping or nested items underneath it become clickable/selectable"
                                                    >
                                                        {zOrderOverrides.has(selectedNode.objectId) ? "↺ Restore order" : "⇩ Send to Back"}
                                                    </button>
                                                    {zOrderOverrides.has(selectedNode.objectId) && (
                                                        <span style={S.badge("#57606a")} title="This object's draw order has been overridden">Sent to back</span>
                                                    )}
                                                </>
                                            )}
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
                                    // Proteus/DEXPI-1.3 only (see buildProteusGraphics()'s
                                    // symbolReferences in proteusParser.js - always empty for
                                    // native DEXPI 2.0 files, so this section just never shows
                                    // for those). Keyed by the same representedId a symbolUsage
                                    // graphics element carries - i.e. whichever element actually
                                    // owns the ComponentName+Position that placed the symbol
                                    // (a standalone Label itself, for symbols like a
                                    // SpecialItemLabel's lock/special-item marker - not the
                                    // object that Label happens to annotate), so selecting the
                                    // symbol on the drawing (or its tree node) shows exactly what
                                    // placed it, matching the source XML's own Position block.
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
                                    // Label Symbol Reference: an OWNER object (e.g. GateValve-1)
                                    // can carry its own nested <Label ComponentName="..."> placing
                                    // a SEPARATE symbol of its own (e.g. an actuator/instrument
                                    // marker such as GateValve-1-Label-1's ComponentName=
                                    // "IM005B_SHAPE") - distinct from the owner's own "Symbol
                                    // Reference" above (GateValve-1's own ComponentName=
                                    // "PV005B_SHAPE"). labelSymbolReferencesByOwner (see
                                    // proteusParser.js's buildProteusGraphics()) is keyed by the
                                    // OWNER's id so this shows up here directly, without having to
                                    // separately select the nested Label's own tree node.
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
                                    // Notes: Note ItemIDs referenced by any DependantAttribute on any of
                                    // this element's (or its nested Labels') Text templates. Populated
                                    // unconditionally, regardless of whether the reference resolves to
                                    // anything else meaningful.
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
                                                // suffix comes from the node's own `type` (e.g. "Plant/Segment.CenterLine"
                                                // -> "CenterLine"), not a ComponentClass lookup - CenterLine entries have
                                                // no ComponentClass of their own in the source XML, so this is the only
                                                // place that label comes from.
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
                                    // Everything NOT classified into upstream/downstream/group by
                                    // buildConnectivityMap() (i.e. every ref for which
                                    // isConnectivityRefProperty() is false) is a structural/Association
                                    // relationship rather than physical (x/y-position-derived)
                                    // connectivity - e.g. Segment/System containment or a signal wire's
                                    // "has logical start"/"has logical end". These are grouped by their
                                    // raw ref.property and rendered as their own separate, labeled
                                    // sections below Group, using the same list styling, so they're
                                    // visible without being conflated with genuine geometric connections.
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
                    </div>
                </div>
            )}
        </div>
    );
}
