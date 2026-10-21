// Proteus 4.1.1 / DEXPI 1.4 (<PlantModel> root) parser.
//
// Parses a Proteus/DEXPI XML file into the same tree + graphics model
// produced by dexpiParser.js's parseDexpiPackage().
//
// Mapping rules, evaluated against a loaded DiscProfile.xml:
//   1. class:     GenericAttribute[Name="TypeURIAssignmentClass"]/@Value
//                 == ConcreteClass/AbstractClass's Data[property="MetaData/rdl_uri"]
//   2. symbol:    ShapeCatalogue element's nested
//                 GenericAttribute[Name="SymbolRegistrationNumberAssignmentClass"]/@Value
//                 == Profile/Symbol Object's "name" attribute
//   3. attribute: GenericAttribute/@AttributeURI
//                 == DataProperty's Data[property="MetaData/rdl_uri"]
import {
    qsa, directChildrenByTag, parseSymbolCatalogue, flattenTree,
    buildConnectivityMap, buildHeatTraceSet, inferBoundsFromPrimitives,
} from "./dexpiParser.js";
// DEXPI 1.4 model (also used by rdlValidate.js): which plant attributes are
// gauge vs absolute pressures (valueType NullablePressureGauge/-Absolute).
import dexpiRdl from "./dexpi14Rdl.json";
// Core.xml unit symbols per PhysicalQuantities enumeration literal (same file
// as DEXPIViewer's), e.g. "PressureGaugeUnit.Bar" -> "barg".
import { UNIT_SYMBOLS } from "./unitSymbols.js";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function isProteusXml(xmlText) {
    if (!xmlText) return false;
    return xmlText.slice(0, 4000).includes("<PlantModel");
}

