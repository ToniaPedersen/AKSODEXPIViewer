import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor, isConnectivityRefProperty,
} from "./dexpiParser.js";
import { parseProteusPackage } from "./proteusParser.js";

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

function renderPrimitive(primitive, key, textColorOverride = null) {
    const fill = v => v?.style === "Transparent" ? "none" : (v?.color || "none");
    if (primitive.kind === "polyline") return <polyline key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "polygon") return <polygon key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "circle") return <circle key={key} cx={primitive.center.x} cy={primitive.center.y} r={primitive.radius} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "ellipse") return <ellipse key={key} cx={primitive.center.x} cy={primitive.center.y} rx={primitive.rx} ry={primitive.ry} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "rect") return <rect key={key} x={primitive.center.x - primitive.width / 2} y={primitive.center.y - primitive.height / 2} width={primitive.width} height={primitive.height} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
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
        return <path key={key} d={d} fill="none" stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
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

function ConnectorLineSvg({ el, nodePosMap, selected, connColor, strokeAdjust }) {
    const { primitive: prim } = el;
    const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
    const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
    const pts = [src, ...prim.innerPoints, tgt].filter(Boolean);
    if (pts.length < 2) return null;
    const color = connColor || (selected ? "#d1242f" : prim.stroke.color);
    const minWidth = 0.5;
    const baseWidth = prim.stroke.width;
    const sw = selected
        ? Math.max(baseWidth * 2, baseWidth + 0.4)
        : (strokeAdjust ? Math.max(baseWidth, minWidth) : baseWidth);
    const rawDash = prim.stroke.dashArray || "";
    const scaledDash = (!selected && rawDash && baseWidth > 0 && sw > baseWidth)
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

function SymbolGraphic({ el, selected, connHighlight, onSelect }) {
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
                {el.variant.primitives.map((p, i) => renderPrimitive(p, `${el.key}_${i}`))}
                {hlColor && <rect x={el.variant.minX - 0.8} y={el.variant.minY - 0.8} width={(el.variant.maxX - el.variant.minX) + 1.6} height={(el.variant.maxY - el.variant.minY) + 1.6} fill="none" stroke={hlColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </g>
        </g>
    );
}

function PrimitiveGraphic({ el, selected, connHighlight, onSelect, nodePosMap, strokeAdjust }) {
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
                ? <ConnectorLineSvg el={el} nodePosMap={nodePosMap} selected={selected} connColor={connHighlight} strokeAdjust={strokeAdjust} />
                : renderPrimitive(prim, el.key, prim?.kind === "text" ? hlColor : null)}
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
    const [strokeAdjust, setStrokeAdjust] = useState(true);
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
    async function handleBgFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => setBgImage({ src: ev.target.result, opacity: 0.4, scale: 1, offsetX: 0, offsetY: 0, visible: true });
        reader.readAsDataURL(file);
        e.target.value = "";
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
        selectedNode.refs
            .filter(ref => !isConnectivityRefProperty(ref.property))
            .forEach(ref => ref.objects.forEach(id => { if (id) ids.add(id); }));
        return ids;
    }, [selectedNode, selectHighlightSubComponents]);

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

    // width/height here just bound the box the image is laid out in - objectFit:
    // "contain" (plus objectPosition top-left, matching transformOrigin) makes the
    // browser preserve the image's native aspect ratio inside that box instead of
    // stretching it to exactly fill 100% width AND 100% height (which distorted
    // images whose aspect ratio didn't match the viewport's).
    const bgStyle = bgImage ? { transform: `translate(${bgImage.offsetX}px, ${bgImage.offsetY}px) scale(${bgImage.scale})`, transformOrigin: "top left", opacity: bgImage.opacity, position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "contain", objectPosition: "top left", pointerEvents: "none", display: bgImage.visible ? "block" : "none" } : {};

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
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parsed?.meta?.drawingNumber || ""}</div>
                        <div style={{ fontSize: 12, color: "#57606a" }}>{parsed?.meta?.drawingName || ""}{parsed?.meta?.subtitle ? ` - ${parsed.meta.subtitle}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn} onClick={() => { if (!parsed) return; const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); }} title="Fit drawing to window">Fit</button>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Connectivity mode: highlights the upstream (blue), downstream (green), and group (purple) connections of the selected object. Hidden by default - check this box to show the highlight.">
                            <input type="checkbox" checked={showConnectivity} onChange={e => setShowConnectivity(e.target.checked)} />
                            Connectivity
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, selecting an object also highlights (red) all of its sub-components in the drawing. When unchecked, only the selected object itself is highlighted.">
                            <input type="checkbox" checked={selectHighlightSubComponents} onChange={e => setSelectHighlightSubComponents(e.target.checked)} />
                            Sub-components
                        </label>
                        <button style={{ ...S.btn, background: strokeAdjust ? "#eaf2ff" : "white" }} onClick={() => setStrokeAdjust(p => !p)} title="Stroke adjustment: boosts very thin connector lines to a minimum visible width.">Line weight</button>
                        <button style={S.btn} onClick={() => bgInputRef.current?.click()} title="Overlay an image behind the drawing">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBgFile} />
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Labels synthesized from the loaded DiscProfile.xml's LabelTemplate definitions, shown for symbols whose object carries no Label XML element of its own.">
                            <input type="checkbox" checked={showProfileLabels} onChange={e => setShowProfileLabels(e.target.checked)} />
                            Profile labels
                        </label>
                        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>Scroll to zoom · Space+drag to pan</span>
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
                            <input type="range" min={-500} max={500} step={1} value={bgImage.offsetX} onChange={e => setBgImage(b => ({ ...b, offsetX: parseInt(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={1} value={bgImage.offsetX} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetX: v })); }} style={S.numBox} title="X offset (px)" />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Y
                            <input type="range" min={-500} max={500} step={1} value={bgImage.offsetY} onChange={e => setBgImage(b => ({ ...b, offsetY: parseInt(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={1} value={bgImage.offsetY} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetY: v })); }} style={S.numBox} title="Y offset (px)" />
                        </label>
                        <button style={{ ...S.btnSmall, color: "#cf222e" }} onClick={() => { setBgImage(null); setShowBgControls(false); }}>Remove</button>
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
                    {bgImage && <img src={bgImage.src} alt="background overlay" style={bgStyle} draggable={false} />}
                    <svg viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} width="100%" height="100%" style={{ display: "block" }} onAuxClick={e => e.preventDefault()}>
                        {parsed?.graphics.elements
                            // "lbltpl_"-prefixed keys are the LabelTemplate-synthesized
                            // labels (see buildProteusGraphics()'s label fallback in
                            // proteusParser.js) - hidden here when the Profile labels
                            // checkbox is off, leaving real <Label> XML-derived text
                            // (key prefix "lbl_") untouched either way.
                            .filter(el => showProfileLabels || !el.key.startsWith("lbltpl_"))
                            .map(el => {
                            const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                            const ch = connectivityHighlight;
                            const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                            if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} />;
                            return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} strokeAdjust={strokeAdjust} />;
                        })}
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
                                    {selectedNode?.objectId && <div style={{ marginTop: 6, fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{selectedNode.objectId}</div>}
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