export function isProteusDoc(doc) {
    return !!doc?.documentElement && doc.documentElement.tagName === "PlantModel";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function directDataText(node, property) {
    const d = directChildrenByTag(node, "Data").find(x => x.getAttribute("property") === property);
    const first = d && d.children && d.children[0];
    return first ? (first.textContent || "").trim() : null;
}

function ownGenericAttributes(el) {
    return directChildrenByTag(el, "GenericAttributes").flatMap(g => directChildrenByTag(g, "GenericAttribute"));
}

// Reads a single GenericAttribute's Value from a specific GenericAttributes
// group, identified by its Set attribute.
function ownGenericAttributeValue(el, setName, attrName) {
    for (const group of directChildrenByTag(el, "GenericAttributes")) {
        if (group.getAttribute("Set") !== setName) continue;
        const ga = directChildrenByTag(group, "GenericAttribute").find(g => g.getAttribute("Name") === attrName);
        if (ga) return ga.getAttribute("Value");
    }
    return null;
}

// Dash pattern (SVG stroke-dasharray) for an InformationFlow CenterLine whose
// SignalConveyingFunctionTypeRepresentationAssignmentClass is the plain
// "SignalConveying" value.
const SIGNAL_CONVEYING_DASH_ARRAY = "3 2";

function coerceValue(raw, format) {
    if (raw === null || raw === undefined) return null;
    const f = (format || "").toLowerCase();
    if (/double|real|float|length|angle|mass|pressure|temperature|volume|area/.test(f)) {
        const n = parseFloat(raw);
        return Number.isNaN(n) ? raw : n;
    }
    if (/integer|^int$/.test(f)) {
        const n = parseInt(raw, 10);
        return Number.isNaN(n) ? raw : n;
    }
    if (/boolean/.test(f)) return raw === "true" || raw === "1";
    return raw;
}

function parseJustification(j) {
    if (!j) return { horizontal: "Center", vertical: "Center" };
    const horizontal = /Left/.test(j) ? "Left" : /Right/.test(j) ? "Right" : "Center";
    const vertical = /Top/.test(j) ? "Top" : /Bottom/.test(j) ? "Bottom" : "Center";
    return { horizontal, vertical };
}

// Reads a Proteus <Position> block (<Location>, <Axis>, <Reference>),
// returning a world position, rotation, and mirror flag in DEXPI's
// (SVG-compatible) Y-down convention.
//
// Proteus <Location> is Y-up; Y is negated here. <Axis Z="-1"/> marks a
// mirrored placement. Rotation is derived from <Reference> via atan2:
// atan2(-Reference.Y, Reference.X) when unmirrored, atan2(Reference.Y,
// Reference.X) when mirrored, normalized to [0,360).
function readPosition(el) {
    const posEl = directChildrenByTag(el, "Position")[0];
    if (!posEl) return null;
    const loc = directChildrenByTag(posEl, "Location")[0];
    const ref = directChildrenByTag(posEl, "Reference")[0];
    const axis = directChildrenByTag(posEl, "Axis")[0];
    const x = loc ? (parseFloat(loc.getAttribute("X")) || 0) : 0;
    const y = loc ? -(parseFloat(loc.getAttribute("Y")) || 0) : 0;
    const az = axis ? (parseFloat(axis.getAttribute("Z")) || 1) : 1;
    const isMirrored = az < 0;
    let rotation = 0;
    if (ref) {
        const rx = parseFloat(ref.getAttribute("X")) || 0;
        const ry = parseFloat(ref.getAttribute("Y")) || 0;
        const effRy = isMirrored ? ry : -ry;
        rotation = Math.atan2(effRy, rx) * 180 / Math.PI;
        if (rotation < 0) rotation += 360;
    }
    return { x, y, rotation, isMirrored };
}

// Reads a Proteus <Scale X Y Z/> element (sibling of <Position>), returning
// the X/Y scale factors for a placed symbol. Z is unused. Returns {x:1,y:1}
// when no <Scale> element is present, or 0 for an axis attribute that isn't
// a valid number.
function readScale(el) {
    const scaleEl = directChildrenByTag(el, "Scale")[0];
    if (!scaleEl) return { x: 1, y: 1 };
    const x = parseFloat(scaleEl.getAttribute("X"));
    const y = parseFloat(scaleEl.getAttribute("Y"));
    return { x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y };
}

// Reads the raw <Scale X Y Z/> element verbatim, with no fallback applied,
// for display in the Details panel. Returns null when no <Scale> element
// is present.
function readRawScale(el) {
    const scaleEl = directChildrenByTag(el, "Scale")[0];
    if (!scaleEl) return null;
    return {
        x: parseFloat(scaleEl.getAttribute("X")) || 0,
        y: parseFloat(scaleEl.getAttribute("Y")) || 0,
        z: parseFloat(scaleEl.getAttribute("Z")) || 0,
    };
}

// Reads the raw <Axis X Y Z/> and <Reference X Y Z/> vectors from an
// element's <Position> block, for display in the Details panel.
function readAxisReference(el) {
    const posEl = directChildrenByTag(el, "Position")[0];
    if (!posEl) return null;
    const readVec = v => v ? {
        x: parseFloat(v.getAttribute("X")) || 0,
        y: parseFloat(v.getAttribute("Y")) || 0,
        z: parseFloat(v.getAttribute("Z")) || 0,
    } : null;
    return {
        axis: readVec(directChildrenByTag(posEl, "Axis")[0]),
        reference: readVec(directChildrenByTag(posEl, "Reference")[0]),
    };
}

// ---------------------------------------------------------------------------
// Rule 1 — class index: rdl_uri -> DEXPI-2.0-style type string
// ---------------------------------------------------------------------------

export function buildClassRdlUriIndex(discDoc) {
    const map = new Map();
    if (!discDoc) return map;
    const modelName = discDoc.documentElement.getAttribute("name") || "DiscProfile";

    function walk(node, pkgPath) {
        Array.from(node.children || []).forEach(child => {
            const tag = child.tagName;
            if (tag === "Package") {
                const name = child.getAttribute("name") || "";
                walk(child, pkgPath ? `${pkgPath}.${name}` : name);
            } else if (tag === "ConcreteClass" || tag === "AbstractClass") {
                const name = child.getAttribute("name") || "";
                const uri = directDataText(child, "MetaData/rdl_uri");
                const typeStr = pkgPath ? `${modelName}/${pkgPath}.${name}` : `${modelName}/${name}`;
                if (uri) map.set(uri, typeStr);
                walk(child, pkgPath);
            } else {
                walk(child, pkgPath);
            }
        });
    }
    walk(discDoc.documentElement, "");
    return map;
}

// ---------------------------------------------------------------------------
// Custom-class index (used by rdlValidate.js): rdl_uri -> { name, superTypes, kind }.
//
// Proteus's DEXPI 1.4 model defines generic "Custom<X>" placeholder classes
// (CustomEquipment, CustomOperatedValve, CustomPipingComponent, ...) whose
// real semantic type is carried via a TypeURIAssignmentClass GenericAttribute
// resolving to a DiscProfile.xml class with a matching superTypes value.
// ---------------------------------------------------------------------------

// `kind` ("Concrete" | "Abstract") reflects the node's tag name
// (ConcreteClass vs AbstractClass).
export function buildProfileClassSuperTypeIndex(discDoc) {
    const map = new Map(); // rdl_uri -> { name, superTypes: string[], kind: "Concrete"|"Abstract" }
    if (!discDoc) return map;

    function walk(node) {
        Array.from(node.children || []).forEach(child => {
            const tag = child.tagName;
            if (tag === "ConcreteClass" || tag === "AbstractClass") {
                const name = child.getAttribute("name") || "";
                const uri = directDataText(child, "MetaData/rdl_uri");
                const superTypes = (child.getAttribute("superTypes") || "").split(/\s+/).filter(Boolean);
                const kind = tag === "AbstractClass" ? "Abstract" : "Concrete";
                if (uri) map.set(uri, { name, superTypes, kind });
            }
            walk(child);
        });
    }
    walk(discDoc.documentElement);
    return map;
}

// ---------------------------------------------------------------------------
// Symbol usage index: registered symbol number -> the DEXPI class the
// profile declares that symbol may depict, read from each Profile/Symbol
// Object's <Data property="MetaData/usage"> value (last "."-separated
// segment of the usage string).
// ---------------------------------------------------------------------------
export function buildSymbolUsageIndex(discDoc) {
    const map = new Map(); // symbol registration number -> expected class name
    if (!discDoc) return map;

    function walk(node) {
        Array.from(node.children || []).forEach(child => {
            if (child.tagName === "Object" && child.getAttribute("type") === "Profile/Symbol") {
                const symbolName = child.getAttribute("name") || "";
                const usage = directDataText(child, "MetaData/usage");
                if (symbolName && usage) {
                    const className = usage.split(".").pop();
                    if (className) map.set(symbolName, className);
                }
            }
            walk(child);
        });
    }
    walk(discDoc.documentElement);
    return map;
}

// ---------------------------------------------------------------------------
// Rule 3 — DataProperty index: rdl_uri -> "DiscProfile/<PropertyName>"
// ---------------------------------------------------------------------------

export function buildDataPropertyRdlUriIndex(discDoc) {
    const map = new Map();
    if (!discDoc) return map;

    function collectFrom(classEl) {
        directChildrenByTag(classEl, "DataProperty").forEach(dp => {
            const name = dp.getAttribute("name");
            const uri = directDataText(dp, "MetaData/rdl_uri");
            if (name && uri) map.set(uri, `DiscProfile/${name}`);
        });
    }
    function walk(node) {
        Array.from(node.children || []).forEach(child => {
            const tag = child.tagName;
            if (tag === "ConcreteClass" || tag === "AbstractClass" || tag === "ClassExtension") {
                collectFrom(child);
            }
            walk(child);
        });
    }
    walk(discDoc.documentElement);
    return map;
}

// ---------------------------------------------------------------------------
// Rule 2 — Proteus ShapeCatalogue: ComponentName -> SymbolRegistrationNumber,
// joined with parseSymbolCatalogue(discDoc) (keyed by
// "DiscProfile/<Symbol Object name>").
// ---------------------------------------------------------------------------

export function buildProteusShapeCatalogue(mainDoc) {
    const map = new Map();
    const catalogue = qsa(mainDoc, "ShapeCatalogue")[0];
    if (!catalogue) return map;
    qsa(catalogue, "[ComponentName]").forEach(el => {
        const componentName = el.getAttribute("ComponentName");
        const regGa = ownGenericAttributes(el).find(g => g.getAttribute("Name") === "SymbolRegistrationNumberAssignmentClass");
        const regNum = regGa ? regGa.getAttribute("Value") : null;
        if (componentName && regNum) map.set(componentName, regNum);
    });
    return map;
}

// ---------------------------------------------------------------------------
// Embedded ShapeCatalogue fallback: symbol geometry drawn directly from the
// Proteus file's own <ShapeCatalogue> entries (Circle/PolyLine/TrimmedCurve/
// Ellipse/Shape primitives), keyed by ComponentName, with no DiscProfile.xml
// involved.
//
// Coordinate convention: all numeric positions in a Proteus file (a
// placement's <Position>, a CenterLine's <Coordinate>, a ShapeCatalogue
// entry's own local geometry) use the same Y-up convention, negated here to
// match readPosition()'s Y-down output.
// ---------------------------------------------------------------------------

// Converts Proteus <Presentation R G B/> 0-1 float channels to a "#rrggbb"
// hex string.
function proteusPresentationColor(el) {
    const pres = directChildrenByTag(el, "Presentation")[0];
    const toHex = raw => {
        const n = Math.round((parseFloat(raw) || 0) * 255);
        return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
    };
    if (!pres) return "#000000";
    return `#${toHex(pres.getAttribute("R"))}${toHex(pres.getAttribute("G"))}${toHex(pres.getAttribute("B"))}`;
}

function proteusPresentationStroke(el) {
    const pres = directChildrenByTag(el, "Presentation")[0];
    const width = pres ? (parseFloat(pres.getAttribute("LineWeight")) || 0.25) : 0.25;
    return { color: proteusPresentationColor(el), width, dashArray: "", dashOffset: 0 };
}

// Filled="Solid"/"Hatch" -> filled with the Presentation color; absent ->
// transparent.
function proteusPresentationFill(el) {
    const filled = el.getAttribute("Filled");
    return { style: filled ? "Solid" : "Transparent", color: proteusPresentationColor(el) };
}

// Converts one ShapeCatalogue entry's graphical primitive element into the
// same primitive object shape parsePrimitive() (dexpiParser.js) produces.
function parseProteusShapePrimitive(el, idx) {
    const tag = el.tagName;
    const key = `${tag}_${idx}`;
    if (tag === "PolyLine") {
        const points = directChildrenByTag(el, "Coordinate").map(c => ({
            x: parseFloat(c.getAttribute("X")) || 0,
            y: -(parseFloat(c.getAttribute("Y")) || 0),
        }));
        return { kind: "polyline", key, points, stroke: proteusPresentationStroke(el) };
    }
    if (tag === "Shape") {
        // A closed, optionally-filled outline.
        const points = directChildrenByTag(el, "Coordinate").map(c => ({
            x: parseFloat(c.getAttribute("X")) || 0,
            y: -(parseFloat(c.getAttribute("Y")) || 0),
        }));
        return { kind: "polygon", key, points, stroke: proteusPresentationStroke(el), fill: proteusPresentationFill(el) };
    }
    if (tag === "Circle") {
        const pos = readPosition(el) || { x: 0, y: 0 };
        const radius = parseFloat(el.getAttribute("Radius")) || 0;
        return { kind: "circle", key, center: { x: pos.x, y: pos.y }, radius, stroke: proteusPresentationStroke(el), fill: proteusPresentationFill(el) };
    }
    if (tag === "Ellipse") {
        const pos = readPosition(el) || { x: 0, y: 0, rotation: 0 };
        const rx = parseFloat(el.getAttribute("PrimaryAxis")) || 0;
        const ry = parseFloat(el.getAttribute("SecondaryAxis")) || 0;
        return { kind: "ellipse", key, center: { x: pos.x, y: pos.y }, rx, ry, rotation: pos.rotation || 0, stroke: proteusPresentationStroke(el), fill: proteusPresentationFill(el) };
    }
    if (tag === "TrimmedCurve") {
        const curveEl = directChildrenByTag(el, "Circle")[0] || directChildrenByTag(el, "Ellipse")[0];
        if (!curveEl) return null;
        const pos = readPosition(curveEl) || { x: 0, y: 0, rotation: 0 };
        const isEllipse = curveEl.tagName === "Ellipse";
        const rx = isEllipse ? (parseFloat(curveEl.getAttribute("PrimaryAxis")) || 0) : (parseFloat(curveEl.getAttribute("Radius")) || 0);
        const ry = isEllipse ? (parseFloat(curveEl.getAttribute("SecondaryAxis")) || 0) : (parseFloat(curveEl.getAttribute("Radius")) || 0);
        const startAttr = parseFloat(el.getAttribute("StartAngle")) || 0;
        const endAttr = parseFloat(el.getAttribute("EndAngle")) || 0;
        return {
            kind: "ellipseArc", key,
            center: { x: pos.x, y: pos.y }, rx, ry,
            // Swaps and negates start/end angle to keep sweep direction correct
            // after the Y negation above.
            startAngle: -endAttr, endAngle: -startAttr,
            rotation: pos.rotation || 0,
            stroke: proteusPresentationStroke(curveEl),
        };
    }
    return null; // GenericAttributes and anything else isn't drawable geometry
}

// Builds a ComponentName -> symbol map (same { key, name, variants: [...] }
// shape as parseSymbolCatalogue(), with one unconditional variant per entry)
// from the main document's own <ShapeCatalogue> element.
export function buildProteusEmbeddedShapeCatalogue(mainDoc) {
    const map = new Map();
    const catalogue = qsa(mainDoc, "ShapeCatalogue")[0];
    if (!catalogue) return map;
    Array.from(catalogue.children).forEach(entryEl => {
        const componentName = entryEl.getAttribute("ComponentName");
        if (!componentName || map.has(componentName)) return;
        const primitives = Array.from(entryEl.children)
            .map((child, i) => parseProteusShapePrimitive(child, i))
            .filter(Boolean);
        if (primitives.length === 0) return;
        const bounds = inferBoundsFromPrimitives(primitives);
        const variant = {
            key: `${componentName}_v0`, name: componentName, ...bounds,
            primitives, variantNumber: 0, condition: null, labelTemplates: [],
        };
        map.set(componentName, { key: componentName, name: componentName, variants: [variant] });
    });
    return map;
}

// ---------------------------------------------------------------------------
// Object class / data resolution (rules 1 & 3)
// ---------------------------------------------------------------------------

function resolveObjectClass(el, classIndex) {
    const gas = ownGenericAttributes(el);
    const typeUriGa = gas.find(g => g.getAttribute("Name") === "TypeURIAssignmentClass");
    if (typeUriGa) {
        const uri = typeUriGa.getAttribute("Value");
        const mapped = classIndex.get(uri);
        if (mapped) return { type: mapped, matchedRule1: true };
    }
    const ccUri = el.getAttribute("ComponentClassURI");
    if (ccUri && classIndex.has(ccUri)) return { type: classIndex.get(ccUri), matchedRule1: true };
    const cc = el.getAttribute("ComponentClass") || el.tagName;
    return { type: `Plant/Unmapped.${cc}`, matchedRule1: false };
}

// Walks GenericAttributes group-by-group (rather than flattening) so each
// attribute can be tagged with its enclosing group's Set value.
function resolveObjectData(el, dataPropIndex) {
    const out = [];
    directChildrenByTag(el, "GenericAttributes").forEach(group => {
        const set = group.getAttribute("Set"); // null if the group has no Set attribute
        directChildrenByTag(group, "GenericAttribute").forEach(ga => {
            const name = ga.getAttribute("Name");
            const attrUri = ga.getAttribute("AttributeURI");
            const rawValue = ga.getAttribute("Value");
            const format = ga.getAttribute("Format") || "";
            const value = coerceValue(rawValue, format);
            const mappedProp = attrUri ? dataPropIndex.get(attrUri) : null;
            const units = ga.getAttribute("Units") || null;
            const unitType = gaUnitType(ga);
            // A number with a unit of measure is carried as a PhysicalQuantity
            // (as in DEXPIViewer), so the Details panel shows its unit and
            // labels can append it.
            const shown = (typeof value === "number" && units)
                ? { kind: "PhysicalQuantity", value, unit: unitSymbolFor(units, unitType), unitRef: unitType ? `${unitType}.${units}` : (ga.getAttribute("UnitsURI") || units) }
                : value;
            out.push({ property: mappedProp || `Proteus/${name}`, value: shown, set, units, unitsUri: ga.getAttribute("UnitsURI") || null, unitType });
        });
    });
    return out;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

// ComponentClass values valid for an InformationFlow element:
// SignalConveyingFunction and its two subtypes.
export const SIGNAL_FLOW_COMPONENT_CLASSES = new Set(["SignalConveyingFunction", "MeasuringLineFunction", "SignalLineFunction"]);

// Segment/System containment ref property names (structural membership,
// not a physical connection). Exported so App.jsx can exclude these from
// its sub-component highlight computation.
export const SEGMENT_SYSTEM_MEMBERSHIP_REF_PROPERTIES = new Set([
    "direct item of Segment", "segment item (direct)",
    "indirect item of System", "system item (indirect)",
]);

// "is a part of" / "is a collection including" Association refs: tree-
// containment bookkeeping, excluded from App.jsx's sub-component highlight
// propagation.
export const TREE_CONTAINMENT_REF_PROPERTIES = new Set(["is a part of", "is a collection including"]);

// Coordinate-matching tolerance (drawing units) used by rule 4 below.
const CENTERLINE_MATCH_TOLERANCE = 0.001;

// ---------------------------------------------------------------------------
// Proteus-specific connectivity derivation.
//
// Rule 4 - CenterLine (position-based): for each PipingNetworkSegment
// CenterLine, resolves which component owns the connection-point Node
// matching its first Coordinate (upstream) and its last Coordinate
// (downstream), and links those two components directly.
//
// Rule 5 - Coincident connection points (position-based): two components'
// ConnectionPoints/Node entries at the same position with no CenterLine
// between them are recorded as a non-directional "group" link.
//
// Segment/System containment (structural): each direct item of a
// PipingNetworkSegment gets a "direct item of Segment" ref (and the segment
// a reciprocal "segment item (direct)" ref); if the segment sits inside a
// PipingNetworkSystem, its items also get "indirect item of System"
// (reciprocal: "system item (indirect)").
//
// Signal association (structural): "has logical start"/"has logical end"
// Associations on an InformationFlow element get a reverse ref ("is logical
// start of"/"is logical end of") added onto the referenced component.
// ---------------------------------------------------------------------------

function segmentItemElements(segEl) {
    return Array.from(segEl.children).filter(c => c.getAttribute && c.getAttribute("ID"));
}

// Fallback synthetic objectId for a PipingNetworkSegment's Nth CenterLine
// child, used when the CenterLine element has no ID attribute.
function centerlineObjectId(segId, idx) {
    return `${segId}::CL${idx + 1}`;
}

// Resolves the id to use for one CenterLine child: its own ID attribute, or
// the synthetic fallback above.
function resolveCenterLineId(clEl, segId, idx) {
    return clEl.getAttribute("ID") || centerlineObjectId(segId, idx);
}

// Builds the synthetic tree node for one CenterLine, with its own
// upstream/downstream refs.
//
// docOrder records this CenterLine's index among its owning segment's
// direct XML children, used by buildTree()'s sort pass to interleave
// CenterLines with the segment's other children in file order.
function makeCenterLineNode(objectId, pointCount, upstreamId, downstreamId, docOrder) {
    const refs = [];
    if (upstreamId) refs.push({ property: "upstream (CenterLine)", objects: [upstreamId] });
    if (downstreamId) refs.push({ property: "downstream (CenterLine)", objects: [downstreamId] });
    return {
        // label is the objectId itself, shown by the tree view.
        id: objectId, objectId, type: "Plant/Segment.CenterLine", label: objectId,
        tagName: "", subTagName: "", loopNum: "", componentClass: null,
        data: [{ property: "Proteus/PointCount", value: pointCount, set: undefined }],
        persistentIdentifiers: [], refs, children: [], _docOrder: docOrder,
    };
}

// Indexes every component's <ConnectionPoints><Node><Position><Location X Y/>
// by coordinate, using a spatial hash grid bucketed at the tolerance size.
function buildConnectionPointIndex(mainDoc) {
    const bucketOf = v => Math.round(v / CENTERLINE_MATCH_TOLERANCE);
    const bucketKey = (bx, by) => `${bx},${by}`;
    const grid = new Map();

    qsa(mainDoc, "ConnectionPoints").forEach(cp => {
        const owner = cp.parentElement;
        const ownerId = owner && owner.getAttribute ? owner.getAttribute("ID") : null;
        if (!ownerId) return;
        directChildrenByTag(cp, "Node").forEach(node => {
            const posEl = directChildrenByTag(node, "Position")[0];
            const loc = posEl ? directChildrenByTag(posEl, "Location")[0] : null;
            if (!loc) return;
            const x = parseFloat(loc.getAttribute("X"));
            const y = parseFloat(loc.getAttribute("Y"));
            if (Number.isNaN(x) || Number.isNaN(y)) return;
            const key = bucketKey(bucketOf(x), bucketOf(y));
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push({ x, y, ownerId });
        });
    });

    return {
        findOwner(x, y) {
            const bx = bucketOf(x), by = bucketOf(y);
            let best = null, bestDist = Infinity;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const bucket = grid.get(bucketKey(bx + dx, by + dy));
                    if (!bucket) continue;
                    for (const p of bucket) {
                        const dist = Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
                        if (dist <= CENTERLINE_MATCH_TOLERANCE && dist < bestDist) { best = p; bestDist = dist; }
                    }
                }
            }
            return best ? best.ownerId : null;
        },
    };
}

// Max distinct component IDs allowed to share one coincident position
// bucket before it is treated as a placeholder coordinate rather than a
// real junction.
const COINCIDENT_NODE_MAX_OWNERS = 4;

// Groups every component's <ConnectionPoints><Node> by coordinate (same
// spatial-hash approach as buildConnectionPointIndex(), keeping every
// distinct owner) and returns groups of 2 to COINCIDENT_NODE_MAX_OWNERS
// distinct component IDs sharing that position.
function buildCoincidentNodeGroups(mainDoc) {
    const bucketOf = v => Math.round(v / CENTERLINE_MATCH_TOLERANCE);
    const grid = new Map(); // bucketKey -> Set(ownerId)

    qsa(mainDoc, "ConnectionPoints").forEach(cp => {
        const owner = cp.parentElement;
        const ownerId = owner && owner.getAttribute ? owner.getAttribute("ID") : null;
        if (!ownerId) return;
        directChildrenByTag(cp, "Node").forEach(node => {
            const posEl = directChildrenByTag(node, "Position")[0];
            const loc = posEl ? directChildrenByTag(posEl, "Location")[0] : null;
            if (!loc) return;
            const x = parseFloat(loc.getAttribute("X"));
            const y = parseFloat(loc.getAttribute("Y"));
            if (Number.isNaN(x) || Number.isNaN(y)) return;
            const key = `${bucketOf(x)},${bucketOf(y)}`;
            if (!grid.has(key)) grid.set(key, new Set());
            grid.get(key).add(ownerId);
        });
    });

    return [...grid.values()].filter(owners => owners.size >= 2 && owners.size <= COINCIDENT_NODE_MAX_OWNERS);
}

// Fallback max distance (drawing units) for matching a CenterLine endpoint
// to a same-segment PipeOffPageConnector.
const OFFPAGE_CONNECTOR_MATCH_MAX_DISTANCE = 50;

// Reads a segment's own direct-child PipeOffPageConnector elements (id +
// Position), used as a fallback match for a CenterLine endpoint that
// buildConnectionPointIndex() can't resolve, scoped to this one segment.
function readSegmentOffPageConnectors(segEl) {
    return directChildrenByTag(segEl, "PipeOffPageConnector").map(opcEl => {
        const posEl = directChildrenByTag(opcEl, "Position")[0];
        const loc = posEl ? directChildrenByTag(posEl, "Location")[0] : null;
        const x = loc ? parseFloat(loc.getAttribute("X")) : NaN;
        const y = loc ? parseFloat(loc.getAttribute("Y")) : NaN;
        return { id: opcEl.getAttribute("ID"), x, y };
    }).filter(o => o.id && !Number.isNaN(o.x) && !Number.isNaN(o.y));
}

// Nearest-by-distance match within a same-segment candidate list, capped at
// OFFPAGE_CONNECTOR_MATCH_MAX_DISTANCE.
function nearestOffPageConnectorId(candidates, x, y) {
    let best = null, bestDist = Infinity;
    candidates.forEach(c => {
        const dist = Math.max(Math.abs(c.x - x), Math.abs(c.y - y));
        if (dist <= OFFPAGE_CONNECTOR_MATCH_MAX_DISTANCE && dist < bestDist) { best = c.id; bestDist = dist; }
    });
    return best;
}

function deriveProteusFlowConnectivity(mainDoc, nodesById) {
    const { findOwner } = buildConnectionPointIndex(mainDoc);

    qsa(mainDoc, "PipingNetworkSegment").forEach(segEl => {
        const segId = segEl.getAttribute("ID");
        const segNode = segId ? nodesById.get(segId) : null;
        const items = segmentItemElements(segEl);

        // Segment/System containment: every direct item of this segment, plus
        // (if the segment sits inside a PipingNetworkSystem) each item's indirect
        // membership in that system.
        const parentEl = segEl.parentNode;
        const sysId = parentEl && parentEl.tagName === "PipingNetworkSystem" ? parentEl.getAttribute("ID") : null;
        const sysNode = sysId ? nodesById.get(sysId) : null;
        if (segNode) {
            items.forEach(itemEl => {
                const itemId = itemEl.getAttribute("ID");
                const itemNode = itemId ? nodesById.get(itemId) : null;
                if (!itemNode) return;
                itemNode.refs.push({ property: "direct item of Segment", objects: [segId] });
                segNode.refs.push({ property: "segment item (direct)", objects: [itemId] });
                if (sysNode) {
                    itemNode.refs.push({ property: "indirect item of System", objects: [sysId] });
                    sysNode.refs.push({ property: "system item (indirect)", objects: [itemId] });
                }
            });
        }

        // Rule 4: each direct CenterLine child links two real components and
        // becomes its own selectable sub-component of the segment.
        const segChildren = Array.from(segEl.children);
        const segOffPageConnectors = readSegmentOffPageConnectors(segEl);
        directChildrenByTag(segEl, "CenterLine").forEach((clEl, clIdx) => {
            const clId = resolveCenterLineId(clEl, segId, clIdx);
            const coords = directChildrenByTag(clEl, "Coordinate");
            let upstreamId = null, downstreamId = null;
            if (coords.length >= 2) {
                const first = coords[0], last = coords[coords.length - 1];
                const fx = parseFloat(first.getAttribute("X")), fy = parseFloat(first.getAttribute("Y"));
                const lx = parseFloat(last.getAttribute("X")), ly = parseFloat(last.getAttribute("Y"));
                if (![fx, fy, lx, ly].some(Number.isNaN)) {
                    let foundUp = findOwner(fx, fy);
                    let foundDown = findOwner(lx, ly);
                    // See readSegmentOffPageConnectors()'s doc comment.
                    if (!foundUp && segOffPageConnectors.length) foundUp = nearestOffPageConnectorId(segOffPageConnectors, fx, fy);
                    if (!foundDown && segOffPageConnectors.length) foundDown = nearestOffPageConnectorId(segOffPageConnectors, lx, ly);
                    if (foundUp && foundDown && foundUp !== foundDown) {
                        upstreamId = foundUp;
                        downstreamId = foundDown;
                        const upNode = nodesById.get(upstreamId);
                        const downNode = nodesById.get(downstreamId);
                        if (upNode) upNode.refs.push({ property: "downstream (CenterLine)", objects: [downstreamId] });
                        if (downNode) downNode.refs.push({ property: "upstream (CenterLine)", objects: [upstreamId] });
                    }
                }
            }
            if (segNode) {
                segNode.children.push(makeCenterLineNode(clId, coords.length, upstreamId, downstreamId, segChildren.indexOf(clEl)));
            }
        });
    });

    // Rule 5: direct coincident connection points (no CenterLine involved).
    // Property name contains "piping" so buildConnectivityMap()'s classifier
    // buckets it into the non-directional "group" set.
    buildCoincidentNodeGroups(mainDoc).forEach(owners => {
        const ids = [...owners];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = nodesById.get(ids[i]);
                const b = nodesById.get(ids[j]);
                if (a) a.refs.push({ property: "adjacent (Piping)", objects: [ids[j]] });
                if (b) b.refs.push({ property: "adjacent (Piping)", objects: [ids[i]] });
            }
        }
    });

    // Signal association, reverse direction: adds "is logical start of"/"is
    // logical end of" onto the Source/Target component the association
    // points at.
    const REVERSE_SIGNAL_LABEL = { "has logical start": "is logical start of", "has logical end": "is logical end of" };
    qsa(mainDoc, "InformationFlow[ID]").forEach(ifEl => {
        const ifId = ifEl.getAttribute("ID");
        directChildrenByTag(ifEl, "Association").forEach(a => {
            const reverseLabel = REVERSE_SIGNAL_LABEL[a.getAttribute("Type") || ""];
            if (!reverseLabel) return;
            const targetId = a.getAttribute("ItemID");
            const targetNode = targetId ? nodesById.get(targetId) : null;
            if (targetNode) targetNode.refs.push({ property: reverseLabel, objects: [ifId] });
        });
    });
}

function buildTree(mainDoc, classIndex, dataPropIndex) {
    // InformationFlow[ID] is included even without a ComponentClass; elements
    // missing ComponentClass resolve to a "Plant/Unmapped.<tagName>" type via
    // resolveObjectClass() below.
    //
    // <Label> elements are kept in allEls/elementById whether nested inside
    // the object they decorate or standing alone as an independent PlantModel
    // item, so each reaches buildProteusGraphics() as its own element (its own
    // ComponentName/symbol, leader-line PolyLine, and/or Text).
    const allEls = qsa(mainDoc, "[ID][ComponentClass], InformationFlow[ID]").filter(el => {
        if (el.tagName === "MetaData") return false;
        if (el.closest && el.closest("ShapeCatalogue")) return false;
        return true;
    });

    const nodesById = new Map();
    const elementById = new Map();
    let matchedRule1Count = 0;

    allEls.forEach(el => {
        const id = el.getAttribute("ID");
        elementById.set(id, el);
        const { type, matchedRule1 } = resolveObjectClass(el, classIndex);
        if (matchedRule1) matchedRule1Count++;
        // Raw ComponentClass attribute as written in the source XML, distinct
        // from `type` above (the resolved DEXPI type string). Kept alongside
        // `type` so the Details pane can show both.
        const componentClass = el.getAttribute("ComponentClass") || null;
        const data = resolveObjectData(el, dataPropIndex);
        const tagName = (data.find(d => d.property === "DiscProfile/ItemTag") || {}).value || "";
        const displayName = (data.find(d => d.property === "DiscProfile/ObjectDisplayName") || {}).value || "";
        const persistentIdentifiers = directChildrenByTag(el, "PersistentID").map(p => ({
            context: p.getAttribute("Context") || "", value: p.getAttribute("Identifier") || "",
        }));
        // Association Type strings are kept as-is (e.g. "has logical
        // start"/"has logical end" for signal wires, "is a part of"/"is a
        // collection including" for containment); one "is a part of" ref may
        // also be consumed below to resolve this node's tree parent.
        const refs = directChildrenByTag(el, "Association")
            .map(a => ({ property: a.getAttribute("Type") || "", objects: [a.getAttribute("ItemID")].filter(Boolean) }));
        const label = displayName || tagName || el.getAttribute("ComponentName") || id || type.split(".").pop();
        nodesById.set(id, {
            id, objectId: id, type, label, tagName, subTagName: "", loopNum: "",
            componentClass, data, persistentIdentifiers, refs, children: [],
        });
    });

    // Connection-based connectivity refs (piping / signal segment connections)
    qsa(mainDoc, "Connection").forEach(conn => {
        const fromId = conn.getAttribute("FromID");
        const toId = conn.getAttribute("ToID");
        if (fromId && toId && nodesById.has(fromId) && nodesById.has(toId)) {
            nodesById.get(fromId).refs.push({ property: "downstream (Connection)", objects: [toId] });
            nodesById.get(toId).refs.push({ property: "upstream (Connection)", objects: [fromId] });
        }
    });

    // Segment/System containment and CenterLine-derived connectivity.
    deriveProteusFlowConnectivity(mainDoc, nodesById);

    // Parent resolution: (1) XML nesting, (2) "is a part of", (3) "is a collection including"
    const childToParent = new Map();
    allEls.forEach(el => {
        const id = el.getAttribute("ID");
        let p = el.parentNode;
        while (p && p.nodeType === 1) {
            const pid = p.getAttribute && p.getAttribute("ID");
            if (pid && nodesById.has(pid)) { childToParent.set(id, pid); break; }
            p = p.parentNode;
        }
    });
    allEls.forEach(el => {
        const id = el.getAttribute("ID");
        if (childToParent.has(id)) return;
        const assoc = directChildrenByTag(el, "Association").find(a => a.getAttribute("Type") === "is a part of");
        const target = assoc?.getAttribute("ItemID");
        if (target && nodesById.has(target)) childToParent.set(id, target);
    });
    allEls.forEach(el => {
        const id = el.getAttribute("ID");
        directChildrenByTag(el, "Association")
            .filter(a => a.getAttribute("Type") === "is a collection including")
            .forEach(a => {
                const childId = a.getAttribute("ItemID");
                if (childId && nodesById.has(childId) && !childToParent.has(childId)) childToParent.set(childId, id);
            });
    });

    const roots = [];
    nodesById.forEach((node, id) => {
        const parentId = childToParent.get(id);
        if (parentId && parentId !== id && nodesById.has(parentId)) {
            nodesById.get(parentId).children.push(node);
        } else {
            roots.push(node);
        }
    });

    // Re-sorts each segment/system's children into file order, interleaving
    // synthetic CenterLine nodes (attached earlier) with the real item
    // children.
    nodesById.forEach((node, id) => {
        const ownerEl = elementById.get(id);
        if (!ownerEl || (ownerEl.tagName !== "PipingNetworkSegment" && ownerEl.tagName !== "PipingNetworkSystem")) return;
        if (node.children.length < 2) return;
        const ownerChildren = Array.from(ownerEl.children);
        const orderOf = child => {
            if (typeof child._docOrder === "number") return child._docOrder;
            const childEl = elementById.get(child.objectId);
            const idx = childEl ? ownerChildren.indexOf(childEl) : -1;
            return idx === -1 ? Infinity : idx;
        };
        node.children.sort((a, b) => orderOf(a) - orderOf(b));
    });

    let treeRoot;
    if (roots.length === 1) {
        treeRoot = roots[0];
    } else {
        treeRoot = {
            id: "proteus-root", objectId: null, type: "Plant/PlantModel", label: "Plant Model",
            tagName: "", subTagName: "", loopNum: "", componentClass: null, data: [], persistentIdentifiers: [], refs: [],
            children: roots,
        };
    }

    return { tree: treeRoot, elementById, diagnostics: { totalObjects: allEls.length, classMatchedViaRule1: matchedRule1Count, rootObjectId: treeRoot.objectId } };
}

// ---------------------------------------------------------------------------
// Graphics construction: symbol placement, labels, pipe/instrument centerlines
// ---------------------------------------------------------------------------

// Selects a symbol's SymbolVariant: the base (VariantNumber 0) variant
// unless another variant's PropertyValueCondition matches a GenericAttribute
// value on the object.
// Normalizes a rotation angle (SVG-style, clockwise-positive degrees) to
// (-90, 90], flipping by 180 for angles outside that range, so a
// Profile-derived label is never drawn upside-down.
function readableLabelRotation(deg) {
    return (((deg % 360) + 360 + 90) % 180) - 90;
}

// readableLabelRotation() only folds the angle; a 180-degree fold also
// requires swapping Left<->Right and Top<->Bottom alignment to keep the
// label on the same side of its anchor.
//
// The flip applies when the angle (normalized to [0,360)) falls in
// [90,270).
function readableLabelOrientation(deg, horizontal, vertical) {
    const wrapped = ((deg % 360) + 360) % 360;
    const flip = wrapped >= 90 && wrapped < 270;
    return {
        rotation: readableLabelRotation(deg),
        horizontal: flip ? (horizontal === "Left" ? "Right" : horizontal === "Right" ? "Left" : horizontal) : horizontal,
        vertical: flip ? (vertical === "Top" ? "Bottom" : vertical === "Bottom" ? "Top" : vertical) : vertical,
    };
}

// LabelTemplate tokens listed here are drawn as one character per line
// (vertical stack) instead of a single string. Matched against the
// template's raw, unresolved text. The template's own Rotation is not
// applied for these; each line follows the symbol's own placement rotation.
const CHARACTER_STACKED_LABEL_TEMPLATE_TEXTS = new Set(["<NonSasFunction>"]);

// Where a profile LabelTemplate is drawn on a placed symbol - DISC DEXPI rule
// 'B' (requirements document ANNEX B: Profile Label Text under Rotation and
// Mirroring), for EVERY symbol. The template defines the label for the symbol
// at rotation 0, not mirrored, and the text is always kept readable (left to
// right at 0/180, bottom to top at 90/270):
//   * the template's y offset (above / below) follows the symbol's full
//     rotation - a label above the symbol at 0 is below its origin at 180;
//   * the template's x offset (left / right) follows the readable text
//     direction: mirrored with the symbol, and flipped whenever the text had
//     to be turned over to stay readable - a label left of the symbol at 0 is
//     still left of it at 180 and below it at 90;
//   * Left/Right and Top/Bottom are chosen so the text grows away from the
//     symbol, as the template intends: Left/Right swap for a mirrored symbol,
//     Top/Bottom swap when the text is turned over.
// pos: readPosition() of the placement (y down, rotation clockwise degrees),
// scale: readScale(). Returns the world anchor point, the readable text
// rotation and the alignment to draw the text with.
function profileLabelPlacement(lt, pos, scale, stacked = false) {
    const deg = Math.PI / 180;
    const R = pos.rotation || 0;
    const turnedOver = Math.abs(((((readableLabelRotation(R) - R) % 360) + 360) % 360) - 180) < 0.01;
    const rx = turnedOver ? -1 : 1;
    const mirror = pos.isMirrored ? -1 : 1;
    const sx = Math.sign((scale.x || 1) * mirror) || 1;
    const sy = Math.sign(scale.y || 1) || 1;
    const rot = (x, y, a) => [x * Math.cos(a * deg) - y * Math.sin(a * deg), x * Math.sin(a * deg) + y * Math.cos(a * deg)];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
    const [wx, wy] = rot(lt.position.x * scale.x * mirror * rx, lt.position.y * scale.y, R);
    // character-stacked templates skip their own Rotation
    const t = stacked ? 0 : (lt.rotation || 0);
    const rotation = readableLabelRotation(R + t);
    const D = rot(1, 0, rotation), Dn = rot(0, 1, rotation);   // text reading / text down directions
    const L = ([x, y]) => rot(x * sx * rx, y * sy, R);        // template frame -> world
    const ex = L(rot(1, 0, t)), ey = L(rot(0, 1, t));
    let horizontal = lt.alignment.horizontal, vertical = lt.alignment.vertical;
    if ((horizontal === "Left" || horizontal === "Right") && dot(ex, D) < 0) horizontal = horizontal === "Left" ? "Right" : "Left";
    if ((vertical === "Top" || vertical === "Bottom") && dot(ey, Dn) < 0) vertical = vertical === "Top" ? "Bottom" : "Top";
    return { x: pos.x + wx, y: pos.y + wy, rotation, horizontal, vertical };
}

function isCharacterStackedLabelTemplate(lt) {
    return CHARACTER_STACKED_LABEL_TEMPLATE_TEXTS.has((lt.text || "").trim());
}

// Resolves which object a standalone <Label> element is annotating: an
// explicit "is about"/"is associated with"/"refers to" Association target,
// else the Label's own XML parent (if tracked), else the Label itself.
function resolveLabelOwnerId(el, id, elementById) {
    if (el.tagName !== "Label") return id;
    const aboutAssoc = directChildrenByTag(el, "Association")
        .find(a => ["is about", "is associated with", "refers to"].includes(a.getAttribute("Type") || ""));
    const aboutId = aboutAssoc?.getAttribute("ItemID");
    if (aboutId && elementById.has(aboutId)) return aboutId;
    const parentId = el.parentNode?.getAttribute?.("ID");
    if (parentId && elementById.has(parentId)) return parentId;
    return id;
}

function pickVariant(symbol, dataArr) {
    if (!symbol?.variants?.length) return null;
    if (symbol.variants.length === 1) return symbol.variants[0];
    const props = new Map((dataArr || []).map(d => [d.property, d.value]));
    for (const variant of symbol.variants) {
        if (!variant.condition) continue;
        const { attributeName, value: expected } = variant.condition;
        const raw = props.get(`DiscProfile/${attributeName}`) ?? props.get(attributeName) ?? props.get(`Proteus/${attributeName}`) ?? null;
        if (raw === null || raw === undefined) continue;
        if (String(raw) === expected) return variant;
    }
    return symbol.variants.find(v => v.variantNumber === 0)
        ?? symbol.variants.find(v => !v.condition)
        ?? symbol.variants[0];
}

// Matches "<AttributeName>" or "RelatedClass:<AttributeName>" placeholder
// tokens inside a Profile/LabelTemplate's Text value.
const LABEL_TEMPLATE_TOKEN_RE = /(?:([A-Za-z]\w*):)?<([^<>]+)>/g;

// Looks up one attribute's display value from a resolved data array,
// matching "DiscProfile/<name>" first, then "Proteus/<name>", then
// "Proteus/<name>AssignmentClass". Reduces PhysicalQuantity/DataReference/
// scalar value shapes to a plain display string.
// decimals (optional): numeric values (numbers and PhysicalQuantity values)
// are shown with exactly this many decimals - the equipment box value
// columns (ND0300B..ND0310B) use 1, e.g. 130 -> "130.0". Text values such as
// a material code ("1.4306") are never rounded.
function formatLabelNumber(v, decimals) {
    if (decimals === null || decimals === undefined || typeof v !== "number" || !Number.isFinite(v)) return String(v);
    // round half away from zero on the decimal value (56.55 -> 56.6), not on
    // its binary approximation as toFixed() alone does (-> 56.5)
    const r = Math.sign(v) * Number(Math.round(Number(Math.abs(v) + "e" + decimals)) + "e-" + decimals);
    return r.toFixed(decimals);
}

// Full vacuum: a pressure label shows the literal "FV" (the P&ID / data
// sheet convention) instead of the number - a gauge pressure of -1 atm
// (-1.01325 barg, also accepting the usual rounded -1.0 / -1.013 barg, i.e.
// within 1.5%) or an absolute pressure of 0. Proteus carries the unit as
// free text (Units="Bar" - the DEXPI PressureGaugeUnit literal -, "barg",
// "kPa", "psig", "bara", ...) and/or a UnitsURI, so the unit is matched by
// name; only attributes whose name contains "Pressure" are considered.
const FULL_VACUUM_GAUGE = [
    { re: /^(bar|barg|bar\s*\(?g\)?|bargauge)$/i, uri: "RDS1314539", fv: -1.01325 },
    { re: /^(mbar|mbarg|millibar)$/i, uri: "RDS11617875", fv: -1013.25 },
    { re: /^(kpa|kpag|kilopascal)$/i, uri: "RDS1330559", fv: -101.325 },
    { re: /^(mpa|mpag|megapascal)$/i, uri: "RDS1332404", fv: -0.101325 },
    { re: /^(pa|pag|pascal)$/i, uri: "RDS1338749", fv: -101325 },
    { re: /^(psi|psig|lbf\/in²|poundforceperinchsquared)$/i, uri: "RDS1341809", fv: -14.6959 },
];
// Pressure unit type of a GenericAttribute: its own Type / TypeURI (the AKSO
// convention, e.g. Type="PressureGaugeUnit" TypeURI=".../RDS7345161"), else
// the attribute's definition - the loaded DiscProfile.xml DataProperty's
// Core/PhysicalQuantities.Pressure*Unit type (by AttributeURI or name), then
// the DEXPI plant model (dexpi14Rdl.json). null when none says (e.g. the
// profile's SetPoint is a plain PhysicalQuantity).
const PRESSURE_GAUGE_TYPE_URIS = new Set(["http://data.posccaesar.org/rdl/RDS7345161"]);
const PLANT_PRESSURE_UNIT_TYPES = (() => {
    const byName = new Map();
    for (const [key, prop] of Object.entries(dexpiRdl?.properties || {})) {
        const t = prop?.valueType === "NullablePressureGauge" ? "PressureGaugeUnit"
            : prop?.valueType === "NullablePressureAbsolute" ? "PressureAbsoluteUnit" : null;
        if (!t) continue;
        const name = key.split(".").pop();
        byName.set(name, byName.has(name) && byName.get(name) !== t ? "ambiguous" : t);
    }
    return byName;
})();
let profilePressureUnitTypes = new Map(); // set per parse - see buildProfilePressureUnitTypes()
export function buildProfilePressureUnitTypes(discDoc) {
    const map = new Map();
    if (!discDoc?.documentElement) return map;
    qsa(discDoc, "DataProperty").forEach(dp => {
        const types = qsa(dp, "DataTypeReference").map(r => r.getAttribute("type") || "");
        const t = types.some(x => /PressureGaugeUnit$/.test(x)) ? "PressureGaugeUnit"
            : types.some(x => /PressureAbsoluteUnit$/.test(x)) ? "PressureAbsoluteUnit" : null;
        if (!t) return;
        const name = dp.getAttribute("name");
        const uri = directDataText(dp, "MetaData/rdl_uri");
        if (name) map.set(name, t);
        if (uri) map.set(uri, t);
    });
    return map;
}
function gaUnitType(ga) {
    const type = ga.getAttribute("Type") || "";
    const typeUri = ga.getAttribute("TypeURI") || "";
    if (/^PressureGaugeUnit$/i.test(type)) return "PressureGaugeUnit";
    if (/^PressureAbsoluteUnit$/i.test(type)) return "PressureAbsoluteUnit";
    if (PRESSURE_GAUGE_TYPE_URIS.has(typeUri)) return "PressureGaugeUnit";
    const bare = (ga.getAttribute("Name") || "").replace(/(AssignmentClass|Specialization)$/, "");
    const fromProfile = profilePressureUnitTypes.get(ga.getAttribute("AttributeURI") || "") || profilePressureUnitTypes.get(bare);
    if (fromProfile) return fromProfile;
    const fromPlant = PLANT_PRESSURE_UNIT_TYPES.get(bare);
    return fromPlant && fromPlant !== "ambiguous" ? fromPlant : null;
}

// Display symbol of a GenericAttribute's Units: a Core.xml unit literal name
// ("Bar", "DegreeCelsius", "Millimetre") becomes its symbol - for a pressure
// via its unit type, so a gauge "Bar" shows "barg" and an absolute one "bar".
// Free-text units (COMOS "barg", "kg/h", "°C") are shown as written.
function unitSymbolFor(units, unitType = null) {
    const u = (units || "").trim();
    if (!u) return null;
    if (unitType && UNIT_SYMBOLS[`${unitType}.${u}`]) return UNIT_SYMBOLS[`${unitType}.${u}`];
    const symbols = new Set(Object.entries(UNIT_SYMBOLS).filter(([k]) => k.endsWith(`.${u}`)).map(([, v]) => v));
    return symbols.size === 1 ? [...symbols][0] : u;
}

// Set point (SP = ) and alarm (H/HH/L/LL=) labels always show the value's
// unit of measure, e.g. "SP = 6 barg" (same rule as DEXPIViewer).
const UNIT_LABEL_ATTRIBUTES = new Set(["SetPoint", "AlarmValue"]);

const ABSOLUTE_PRESSURE_UNIT_RE = /^(bara|bar\s*\(?a\)?|kpaa|kpa\s*\(?a\)?|mpaa|psia|mbara)$/i;
function isFullVacuum(value, units, unitsUri, attrName, unitType = null) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    const u = (units || "").trim();
    // known unit type (GenericAttribute Type, or the attribute's definition)
    if (unitType === "PressureAbsoluteUnit") return value === 0;
    if (unitType === "PressureGaugeUnit") {
        const unit = FULL_VACUUM_GAUGE.find(x => (u && x.re.test(u)) || (unitsUri && unitsUri.endsWith(x.uri))) || FULL_VACUUM_GAUGE[0]; // default bar(g)
        return Math.abs(value - unit.fv) <= Math.abs(unit.fv) * 0.015;
    }
    // unknown: judge by the attribute name and unit text
    if (!/pressure/i.test(attrName || "")) return false;
    if (ABSOLUTE_PRESSURE_UNIT_RE.test(u)) return value === 0;
    const unit = FULL_VACUUM_GAUGE.find(x => (u && x.re.test(u)) || (!u && unitsUri && unitsUri.endsWith(x.uri)));
    return !!unit && Math.abs(value - unit.fv) <= Math.abs(unit.fv) * 0.015;
}

function lookupAttributeText(dataArr, attrName, decimals = null) {
    const found = (dataArr || []).find(d => d.property === `DiscProfile/${attrName}` || d.property === `Proteus/${attrName}` || d.property === `Proteus/${attrName}AssignmentClass`);
    if (!found || found.value === null || found.value === undefined) return "";
    const v = found.value;
    if (isFullVacuum(typeof v === "object" && v?.kind === "PhysicalQuantity" ? v.value : v, found.units, found.unitsUri, attrName, found.unitType)) return "FV";
    if (UNIT_LABEL_ATTRIBUTES.has(attrName) && v && typeof v === "object" && v.kind === "PhysicalQuantity" && v.value !== null && v.value !== undefined) {
        return [formatLabelNumber(v.value, decimals), v.unit].filter(Boolean).join(" ");
    }
    if (typeof v === "number") return formatLabelNumber(v, decimals);
    if (v && typeof v === "object" && v.kind === "PhysicalQuantity") return v.value !== null && v.value !== undefined ? formatLabelNumber(v.value, decimals) : "";
    if (v && typeof v === "object" && v.kind === "DataReference") return v.value.split(".").pop().split("/").pop();
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
}

// Equipment box value columns (ND0300B..ND0310B, DiscProfile 0.6.6).
const EQUIPMENT_BOX_SYMBOL_RE = /^ND03(0\d|10)B$/;

// An equipment's Chambers: nested <Equipment ComponentClass="Chamber">
// children carrying the design / operating pressures and temperatures an
// equipment box label shows (e.g. the hot and cold side of a heat exchanger).
function chamberElementsOf(ownerEl) {
    return ownerEl ? directChildrenByTag(ownerEl, "Equipment").filter(c => c.getAttribute("ComponentClass") === "Chamber") : [];
}

// A Chamber's ChamberFunction (GenericAttribute ChamberFunction /
// ChamberFunctionSpecialization, as a name or an RDL URI), normalized to
// "Cooling" / "Heating" / other literal name; "" when absent.
function proteusChamberFunction(chamberEl) {
    for (const group of directChildrenByTag(chamberEl, "GenericAttributes")) {
        for (const ga of directChildrenByTag(group, "GenericAttribute")) {
            if (!/^ChamberFunction(?!Representation)/i.test(ga.getAttribute("Name") || "")) continue;
            const raw = ga.getAttribute("Value") || ga.getAttribute("ValueURI") || "";
            const last = raw.split(/[/#.:]/).filter(Boolean).pop() || "";
            if (/cooling/i.test(last)) return "Cooling";
            if (/heating/i.test(last)) return "Heating";
            return last;
        }
    }
    return "";
}

// Hot / cold side of an equipment box (ND0309B heat exchanger: the 1st
// occurrence of a repeated template is the hot side, the 2nd the cold
// side) is picked by ChamberFunction, not document order:
//   hot side  -> ChamberFunction Cooling
//   cold side -> ChamberFunction Heating
// Falls back to the Nth Chamber when none carries the expected function.
const CHAMBER_SIDE_FUNCTIONS = ["Cooling", "Heating"];
function chamberForSide(ownerEl, side) {
    const chambers = chamberElementsOf(ownerEl);
    const want = CHAMBER_SIDE_FUNCTIONS[side];
    return (want && chambers.find(c => proteusChamberFunction(c) === want)) || chambers[side] || null;
}

// Plain LabelTemplate tokens that live on the owning PlantStructureItem
// (ProcessPlant/PlantSystem) rather than on the labeled object itself,
// resolved via a fixed Association Type back to that structure item.
const PLANT_STRUCTURE_ATTRIBUTE_FALLBACKS = {
    ProcessPlantIdentificationCode: { assocType: "is a part of", targetClass: "ProcessPlant" },
    PlantSystemIdentificationCode: { assocType: "is located in", targetClass: "PlantSystem" },
};

// PipeOffPageConnector/SignalOffPageConnector attributes referenced by a
// LabelTemplate live on a nested PipeOffPageConnectorReference/
// SignalOffPageConnectorReference child element rather than on the
// connector itself.
const OFF_PAGE_CONNECTOR_REFERENCE_CHILD_TAGS = ["PipeOffPageConnectorReference", "SignalOffPageConnectorReference"];

// Substitutes every "<AttributeName>" / "RelatedClass:<AttributeName>" token
// in a LabelTemplate's raw Text with its resolved value, preserving literal
// text around/between tokens.
//
// "<AttributeName>" resolves against the labeled object's own data, falling
// back to PLANT_STRUCTURE_ATTRIBUTE_FALLBACKS or the object's off-page
// connector reference child when not found directly.
// "RelatedClass:<AttributeName>" resolves against a related object
// referenced via an <Association> whose target's ComponentClass matches
// RelatedClass. An unresolved token becomes an empty string.
//
// Also reports whether the template contained any token (hasToken) and
// whether at least one resolved to a non-empty value (hasValue).
// options.chamberSide (0 = hot side, 1 = cold side, null = any): for a
// token the object itself doesn't carry, which of its Chambers to read -
// see chamberForSide(). With chamberSide null the first Chamber that has a
// value is used. options.decimals rounds numeric values (see
// lookupAttributeText()).
// A LabelTemplate Text may be a VB-style formula: quoted literals joined by
// "&" ("'SP = ' & <SetPoint>", "'HH=' & SignalConveyingFunction:<AlarmValue>",
// "'H'"). The quotes and "&" operators are formula syntax, not label text:
// parts are concatenated, a quoted part keeps its inner text verbatim (spaces
// included), unquoted parts are trimmed. Unbalanced edge quotes from older
// profiles ("H=' & ...") are dropped. Text without quotes is plain text, its
// "&" shown as is (the equipment box "<A> & <B> / <C>" lines). Same rule as
// DEXPIViewer's unwrapLabelFormula().
function unwrapLabelFormula(text) {
    if (!/'/.test(text)) return text;
    if ((text.match(/'/g) || []).length % 2) return text.replace(/'\s*&\s*/g, "").replace(/^'|'$/g, "");
    const parts = [];
    let cur = "", inQuote = false;
    for (const ch of text) {
        if (ch === "'") { inQuote = !inQuote; cur += ch; }
        else if (ch === "&" && !inQuote) { parts.push(cur); cur = ""; }
        else cur += ch;
    }
    parts.push(cur);
    return parts.map(part => {
        const t = part.trim();
        const m = /^'([^']*)'$/.exec(t);
        if (m) return m[1];
        return t.replace(/^'|'$/g, "");
    }).join("");
}

function resolveLabelTemplateText(rawText, el, ownData, elementById, dataByObjectId, options = {}) {
    if (!rawText) return { text: "", hasToken: false, hasValue: false };
    rawText = String(rawText).split(/\r?\n/).map(unwrapLabelFormula).join("\n");
    const { chamberSide = null, decimals = null } = options;
    let hasToken = false;
    let hasValue = false;
    const resolveToken = (relatedClass, attrName) => {
        if (!relatedClass) {
            const own = lookupAttributeText(ownData, attrName, decimals);
            if (own) return own;
            const chambers = chamberElementsOf(el);
            if (chambers.length) {
                const chamberData = c => dataByObjectId.get(c.getAttribute("ID"));
                if (chamberSide !== null) {
                    // a repeated (per-side) template reads only its own side's
                    // Chamber, blank rather than another chamber's value
                    const ch = chamberForSide(el, chamberSide);
                    return ch ? lookupAttributeText(chamberData(ch), attrName, decimals) : "";
                }
                for (const c of chambers) {
                    const v = lookupAttributeText(chamberData(c), attrName, decimals);
                    if (v) return v;
                }
            }
            const fallback = PLANT_STRUCTURE_ATTRIBUTE_FALLBACKS[attrName];
            if (fallback) {
                const structureId = directChildrenByTag(el, "Association")
                    .filter(a => a.getAttribute("Type") === fallback.assocType)
                    .map(a => a.getAttribute("ItemID"))
                    .find(itemId => itemId && elementById.get(itemId)?.getAttribute("ComponentClass") === fallback.targetClass);
                const structureVal = structureId ? lookupAttributeText(dataByObjectId.get(structureId), attrName) : "";
                if (structureVal) return structureVal;
            }
            const refChildEl = OFF_PAGE_CONNECTOR_REFERENCE_CHILD_TAGS
                .map(tag => directChildrenByTag(el, tag)[0])
                .find(Boolean);
            const refId = refChildEl?.getAttribute("ID");
            const refVal = refId ? lookupAttributeText(dataByObjectId.get(refId), attrName) : "";
            return refVal || own;
        }
        const relatedId = directChildrenByTag(el, "Association")
            .map(a => a.getAttribute("ItemID"))
            .find(itemId => itemId && elementById.get(itemId)?.getAttribute("ComponentClass") === relatedClass);
        if (!relatedId) return "";
        return lookupAttributeText(dataByObjectId.get(relatedId), attrName);
    };
    const text = rawText.replace(LABEL_TEMPLATE_TOKEN_RE, (match, relatedClass, attrName) => {
        hasToken = true;
        const resolved = resolveToken(relatedClass, attrName);
        if (resolved) hasValue = true;
        return resolved;
    });
    return { text, hasToken, hasValue };
}

// ---------------------------------------------------------------------------
// "Invalid Text Template Attribute Reference" validation
//
// A Proteus <Text> can carry a <TextStringFormatSpecification> declaring
// which of the owning object's attributes its literal String value
// represents (DependantAttribute). Once a DiscProfile.xml is loaded, that
// attribute is only valid if it is one the resolved symbol's own
// LabelTemplates declare.
// ---------------------------------------------------------------------------

// Union of every distinct "<AttributeName>" token referenced across all of
// a Profile/Symbol's variants' LabelTemplates.
export function symbolLabelAttributeNames(symbol) {
    const names = new Set();
    (symbol?.variants || []).forEach(variant => {
        (variant.labelTemplates || []).forEach(lt => {
            const re = /(?:[A-Za-z]\w*:)?<([^<>]+)>/g;
            let m;
            while ((m = re.exec(lt.text || ""))) names.add(m[1]);
        });
    });
    return names;
}

// Reads the DependantAttribute+ItemID pairs from a Text element's own
// TextStringFormatSpecification/ObjectAttributesReference children. Returns
// null when the Text has no TextStringFormatSpecification.
export function readTextTemplateReferences(textEl) {
    const specEl = directChildrenByTag(textEl, "TextStringFormatSpecification")[0];
    if (!specEl) return null;
    return directChildrenByTag(specEl, "ObjectAttributesReference")
        .map(ref => ({ attribute: ref.getAttribute("DependantAttribute"), itemId: ref.getAttribute("ItemID") }))
        .filter(r => r.attribute);
}

// Convenience wrapper over readTextTemplateReferences() returning just the
// attribute-name strings.
export function readTextTemplateDependantAttributes(textEl) {
    const refs = readTextTemplateReferences(textEl);
    return refs ? refs.map(r => r.attribute) : null;
}

// A reference whose ItemID resolves to a <Note ComponentClass="Note">
// element is always valid, independent of the annotated item's own symbol
// or whether a DiscProfile.xml is loaded.
const NOTE_COMPONENT_CLASS = "Note";

// Looks up one GenericAttribute's raw Value off the object a reference's
// ItemID points to, scanning all GenericAttributes groups. Matches by exact
// name first, then by "<attributeName>AssignmentClass". Returns null when
// the ItemID doesn't resolve or no attribute matches either form.
// decimals (optional): a numeric GenericAttribute (Format double / float /
// integer types) is shown with exactly this many decimals - the same rule
// the equipment box value columns' LabelTemplate overlays use (see
// formatLabelNumber()), so a box's own label text and its "Profile labels"
// overlay show the same "91.0". Text values are never rounded.
const NUMERIC_GA_FORMATS = new Set(["double", "float", "integer", "long", "short", "byte", "ulong"]);
function gaDisplayValue(ga, decimals) {
    const raw = ga.getAttribute("Value");
    if (raw !== null && raw.trim() !== "" && NUMERIC_GA_FORMATS.has(ga.getAttribute("Format") || "")
        && isFullVacuum(Number(raw), ga.getAttribute("Units"), ga.getAttribute("UnitsURI"), (ga.getAttribute("Name") || "").replace(/AssignmentClass$/, ""), gaUnitType(ga))) return "FV";
    if (raw !== null && UNIT_LABEL_ATTRIBUTES.has((ga.getAttribute("Name") || "").replace(/AssignmentClass$/, "")) && ga.getAttribute("Units")) {
        const n = Number(raw);
        const val = NUMERIC_GA_FORMATS.has(ga.getAttribute("Format") || "") && raw.trim() !== "" && Number.isFinite(n) ? formatLabelNumber(n, decimals) : raw;
        return `${val} ${unitSymbolFor(ga.getAttribute("Units"), gaUnitType(ga))}`;
    }
    if (decimals === null || decimals === undefined || raw === null) return raw;
    if (!NUMERIC_GA_FORMATS.has(ga.getAttribute("Format") || "")) return raw;
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? formatLabelNumber(n, decimals) : raw;
}
function resolveDependantAttributeValue(itemId, attributeName, elementById, decimals = null) {
    const target = itemId ? elementById?.get(itemId) : null;
    if (!target) return null;
    const suffixedName = `${attributeName}AssignmentClass`;
    let suffixedValue = null;
    for (const group of directChildrenByTag(target, "GenericAttributes")) {
        for (const ga of directChildrenByTag(group, "GenericAttribute")) {
            const name = ga.getAttribute("Name");
            if (name === attributeName) return gaDisplayValue(ga, decimals);
            if (suffixedValue === null && name === suffixedName) suffixedValue = gaDisplayValue(ga, decimals);
        }
    }
    return suffixedValue;
}

// Resolves the value a Text's own TextStringFormatSpecification should
// display: every <ObjectAttributesReference>, concatenated in document
// order. A reference with no ItemID contributes its own DependantAttribute
// text verbatim (a literal separator). A reference with an ItemID
// contributes the live GenericAttribute Value off its target, but only once
// validated: it targets a Note (see NOTE_COMPONENT_CLASS), or its
// DependantAttribute is in the resolved symbol's declared label attributes.
// Returns null when there is no TextStringFormatSpecification, no
// ItemID-bearing reference, or any reference fails to validate or resolve.
export function resolveTextTemplateValue(textEl, allowedAttrNames, elementById, decimals = null) {
    const refs = readTextTemplateReferences(textEl);
    if (!refs || refs.length === 0) return null;
    const parts = [];
    let hasItemIdRef = false;
    for (const ref of refs) {
        if (!ref.itemId) {
            parts.push(ref.attribute);
            continue;
        }
        hasItemIdRef = true;
        const isNoteRef = elementById?.get(ref.itemId)?.getAttribute("ComponentClass") === NOTE_COMPONENT_CLASS;
        if (!isNoteRef && !(allowedAttrNames && allowedAttrNames.has(ref.attribute))) return null;
        const value = resolveDependantAttributeValue(ref.itemId, ref.attribute, elementById, decimals);
        if (value === null) return null;
        parts.push(value);
    }
    if (!hasItemIdRef) return null;
    return parts.join("");
}

// True when resolveTextTemplateValue() finds a valid, resolvable reference.
export function isValidTextTemplateAttribute(textEl, allowedAttrNames, elementById) {
    return resolveTextTemplateValue(textEl, allowedAttrNames, elementById) !== null;
}

function buildProteusGraphics(elementById, symbolMap, shapeCatalogue, embeddedShapeMap, dataByObjectId, discProfileLoaded) {
    const elements = [];
    // Keyed by the id of the element that owns the ComponentName+Position that
    // placed it, for the Details panel's "Symbol Reference" section.
    const symbolReferences = new Map();
    // Keyed by the owner object's id -> an array of that owner's nested
    // <Label ComponentName="..."> Symbol Reference entries, for the Details
    // panel's "Label Symbol Reference" section.
    const labelSymbolReferencesByOwner = new Map();
    // Keyed by representedId -> a Set of Note object ItemIDs referenced by
    // that item's Label Texts, for the Details panel's "Notes" section.
    // Converted to an array before this function returns.
    const noteReferencesByOwner = new Map();

    elementById.forEach((el, id) => {
        const componentName = el.getAttribute("ComponentName");
        const pos = readPosition(el);
        let placedVariant = null; // captured for the label-template fallback below
        // True only when placedVariant came from the loaded DiscProfile.xml, not
        // the embedded-ShapeCatalogue fallback.
        let placedFromDiscProfile = false;
        // The DiscProfile-resolved Profile/Symbol object (all its variants),
        // captured when placedFromDiscProfile is true, for
        // symbolLabelAttributeNames().
        let placedProfileSymbol = null;

        // Rule 2: shape placement - resolve geometry from the loaded
        // DiscProfile.xml first (ComponentName -> SymbolRegistrationNumber ->
        // Profile/Symbol), falling back to the Proteus file's own embedded
        // <ShapeCatalogue> primitives when no DiscProfile.xml is loaded or it
        // doesn't register this ComponentName.
        if (componentName && pos) {
            const regNum = shapeCatalogue.get(componentName);
            const profileSymbol = regNum ? symbolMap.get(`DiscProfile/${regNum}`) : null;

            // With a profile loaded, a ComponentName that references a symbol is
            // drawn from that reference or not at all; the embedded primitives are
            // only used when no profile is loaded or the ComponentName has no
            // registration number.
            const referenceUnresolved = discProfileLoaded && !!regNum && !profileSymbol;
            const symbol = profileSymbol
                || (referenceUnresolved ? null : embeddedShapeMap.get(componentName) || null);
            const symbolFromProfile = !!profileSymbol;
            if (symbol) {
                const variant = pickVariant(symbol, dataByObjectId.get(id));
                if (variant) {
                    placedVariant = variant;
                    placedFromDiscProfile = symbolFromProfile;
                    placedProfileSymbol = symbolFromProfile ? profileSymbol : null;
                    // A symbol placement with no <Scale> element draws at readScale()'s
                    // default 1x1 fallback. A malformed <Scale> (non-numeric X/Y) still
                    // collapses to a zero-size point.
                    const scale = readScale(el);
                    elements.push({
                        kind: "symbolUsage", key: `sym_${id}`, representedId: id, elementRole: "symbol",
                        symbol, variant, position: { x: pos.x, y: pos.y }, rotation: pos.rotation,
                        scaleX: scale.x, scaleY: scale.y, isMirrored: pos.isMirrored,
                    });
                }
            }
            // Symbol Reference info (Details pane) - recorded for every element
            // carrying a ComponentName+Position, regardless of whether it resolved
            // to a drawable symbol.
            const axisRef = readAxisReference(el);
            const ref = {
                regNum: regNum || null, componentName,
                axis: axisRef?.axis || null, reference: axisRef?.reference || null,
                scale: readRawScale(el),
            };
            symbolReferences.set(id, ref);
            // Also indexes under the owning object when `el` is a Label
            // annotating something else.
            if (el.tagName === "Label") {
                const labelOwnerId = resolveLabelOwnerId(el, id, elementById);
                if (labelOwnerId !== id) {
                    if (!labelSymbolReferencesByOwner.has(labelOwnerId)) labelSymbolReferencesByOwner.set(labelOwnerId, []);
                    labelSymbolReferencesByOwner.get(labelOwnerId).push({ labelId: id, ...ref });
                }
            }
        }

        // "Profile labels" support: computes isDiscProfileLabel/isProfileGoverned/
        // hasProfileAttributeBacking/validRawProfileText for a placed symbol's
        // real <Label> Text. A Proteus <Text> is always a plain literal String, so
        // isProfileGoverned is identical to isDiscProfileLabel here.
        //
        // ownerId/ownerEl/ownData resolve the object every real <Label> under
        // `el` represents, computed once for reuse below.
        const ownerId = resolveLabelOwnerId(el, id, elementById);
        const ownerEl = elementById.get(ownerId) || el;
        const ownData = dataByObjectId.get(ownerId) || [];
        // isDiscProfileLabel: true when this element's symbol was placed from
        // the loaded DiscProfile.xml catalogue (not the embedded-ShapeCatalogue
        // fallback).
        const isDiscProfileLabel = placedFromDiscProfile;
        // Only the first catalog LabelTemplate (labelTemplates[0]) counts for
        // backing/resolution purposes.
        const catalogTemplateText = placedVariant?.labelTemplates?.[0]?.text;
        const hasProfileAttributeBacking = !!(catalogTemplateText && /[<>]/.test(catalogTemplateText));
        const resolvedProfileTemplate = hasProfileAttributeBacking
            ? resolveLabelTemplateText(catalogTemplateText, ownerEl, ownData, elementById, dataByObjectId)
            : { text: "", hasToken: false, hasValue: false };
        const validRawProfileText = resolvedProfileTemplate.text;
        // False only when every token in the template resolved to an empty
        // value; a purely literal template (no tokens) stays true.
        const hasProfileAttributeValue = !resolvedProfileTemplate.hasToken || resolvedProfileTemplate.hasValue;
        // Allowed label-attribute set for this element's placed symbol; null
        // when isDiscProfileLabel is false.
        const allowedLabelAttrNames = isDiscProfileLabel ? symbolLabelAttributeNames(placedProfileSymbol) : null;

        // Text labels: `el` can be a normal placed item with nested <Label>
        // children (ownLabelEls), or a standalone <Label> with no tracked XML
        // parent (labelSelfEls) - together these cover every <Label> in the
        // document exactly once. Rule 2 above already handles a Label's own
        // ComponentName resolving to a registered symbol.
        const parentId = el.parentNode?.getAttribute?.("ID");
        const isNestedLabel = el.tagName === "Label" && !!parentId && elementById.has(parentId);
        const ownLabelEls = directChildrenByTag(el, "Label");
        const labelSelfEls = (el.tagName === "Label" && !isNestedLabel) ? [el] : [];
        [...ownLabelEls, ...labelSelfEls].forEach((labelEl, li) => {
            // representedId is the object this label is annotating (see
            // resolveLabelOwnerId()); a nested Label represents its owner directly.
            const representedId = labelEl === el ? resolveLabelOwnerId(el, id, elementById) : id;

            directChildrenByTag(labelEl, "Text").forEach((textEl, ti) => {
                const str = textEl.getAttribute("String");
                if (!str) return;
                // "Notes" Details-pane section support: runs unconditionally, before
                // the validity gate below.
                readTextTemplateReferences(textEl)?.forEach(ref => {
                    if (ref.itemId && elementById.get(ref.itemId)?.getAttribute("ComponentClass") === NOTE_COMPONENT_CLASS) {
                        if (!noteReferencesByOwner.has(representedId)) noteReferencesByOwner.set(representedId, new Set());
                        noteReferencesByOwner.get(representedId).add(ref.itemId);
                    }
                });
                // "Invalid Text Template Attribute Reference": once a DiscProfile.xml
                // is loaded, a real <Label> Text is only drawn if its
                // TextStringFormatSpecification reference validates (or is
                // Note-exempt); when drawn, it shows the live resolved value from
                // resolveTextTemplateValue(), not the exported literal String.
                // equipment box value columns (ND0300B..ND0310B) round numbers to 1
                // decimal, like their LabelTemplate overlays below
                const textDecimals = EQUIPMENT_BOX_SYMBOL_RE.test(placedProfileSymbol?.name || "") ? 1 : null;
                const resolvedTemplateValue = discProfileLoaded ? resolveTextTemplateValue(textEl, allowedLabelAttrNames, elementById, textDecimals) : null;
                if (discProfileLoaded && resolvedTemplateValue === null) return;
                // hasOwnValidatedTemplate: true when this Text's own
                // TextStringFormatSpecification reference validated, independent of
                // the owner's isDiscProfileLabel/hasProfileAttributeBacking.
                const hasOwnValidatedTemplate = discProfileLoaded;
                const tPos = readPosition(textEl) || (labelEl === el ? pos : null);
                const j = parseJustification(textEl.getAttribute("Justification"));
                // A Text's own <Position> is read like a symbol placement (readPosition()
                // above). readableLabelOrientation() folds its rotation into a readable
                // angle and swaps the Justification-derived alignment to match.
                const orient = tPos ? readableLabelOrientation(tPos.rotation, j.horizontal, j.vertical) : { rotation: 0, horizontal: j.horizontal, vertical: j.vertical };
                elements.push({
                    kind: "primitive", key: `lbl_${id}_${li}_${ti}`, representedId, elementRole: "label",
                    primitive: {
                        kind: "text", key: `lbltxt_${id}_${li}_${ti}`,
                        position: tPos ? { x: tPos.x, y: tPos.y } : { x: 0, y: 0 },
                        value: str, rotation: orient.rotation,
                        style: {
                            color: { r: 0, g: 0, b: 0 },
                            font: textEl.getAttribute("Font") || "Arial",
                            size: parseFloat(textEl.getAttribute("Height")) || 3.5,
                            horizontal: orient.horizontal, vertical: orient.vertical,
                        },
                        // See the "Profile labels" support block above. hasOwnValidatedTemplate
                        // overrides the "Profile labels" checkbox gating when true.
                        isDiscProfileLabel, isProfileGoverned: isDiscProfileLabel,
                        hasProfileAttributeBacking, hasProfileAttributeValue, validRawProfileText,
                        hasOwnValidatedTemplate, resolvedTemplateValue,
                    },
                });
            });

            // Leader/pointer line, drawn as a thin connector line (same primitive
            // shape CenterLines use below).
            directChildrenByTag(labelEl, "PolyLine").forEach((plEl, pli) => {
                const points = directChildrenByTag(plEl, "Coordinate").map(c => ({
                    x: parseFloat(c.getAttribute("X")) || 0, y: -(parseFloat(c.getAttribute("Y")) || 0),
                }));
                if (points.length < 2) return;
                elements.push({
                    kind: "primitive", key: `lblleader_${id}_${li}_${pli}`, representedId, elementRole: "label",
                    primitive: { kind: "polyline", key: `lblleaderprim_${id}_${li}_${pli}`, points, stroke: { color: "#000000", width: 0.25, dashArray: "" } },
                });
            });
        });

        // Catalog "Profile labels" overlay: for every placed symbol variant with
        // its own LabelTemplates in the loaded DiscProfile.xml, synthesizes a
        // "lbltpl_"-prefixed overlay text for each one. A LabelTemplate's
        // Position/Rotation are in the symbol-local coordinate space and are
        // transformed through the same translate/rotate/scale/mirror math as the
        // symbol placement. Token text is resolved against ownerId/ownerEl/ownData
        // (the owning object), not `el` directly, so a standalone Label placing a
        // symbol resolves tokens against the object it decorates.
        if (placedVariant && placedVariant.labelTemplates?.length) {
            const scale = readScale(el);
            // Equipment boxes repeat the same template once per chamber (ND0309B:
            // hot side, then cold side) - the 1st occurrence reads the Cooling
            // (hot side) Chamber, the 2nd the Heating (cold side) Chamber. Their
            // value columns (ND0300B..ND0310B) round numeric values to 1 decimal.
            const decimals = EQUIPMENT_BOX_SYMBOL_RE.test(placedProfileSymbol?.name || "") ? 1 : null;
            const textCounts = new Map();
            placedVariant.labelTemplates.forEach(lt => textCounts.set(lt.text, (textCounts.get(lt.text) || 0) + 1));
            const textSeen = new Map();
            placedVariant.labelTemplates.forEach((lt, li) => {
                const occurrence = textSeen.get(lt.text) || 0;
                textSeen.set(lt.text, occurrence + 1);
                const chamberSide = textCounts.get(lt.text) > 1 ? occurrence : null;
                const { text, hasToken, hasValue } = resolveLabelTemplateText(lt.text, ownerEl, ownData, elementById, dataByObjectId, { chamberSide, decimals });
                if (!text.trim()) return;
                // Skips a template whose only content is unresolved token(s) with
                // non-empty literal decoration around the missing value.
                if (hasToken && !hasValue) return;
                // Position, readable rotation and alignment per DISC DEXPI rule 'B' -
                // see profileLabelPlacement(). Character-stacked templates skip their
                // own Rotation and draw one upright character per line.
                const stacked = isCharacterStackedLabelTemplate(lt);
                const orient = profileLabelPlacement(lt, pos, scale, stacked);
                const wx = orient.x, wy = orient.y;
                const displayText = stacked ? Array.from(text).join("\n") : text;
                elements.push({
                    kind: "primitive", key: `lbltpl_${id}_${li}`, representedId: ownerId, elementRole: "label",
                    primitive: {
                        kind: "text", key: `lbltpltxt_${id}_${li}`,
                        position: { x: wx, y: wy }, value: displayText, rotation: orient.rotation,
                        style: {
                            color: lt.color,
                            font: lt.font, size: lt.size,
                            horizontal: orient.horizontal, vertical: orient.vertical,
                        },
                    },
                });
            });
        }

        // Pipe / instrument-loop centerlines (Y-up Proteus frame, Y negated).
        // A PipingNetworkSegment's own CenterLine children each get their own
        // selectable identity (matching the synthetic sub-component node built
        // in deriveProteusFlowConnectivity()); CenterLines owned by other
        // element types represent their owner element.
        const isSegmentCenterLine = el.tagName === "PipingNetworkSegment";
        // InformationFlow elements represent signal/instrument wires; their
        // CenterLine is decorated per the SignalConveyingFunctionTypeRepresentation
        // AssignmentClass GenericAttribute (Set="DexpiCustomAttributes"),
        // interpreted by App.jsx's SIGNAL_CONVEYING_MARKS.
        const signalConveyingType = el.tagName === "InformationFlow"
            ? ownGenericAttributeValue(el, "DexpiCustomAttributes", "SignalConveyingFunctionTypeRepresentationAssignmentClass")
            : null;
        // Plain "SignalConveying" (no sub-type) is drawn as a dashed line.
        const dashArray = signalConveyingType === "SignalConveying" ? SIGNAL_CONVEYING_DASH_ARRAY : "";
        directChildrenByTag(el, "CenterLine").forEach((clEl, ci) => {
            const points = directChildrenByTag(clEl, "Coordinate").map(c => ({
                x: parseFloat(c.getAttribute("X")) || 0, y: -(parseFloat(c.getAttribute("Y")) || 0),
            }));
            if (points.length < 2) return;
            const representedId = isSegmentCenterLine ? resolveCenterLineId(clEl, id, ci) : id;
            elements.push({
                kind: "primitive", key: `cl_${id}_${ci}`, representedId, elementRole: "connector",
                signalConveyingType: signalConveyingType || undefined,
                primitive: { kind: "polyline", key: `clprim_${id}_${ci}`, points, stroke: { color: "#000000", width: 0.25, dashArray } },
                // Bridges this polyline to its owning PipingNetworkSegment's id for
                // heat-trace lookup; set only for a segment's own CenterLine children.
                htSegmentId: isSegmentCenterLine ? id : undefined,
            });
        });
    });

    // Converts noteReferencesByOwner's Set values to plain arrays.
    const noteReferencesByOwnerArr = new Map();
    noteReferencesByOwner.forEach((set, ownerId) => noteReferencesByOwnerArr.set(ownerId, [...set]));

    return { elements, nodePosMap: new Map(), symbolReferences, labelSymbolReferencesByOwner, noteReferencesByOwner: noteReferencesByOwnerArr };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function parseProteusPackage(mainXml, discProfileXml) {
    const parser = new DOMParser();
    const mainDoc = parser.parseFromString(mainXml, "application/xml");
    if (mainDoc.querySelector("parsererror")) throw new Error("Proteus XML is not well-formed.");
    if (!isProteusDoc(mainDoc)) throw new Error("File does not appear to be a Proteus / DEXPI PlantModel document.");

    // A DiscProfile.xml is optional. Every downstream index
    // (buildClassRdlUriIndex, buildDataPropertyRdlUriIndex,
    // parseSymbolCatalogue, buildHeatTraceSet) tolerates a null discDoc by
    // returning an empty Map/Set.
    const discDoc = discProfileXml ? parser.parseFromString(discProfileXml, "application/xml") : null;
    if (discDoc && discDoc.querySelector("parsererror")) throw new Error("DiscProfile XML is not well-formed.");

    const classIndex = buildClassRdlUriIndex(discDoc);
    const dataPropIndex = buildDataPropertyRdlUriIndex(discDoc);
    profilePressureUnitTypes = buildProfilePressureUnitTypes(discDoc);
    const proteusShapeCatalogue = buildProteusShapeCatalogue(mainDoc);
    const symbolMap = parseSymbolCatalogue(discDoc);
    // Fallback symbol geometry source, built from the main document's own
    // <ShapeCatalogue>, consulted when the DiscProfile.xml route doesn't
    // resolve a given ComponentName.
    const embeddedShapeMap = buildProteusEmbeddedShapeCatalogue(mainDoc);

    const { tree, elementById, diagnostics } = buildTree(mainDoc, classIndex, dataPropIndex);
    const flatTree = flattenTree(tree);
    const treeMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    const dataByObjectId = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n.data]));

    const graphics = buildProteusGraphics(elementById, symbolMap, proteusShapeCatalogue, embeddedShapeMap, dataByObjectId, !!discDoc);

    const metaEl = qsa(mainDoc, "MetaData")[0];
    const metaGas = metaEl ? ownGenericAttributes(metaEl) : [];
    const gaValue = name => { const g = metaGas.find(x => x.getAttribute("Name") === name); return g ? (g.getAttribute("Value") || "") : ""; };
    const meta = {
        drawingName: gaValue("DrawingNameAssignmentClass"),
        drawingNumber: gaValue("DrawingNumberAssignmentClass"),
        subtitle: gaValue("DrawingSubTitleAssignmentClass"),
        processPlantName: gaValue("ProcessPlantNameAssignmentClass"),
        creatorName: gaValue("CreatorNameAssignmentClass"),
    };

    const connectivityMap = buildConnectivityMap(flatTree);
    const heatTraceSet = buildHeatTraceSet(tree, discDoc);

    return {
        mainDoc, discDoc, tree, flatTree, treeMap, symbolMap, graphics, meta,
        connectivityMap, heatTraceSet,
        _diagnostics: diagnostics,
    };
}
