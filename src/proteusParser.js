// Proteus 4.1.1 / DEXPI 1.3 (<PlantModel> root) parser.
//
// Translates a legacy Proteus/DEXPI-1.3 XML file into the same internal
// tree + graphics model produced by dexpiParser.js's parseDexpiPackage(),
// so the rest of the viewer (tree view, SVG renderer, connectivity map,
// heat-trace overlays) can be reused unchanged.
//
// Mapping rules (per project spec), evaluated against a loaded DEXPI 2.0
// DiscProfile.xml:
//   1. class:     GenericAttribute[Name="TypeURIAssignmentClass"]/@Value
//                 == ConcreteClass/AbstractClass's Data[property="MetaData/rdl_uri"]
//   2. symbol:    ShapeCatalogue element's nested
//                 GenericAttribute[Name="SymbolRegistrationNumberAssignmentClass"]/@Value
//                 == Profile/Symbol Object's "name" attribute
//   3. attribute: GenericAttribute/@AttributeURI
//                 == DataProperty's Data[property="MetaData/rdl_uri"]
//
import {
    qsa, directChildrenByTag, parseSymbolCatalogue, flattenTree,
    buildConnectivityMap, buildHeatTraceSet,
} from "./dexpiParser.js";

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
    // Use children[0] rather than firstElementChild: more broadly supported
    // across DOM implementations (native browser DOMParser supports both, but
    // this avoids any doubt).
    const first = d && d.children && d.children[0];
    return first ? (first.textContent || "").trim() : null;
}

function ownGenericAttributes(el) {
    return directChildrenByTag(el, "GenericAttributes").flatMap(g => directChildrenByTag(g, "GenericAttribute"));
}

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

// Reads a Proteus <Position><Location X Y/><Axis .../><Reference X Y/></Position>
// block, returning a world position + rotation + mirror flag expressed in
// DEXPI's own (SVG-compatible) convention.
//
// Proteus's <Location> uses a Y-up frame (Y increases upward), while
// DEXPI/SVG use Y-down (Y increases downward) - so Y is negated here.
//
// <Axis Z="-1"/> marks a mirrored placement (Z="1"/absent = not mirrored).
//
// The rotation angle is derived from the <Reference> vector via atan2, but
// the correct sign depends on whether the placement is mirrored: negating Y
// flips the effective handedness of the Reference vector's angle, and
// mirroring flips it back again. Both the Y-negation and this sign rule were
// verified against a reference table of all 8 (rotation x mirror)
// combinations - see DEXPI Position (0.03-0.24, 0.05/0.12) vs. Proteus
// Location/Axis/Reference examples - confirming: unmirrored placements use
// atan2(-Reference.Y, Reference.X), mirrored placements use
// atan2(Reference.Y, Reference.X), both normalized to [0,360).
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

// Reads a Proteus <Scale X Y Z/> element (a direct sibling of <Position>),
// returning the X/Y scale factors used to size a placed symbol - e.g.
// <Scale X="4.375" Y="4.03869031814107" Z="1" /> on Equipment ID="XMP_1" in
// FPQ-AKSO-P-XB-20130-01.XML. Z is unused (2D drawings). Falls back to 1/1
// when the element carries no Scale at all, matching the prior (implicit)
// behaviour for such elements.
function readScale(el) {
    const scaleEl = directChildrenByTag(el, "Scale")[0];
    if (!scaleEl) return { x: 1, y: 1 };
    const x = parseFloat(scaleEl.getAttribute("X"));
    const y = parseFloat(scaleEl.getAttribute("Y"));
    return { x: Number.isNaN(x) ? 1 : x, y: Number.isNaN(y) ? 1 : y };
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
// Custom-class check (used by rdlValidate.js, not by the tree-building rules
// above): rdl_uri -> { name, superTypes }.
//
// Proteus's DEXPI 1.3 RDL defines a family of generic "Custom<X>" placeholder
// classes (CustomEquipment, CustomOperatedValve, CustomPipingComponent, ...)
// for use when a real object doesn't correspond to a standard universal RDL
// class. The object's TRUE semantic type is then carried separately via its
// TypeURIAssignmentClass GenericAttribute, which should resolve (through the
// loaded DiscProfile.xml's own rdl_uri-tagged ConcreteClass/AbstractClass
// entries) to a class whose declared superTypes attribute corresponds back
// to the "Custom" class used (e.g. ComponentClass="CustomOperatedValve"
// should resolve to a profile class with superTypes="Plant/Piping.OperatedValve").
//
// Unlike buildClassRdlUriIndex() above (which only needs the resolved
// class's own qualified name, for rule 1's class-mapping), this check needs
// each resolved class's declared superTypes attribute instead - so it's
// captured here, in its own index, dynamically re-derived from whichever
// DiscProfile.xml is currently loaded (there is no static/pre-extracted
// equivalent of this, unlike dexpi13Rdl.json - the mapping is inherently
// profile-specific).
// ---------------------------------------------------------------------------

export function buildProfileClassSuperTypeIndex(discDoc) {
    const map = new Map(); // rdl_uri -> { name, superTypes: string[] }
    if (!discDoc) return map;

    function walk(node) {
        Array.from(node.children || []).forEach(child => {
            const tag = child.tagName;
            if (tag === "ConcreteClass" || tag === "AbstractClass") {
                const name = child.getAttribute("name") || "";
                const uri = directDataText(child, "MetaData/rdl_uri");
                const superTypes = (child.getAttribute("superTypes") || "").split(/\s+/).filter(Boolean);
                if (uri) map.set(uri, { name, superTypes });
            }
            walk(child);
        });
    }
    walk(discDoc.documentElement);
    return map;
}

// ---------------------------------------------------------------------------
// Symbol usage index: registered symbol number -> the one DEXPI class the
// profile declares that symbol may depict.
//
// The loaded DiscProfile.xml registers every drawing symbol as its own
// <Object name="ND0003" type="Profile/Symbol"> element (280 of them in the
// DISC 0.4 profile), and each one carries exactly one direct-child
// <Data property="MetaData/usage"><String>...</String></Data> declaring the
// single class that symbol is meant to represent - e.g.
// "Plant.Instrumentation.ProcessInstrumentationFunction" for ND0003, or
// "DiscProfile.InformationModel.DoubleBlockAndBleedValve" for ND0004.
// Confirmed 1:1 (280 Profile/Symbol objects, 280 MetaData/usage properties)
// across the whole profile - every registered symbol declares exactly one
// expected class, never zero or several.
//
// The usage string's leading segments ("Plant.Instrumentation", "Core.Diagram",
// "DiscProfile.InformationModel") are just a namespace/package prefix; the
// class name itself is always the final "."-separated segment, and that name
// resolves either directly against a static dexpi13Rdl.json class (the
// "Plant.X.Y"/"Core.X.Y" forms) or against a ConcreteClass/AbstractClass name
// declared elsewhere in this same DiscProfile.xml (the "DiscProfile.X.Y"
// forms, the same profile classes buildProfileClassSuperTypeIndex() resolves).
// Callers don't need to tell these two forms apart - they just compare the
// trailing class name against a real object's ComponentClass (see
// rdlValidate.js's classSatisfiesConstraint(), which already handles both a
// direct/inherited static-RDL match and a Custom<X>-via-TypeURIAssignmentClass
// profile-class match).
export function buildSymbolUsageIndex(discDoc) {
    const map = new Map(); // symbol registration number (e.g. "ND0003") -> expected class name
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
// Rule 2 — Proteus ShapeCatalogue: ComponentName -> SymbolRegistrationNumber
// (joined with parseSymbolCatalogue(discDoc), which keys symbols by
//  "DiscProfile/<Symbol Object name>")
//
// This ONLY reads the SymbolRegistrationNumberAssignmentClass GenericAttribute
// off each ShapeCatalogue entry, to find which DiscProfile.xml Symbol it
// corresponds to. Any graphical primitives a Proteus file's own ShapeCatalogue
// entries might carry are deliberately never read or rendered - all symbol
// geometry (primitives, variant bounds, node positions) comes exclusively
// from parseSymbolCatalogue(discDoc), i.e. from DiscProfile.xml.
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

// Unlike ownGenericAttributes() (which flattens across all GenericAttributes
// groups for name-based lookups that don't care which group an attribute
// came from), this walks group-by-group so each attribute can be tagged with
// its enclosing group's Set="..." value. That tag lets the UI (App.jsx's
// Data panel) distinguish real DEXPI-modeled attributes (Set="DexpiAttributes"
// or "DexpiCustomAttributes") from vendor/tool-specific ones (any other Set,
// or none at all) and hide the latter by default.
function resolveObjectData(el, dataPropIndex) {
    const out = [];
    directChildrenByTag(el, "GenericAttributes").forEach(group => {
        const set = group.getAttribute("Set"); // null if the group has no Set attribute
        directChildrenByTag(group, "GenericAttribute").forEach(ga => {
            const name = ga.getAttribute("Name");
            if (name === "TypeURIAssignmentClass") return; // internal marker, not a display attribute
            const attrUri = ga.getAttribute("AttributeURI");
            const rawValue = ga.getAttribute("Value");
            const format = ga.getAttribute("Format") || "";
            const value = coerceValue(rawValue, format);
            const mappedProp = attrUri ? dataPropIndex.get(attrUri) : null;
            out.push({ property: mappedProp || `Proteus/${name}`, value, set });
        });
    });
    return out;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

// ComponentClass values that carry Proteus's instrumentation/signal-wire
// Association vocabulary ("has logical start"/"has logical end") - see rule
// 2 in deriveProteusFlowConnectivity()'s module comment. Exported so
// rdlValidate.js can check that an InformationFlow element's ComponentClass
// (if present at all) is actually one of these - confirmed against the
// DEXPI 1.3 RDL to be the complete, exact set: SignalConveyingFunction is a
// concrete class in its own right, with exactly two concrete subtypes,
// MeasuringLineFunction and SignalLineFunction.
export const SIGNAL_FLOW_COMPONENT_CLASSES = new Set(["SignalConveyingFunction", "MeasuringLineFunction", "SignalLineFunction"]);

// Coordinate-matching tolerance (in drawing units) used by rule 4 below.
// DISC-authored files use byte-identical coordinates between a CenterLine's
// endpoint and the connection-point Node it meets, but Comos/AKSO-style
// exports can drift by a few ten-thousandths of a unit on secondary points
// (observed: X="206" vs X="205.9998"). 0.001 comfortably covers that drift
// without being loose enough to false-match distinct nearby points.
const CENTERLINE_MATCH_TOLERANCE = 0.001;

// ---------------------------------------------------------------------------
// Proteus-specific connectivity derivation.
//
// IMPORTANT: the upstream/downstream/group buckets that buildConnectivityMap()
// (dexpiParser.js) produces are meant to represent genuine PHYSICAL
// connectivity - i.e. things derivable from x/y position (a CenterLine's
// endpoints, or two components' connection-point Nodes literally touching).
// Document-order facts like "this item happens to be the first/last child of
// its enclosing Segment/System" are NOT physical connectivity (an item can be
// the last item of a Segment without being connected to anything at all),
// so those are deliberately kept OUT of the upstream/downstream/group
// buckets and instead recorded under their own dedicated ref types (see
// "Segment/System containment" below), which App.jsx's Connections tab
// renders as their own separate, clearly-labeled categories rather than
// folding them into Upstream/Downstream/Group.
//
// Rule 4 - CenterLine (position-based): a segment's CenterLine children are
// pipe-routing geometry connecting two real components. For each CenterLine,
// resolve which component owns the connection-point Node matching its FIRST
// Coordinate (that component is upstream) and which owns the Node matching
// its LAST Coordinate (downstream), then link those two components directly
// - this is what actually produces component-to-component connectivity for
// files (like AKSO's) that have no <Connection> elements inside their
// PipingNetworkSegments at all. This is the primary source of the
// upstream/downstream buckets. The two components are only cross-linked to
// EACH OTHER when BOTH ends resolve; if only one end matches a component (the
// other end's Coordinate doesn't land on any component's connection point,
// and there's no PipeOffPageConnector to fall back to either), that one match
// is still kept rather than discarded - it's recorded on the CenterLine's own
// synthetic sub-node (see makeCenterLineNode()) as a one-sided
// upstream-only or downstream-only match, so a short stub segment with an
// unresolved far end doesn't lose the connection info it does have.
//
// Rule 5 - Coincident connection points (position-based): two different
// components' ConnectionPoints/Node entries sometimes sit at the exact same
// physical position with no CenterLine drawn between them at all - e.g.
// Comos/AKSO exports mark a segment ComponentClass="OrphanPipingNetworkSegment"
// when it couldn't resolve a pipe route, but still place the segment's items
// touching their neighbors' connection points directly, with zero
// <CenterLine> children anywhere in that segment. Rule 4 above only derives
// connectivity from an explicit CenterLine's endpoints, so these direct
// touches were previously invisible to the connectivity map entirely - see
// buildCoincidentNodeGroups()'s doc comment for the matching/exclusion logic.
// There's no CenterLine geometry to give these an upstream/downstream
// ordering (both nodes are literally the same point, so there's no
// first-vs-last coordinate to infer direction from), so they're recorded as
// non-directional "group" links instead of a guessed upstream/downstream.
// This is the sole source of the group bucket.
//
// Segment/System containment (structural, NOT position-based): every direct
// item of a PipingNetworkSegment gets a "direct item of Segment" ref pointing
// at its segment (and the segment gets the reciprocal "segment item (direct)"
// ref back). If that segment itself sits directly inside a PipingNetworkSystem,
// every one of its items ALSO gets an "indirect item of System" ref pointing
// at that system (reciprocal: "system item (indirect)") - "indirect" because
// the item is a direct child of the Segment, only a grandchild of the System.
// These property names are deliberately chosen to avoid the substrings
// buildConnectivityMap()/isConnectivityRefProperty() (dexpiParser.js) match
// on ("upstream", "downstream", "piping", "member", "function", "instrument",
// ...), so they never leak into the upstream/downstream/group buckets - they
// exist purely so App.jsx's Connections tab can show Segment/System
// membership as its own separate category.
//
// Signal association (structural, NOT position-based): "has logical
// start"/"has logical end" Associations live only on the InformationFlow
// element itself (see buildTree()'s Association-to-refs mapping) and are
// left as their raw Association Type strings rather than being renamed to
// "upstream (Signal)"/"downstream (Signal)" - so they're likewise excluded
// from the upstream/downstream buckets and shown as their own category. The
// reverse-direction ref ("is logical start of"/"is logical end of") is added
// here onto whichever component is actually referenced (the signal's
// Source/Target), so selecting that component also surfaces the signal-wire
// relationship, not just when selecting the wire itself.
//
// Rule 6 - InformationFlow CenterLine (position-based): same idea as rule 4,
// applied to an InformationFlow (signal wire) element's own direct CenterLine
// child instead of a PipingNetworkSegment's. The wire's first/last Coordinate
// are matched against real components' ConnectionPoints/Node positions via
// the same findOwner() index rule 4 uses, and the two matched components ARE
// linked as genuine upstream/downstream - into the same buckets rule 4 feeds.
// This is intentionally kept alongside, not instead of, the Signal
// association info above: that reflects the file's DECLARED logical
// endpoints, this reflects where the drawn wire geometry actually lands,
// and the two do not always agree. As with rule 4, the two components are
// only cross-linked to EACH OTHER when BOTH ends resolve; the InformationFlow
// element itself gets whichever end(s) it has regardless - e.g. XMP_4985's
// CenterLine showing a Downstream Node of XMP_3121 even on a wire whose other
// end doesn't land on any component's connection point - so a one-sided match
// isn't discarded just because the far end is unresolved.
// buildConnectionPointIndex() deliberately excludes InformationFlow-owned
// ConnectionPoints from the index this rule searches, since a wire's own
// connection points sit at the exact same x/y as its own CenterLine ends and
// would otherwise self-match, hiding the real neighbouring component behind
// a self-reference to the wire itself.
// ---------------------------------------------------------------------------

function segmentItemElements(segEl) {
    return Array.from(segEl.children).filter(c => c.getAttribute && c.getAttribute("ID"));
}

// Fallback synthetic objectId for a PipingNetworkSegment's Nth CenterLine
// child, used only when the CenterLine element itself has no ID attribute
// (true for e.g. DISC-authored files). Comos/AKSO-style exports DO give
// CenterLine its own real ID (e.g. ID="XMP_3886"), which is preferred - see
// resolveCenterLineId() - since it's the id already used and cross-
// referenced everywhere else in that file. This fallback just guarantees a
// stable, unique, selectable identity exists either way, so the CenterLine
// can appear as its own sub-component in the tree and be individually
// clicked/highlighted in the drawing.
function centerlineObjectId(segId, idx) {
    return `${segId}::CL${idx + 1}`;
}

// Resolves the id to use for one CenterLine child: its own ID attribute if
// present, otherwise the synthetic fallback above. Shared between
// deriveProteusFlowConnectivity() (which builds the tree node) and
// buildProteusGraphics() (which must tag the matching polyline with the same
// id) so the two stay in sync.
function resolveCenterLineId(clEl, segId, idx) {
    return clEl.getAttribute("ID") || centerlineObjectId(segId, idx);
}

// Builds the synthetic tree node for one CenterLine, with its own
// upstream/downstream refs (per rule 4) so selecting it - whether from the
// tree or by clicking its polyline in the drawing - shows exactly the two
// components it connects in the Connections panel.
//
// docOrder records this CenterLine's index among its owning segment's direct
// XML children (the same index space used for the segment's real item
// children - see segmentItemElements()) purely so buildTree()'s final
// sort pass can interleave CenterLines and items back into true file order;
// it's not displayed anywhere.
function makeCenterLineNode(objectId, pointCount, upstreamId, downstreamId, docOrder) {
    const refs = [];
    if (upstreamId) refs.push({ property: "upstream (CenterLine)", objects: [upstreamId] });
    if (downstreamId) refs.push({ property: "downstream (CenterLine)", objects: [downstreamId] });
    return {
        // label is the objectId itself (rather than a friendly "CenterLine N"
        // name) so the tree view - which always displays node.label - shows
        // the same ID as the Sub-Components/Connections panels, consistent
        // with every other node type now showing ID rather than a name.
        id: objectId, objectId, type: "Plant/Segment.CenterLine", label: objectId,
        tagName: "", subTagName: "", loopNum: "",
        data: [{ property: "Proteus/PointCount", value: pointCount, set: undefined }],
        persistentIdentifiers: [], refs, children: [], _docOrder: docOrder,
    };
}

// Indexes every component's <ConnectionPoints><Node><Position><Location X Y/>
// by coordinate, for rule 4's (and rule 6's) tolerance-based matching. Uses a
// spatial hash (grid bucketed at the tolerance size) so lookups stay fast
// even on large files with thousands of connection points.
//
// InformationFlow elements are deliberately excluded here: a signal wire's
// own <ConnectionPoints> "From"/"To" Nodes mark its OWN CenterLine's two
// endpoints, at the exact same x/y - not a second, different component to
// connect to. Left in the index, a wire's own CenterLine would frequently
// self-match its own connection point (a plain document-order tie against
// the real neighbouring component's node at the same position, which the
// wire's own point can win), silently hiding the genuine upstream/downstream
// component behind a self-reference to the wire itself. See rule 6's doc
// comment above deriveProteusFlowConnectivity() for how this index is used.
function buildConnectionPointIndex(mainDoc) {
    const bucketOf = v => Math.round(v / CENTERLINE_MATCH_TOLERANCE);
    const bucketKey = (bx, by) => `${bx},${by}`;
    const grid = new Map();

    qsa(mainDoc, "ConnectionPoints").forEach(cp => {
        const owner = cp.parentElement;
        const ownerId = owner && owner.getAttribute ? owner.getAttribute("ID") : null;
        if (!ownerId || owner.tagName === "InformationFlow") return;
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

// Max distinct component IDs allowed to share one coincident position bucket
// (see buildCoincidentNodeGroups() below) before that position is treated as
// a degenerate placeholder rather than a real multi-way junction. Confirmed
// empirically against a real AKSO file: legitimate junctions (e.g. a tee
// where three pipe items' nodes genuinely meet at one point) top out at 3
// distinct owners, while (0,0) - an unset/default coordinate - was shared by
// 13 unrelated shape-catalogue elements. 4 gives a small margin above the
// observed legitimate case without opening the door to that kind of
// placeholder-coordinate false-matching.
const COINCIDENT_NODE_MAX_OWNERS = 4;

// Groups every component's <ConnectionPoints><Node> by coordinate (same
// spatial-hash/tolerance approach as buildConnectionPointIndex() above, but
// keeping every distinct owner at a position rather than just the nearest
// one) and returns only the groups that look like a real physical touch: 2
// to COINCIDENT_NODE_MAX_OWNERS distinct component IDs sharing that exact
// position. A position with only one owner isn't a connection at all, and
// one shared by more than the cap is far more likely to be a placeholder/
// default coordinate (see COINCIDENT_NODE_MAX_OWNERS's doc comment) than a
// genuine junction - excluded rather than risk fabricating false
// connections between otherwise-unrelated components.
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

// Fallback max distance (drawing units) for matching a CenterLine endpoint to
// a same-segment PipeOffPageConnector - see readSegmentOffPageConnectors()'s
// doc comment. Empirically, real AKSO off-page-connector offsets are 0-24
// units (the connector's arrow/flag symbol is drawn a short distance from the
// true pipe end); 50 gives comfortable margin above that while still ruling
// out a segment somehow spanning most of a drawing.
const OFFPAGE_CONNECTOR_MATCH_MAX_DISTANCE = 50;

// PipeOffPageConnector elements never carry their own <ConnectionPoints> in
// real Proteus/Comos exports (confirmed empirically across AKSO files -
// every off-page connector has only a bare <Position>, no connection node),
// so buildConnectionPointIndex() above can never match them: a CenterLine
// that terminates at one is left with an unresolved end, and since rule 4
// below requires BOTH ends to resolve before recording anything, the
// segment's OTHER, perfectly valid endpoint match is silently dropped too.
// Reads a segment's own direct-child PipeOffPageConnector elements (id +
// Position) so an unresolved CenterLine end can be matched against them as a
// fallback - scoped to this one segment (rather than a document-wide looser
// tolerance) so there's no risk of false-matching some unrelated connector
// elsewhere in a large drawing.
function readSegmentOffPageConnectors(segEl) {
    return directChildrenByTag(segEl, "PipeOffPageConnector").map(opcEl => {
        const posEl = directChildrenByTag(opcEl, "Position")[0];
        const loc = posEl ? directChildrenByTag(posEl, "Location")[0] : null;
        const x = loc ? parseFloat(loc.getAttribute("X")) : NaN;
        const y = loc ? parseFloat(loc.getAttribute("Y")) : NaN;
        return { id: opcEl.getAttribute("ID"), x, y };
    }).filter(o => o.id && !Number.isNaN(o.x) && !Number.isNaN(o.y));
}

// Nearest-by-distance match within a (small, same-segment) candidate list,
// capped at OFFPAGE_CONNECTOR_MATCH_MAX_DISTANCE - used only as the fallback
// described above, never as a replacement for the exact ConnectionPoints
// match findOwner() already performs.
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

        // Segment/System containment - see the module doc comment above.
        // Every direct item of this segment (not just the first/last, which
        // the old upstream (Segment)/downstream (Segment) rule used to
        // record), plus - if the segment sits directly inside a
        // PipingNetworkSystem - every item's indirect membership in that
        // system too.
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

        // Rule 4: each direct CenterLine child links two real components, and
        // also becomes its own selectable sub-component of the segment (see
        // makeCenterLineNode()'s doc comment).
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
                    // Record whichever end(s) resolved independently, rather than
                    // requiring both - a CenterLine whose far end doesn't match any
                    // component (e.g. a short stub segment with no PipeOffPageConnector
                    // to fall back to) still has a perfectly good match at its OTHER
                    // end, and that shouldn't be thrown away. upstreamId/downstreamId
                    // feed makeCenterLineNode() below, which already independently
                    // records whichever of the two it's given. The two real components
                    // are only cross-linked to EACH OTHER (as one another's
                    // Upstream/Downstream Node) when BOTH ends resolve, since that
                    // link requires two distinct components to point at - a one-sided
                    // match has only the CenterLine's own node to hang the ref off of.
                    if (foundUp) upstreamId = foundUp;
                    if (foundDown) downstreamId = foundDown;
                    if (foundUp && foundDown && foundUp !== foundDown) {
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

    // Rule 5: direct coincident connection points (no CenterLine involved) -
    // see buildCoincidentNodeGroups()'s doc comment. Property name contains
    // "piping" so buildConnectivityMap()'s generic classifier (dexpiParser.js)
    // buckets it into the non-directional "group" set, same as it already
    // does for other non-directional Association types.
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

    // Signal association, reverse direction - see the module doc comment
    // above. "has logical start"/"has logical end" already exist as refs on
    // the InformationFlow element itself (added in buildTree()); this adds
    // the other side, onto the Source/Target component the association
    // actually points at.
    const REVERSE_SIGNAL_LABEL = { "has logical start": "is logical start of", "has logical end": "is logical end of" };
    qsa(mainDoc, "InformationFlow[ID]").forEach(ifEl => {
        const ifId = ifEl.getAttribute("ID");
        const ifNode = nodesById.get(ifId);

        directChildrenByTag(ifEl, "Association").forEach(a => {
            const reverseLabel = REVERSE_SIGNAL_LABEL[a.getAttribute("Type") || ""];
            if (!reverseLabel) return;
            const targetId = a.getAttribute("ItemID");
            const targetNode = targetId ? nodesById.get(targetId) : null;
            if (targetNode) targetNode.refs.push({ property: reverseLabel, objects: [ifId] });
        });

        // Rule 6 - InformationFlow CenterLine (position-based), deliberately
        // separate from the "has logical start"/"has logical end" Associations
        // handled just above: those reflect the file's DECLARED logical
        // endpoints, while this derives genuine x/y connectivity for the
        // wire's own drawn route, the same way rule 4 does for a piping
        // PipingNetworkSegment's CenterLine - matching the wire's first/last
        // Coordinate against real components' ConnectionPoints/Node positions
        // (via the same tolerance-based findOwner() index used by rule 4).
        // Both pieces of information are kept side by side rather than one
        // replacing the other, since a wire's declared logical endpoints and
        // where its drawn geometry physically lands do not always agree
        // (e.g. a redrawn/rerouted wire, or a logical Association pointing at
        // a loop/function element with no ConnectionPoints of its own to match).
        //
        // Refs are recorded both on the two matched end components (mirroring
        // rule 4 - so selecting either one shows the other as its
        // Upstream/Downstream Node, and the Connectivity highlight lights up
        // the physically-wired neighbour) AND on the InformationFlow element
        // itself, so selecting the wire (or clicking its drawn line, which
        // represents the InformationFlow - see buildProteusGraphics()'s
        // isSegmentCenterLine handling) shows its own Upstream/Downstream
        // Node too, e.g. XMP_4985's CenterLine showing a Downstream Node of
        // XMP_3121. This depends on buildConnectionPointIndex() excluding
        // InformationFlow-owned ConnectionPoints from findOwner() (see its
        // doc comment) - otherwise a wire's own connection points, sitting
        // at the exact same x/y as its own CenterLine ends, would self-match
        // and hide the real neighbouring component behind a self-reference.
        directChildrenByTag(ifEl, "CenterLine").forEach(clEl => {
            const coords = directChildrenByTag(clEl, "Coordinate");
            if (coords.length < 2) return;
            const first = coords[0], last = coords[coords.length - 1];
            const fx = parseFloat(first.getAttribute("X")), fy = parseFloat(first.getAttribute("Y"));
            const lx = parseFloat(last.getAttribute("X")), ly = parseFloat(last.getAttribute("Y"));
            if ([fx, fy, lx, ly].some(Number.isNaN)) return;
            const foundUp = findOwner(fx, fy);
            const foundDown = findOwner(lx, ly);
            // As with rule 4: record whichever end(s) resolved independently
            // rather than requiring both. The two real components are only
            // cross-linked to each other when BOTH ends resolve (that link
            // needs two distinct components to point at), but the
            // InformationFlow element itself - the wire's own node - gets
            // whichever of upstream/downstream it has, even if the other end
            // of the wire doesn't land on any component's connection point.
            if (foundUp && foundDown && foundUp !== foundDown) {
                const upNode = nodesById.get(foundUp);
                const downNode = nodesById.get(foundDown);
                if (upNode) upNode.refs.push({ property: "downstream (CenterLine)", objects: [foundDown] });
                if (downNode) downNode.refs.push({ property: "upstream (CenterLine)", objects: [foundUp] });
            }
            if (ifNode) {
                if (foundUp) ifNode.refs.push({ property: "upstream (CenterLine)", objects: [foundUp] });
                if (foundDown) ifNode.refs.push({ property: "downstream (CenterLine)", objects: [foundDown] });
            }
        });
    });
}

function buildTree(mainDoc, classIndex, dataPropIndex) {
    // InformationFlow[ID] is included even without a ComponentClass: some
    // real-world exports (AKSO/Comos) write instrument signal-line
    // InformationFlow elements with no ComponentClass attribute at all -
    // structurally invalid (rdlValidate.js's dedicated check flags this),
    // but the element still carries a real CenterLine and should still show
    // up as a tree node and get its line drawn, rather than silently
    // vanishing from the document entirely. Elements missing ComponentClass
    // resolve to a "Plant/Unmapped.<tagName>" type via resolveObjectClass()
    // below, same as any other unmapped element.
    const allEls = qsa(mainDoc, "[ID][ComponentClass], InformationFlow[ID]").filter(el => {
        if (el.tagName === "Label" || el.tagName === "MetaData") return false;
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
        const data = resolveObjectData(el, dataPropIndex);
        const tagName = (data.find(d => d.property === "DiscProfile/ItemTag") || {}).value || "";
        const displayName = (data.find(d => d.property === "DiscProfile/ObjectDisplayName") || {}).value || "";
        const persistentIdentifiers = directChildrenByTag(el, "PersistentID").map(p => ({
            context: p.getAttribute("Context") || "", value: p.getAttribute("Identifier") || "",
        }));
        // Signal/instrument wires (InformationFlow) use Association
        // Type="has logical start"/"has logical end" to mark their endpoints.
        // These are left as their raw Association Type strings (rather than
        // being renamed to "upstream (Signal)"/"downstream (Signal)") so
        // they're shown as their own dedicated category in the Connections
        // tab instead of being folded into the upstream/downstream buckets -
        // see the module doc comment above deriveProteusFlowConnectivity(),
        // which also adds the reverse-direction ref onto the referenced
        // Source/Target component.
        const refs = directChildrenByTag(el, "Association")
            .filter(a => {
                const t = a.getAttribute("Type") || "";
                return t !== "is a part of" && t !== "is a collection including";
            })
            .map(a => ({ property: a.getAttribute("Type") || "", objects: [a.getAttribute("ItemID")].filter(Boolean) }));
        const label = displayName || tagName || el.getAttribute("ComponentName") || id || type.split(".").pop();
        nodesById.set(id, {
            id, objectId: id, type, label, tagName, subTagName: "", loopNum: "",
            data, persistentIdentifiers, refs, children: [],
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

    // Rules 1/3/4: PipingNetworkSegment/System own upstream+downstream, and
    // CenterLine-derived component-to-component links (see the function's
    // doc comment above buildTree for the full rule breakdown).
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

    // PipingNetworkSegment/System sub-components should list in true file
    // order. Real item/segment children were just appended above in document
    // order (allEls is walked in document order, so pushes onto any one
    // parent's children stay relatively ordered) - but synthetic CenterLine
    // children were attached earlier, in deriveProteusFlowConnectivity(),
    // before this loop ran, so they'd otherwise all end up bunched before a
    // segment's real items instead of interleaved where they actually sit in
    // the XML. Re-sort each segment/system's children by their real position
    // among the owner element's direct children to fix that.
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
            tagName: "", subTagName: "", loopNum: "", data: [], persistentIdentifiers: [], refs: [],
            children: roots,
        };
    }

    return { tree: treeRoot, elementById, diagnostics: { totalObjects: allEls.length, classMatchedViaRule1: matchedRule1Count, rootObjectId: treeRoot.objectId } };
}

// ---------------------------------------------------------------------------
// Graphics construction: symbol placement, labels, pipe/instrument centerlines
// ---------------------------------------------------------------------------

// Selects a symbol's SymbolVariant for a placed Proteus object. The base
// (VariantNumber 0, unconditioned) variant is used unless one of the other
// variants' PropertyValueCondition is satisfied - i.e. the object carries a
// GenericAttribute for that condition's attribute whose Value matches the
// condition's target EnumerationLiteral short code (e.g.
// ValvePosition="NC" for a condition on ValvePosition.NormallyClose,
// resolved to "NC" by parseSymbolCatalogue()). Proteus GenericAttribute
// values are already written in this short-code form, so a direct string
// comparison is enough once the condition itself has been resolved.
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
// tokens inside a Profile/LabelTemplate's Text value - see
// resolveLabelTemplateText()'s doc comment below for the full token
// vocabulary this was derived from (surveyed across the loaded
// DiscProfile.xml's ~300 real LabelTemplate objects).
const LABEL_TEMPLATE_TOKEN_RE = /(?:([A-Za-z]\w*):)?<([^<>]+)>/g;

// Looks up one attribute's display value from a resolved data array (the
// same shape App.jsx's Data panel already renders - see
// resolveObjectData()) - i.e. matches on "DiscProfile/<name>" first (the
// resolved DEXPI property name, when the attribute's AttributeURI was
// resolvable against the loaded DiscProfile.xml) and falls back to
// "Proteus/<name>" (the raw GenericAttribute name, when it wasn't). Reduces
// the same value shapes App.jsx's formatDataValue() handles (PhysicalQuantity,
// DataReference, plain scalars) down to a plain display string, since a
// LabelTemplate's Text is always flat text - no units/enum badges here.
function lookupAttributeText(dataArr, attrName) {
    const found = (dataArr || []).find(d => d.property === `DiscProfile/${attrName}` || d.property === `Proteus/${attrName}`);
    if (!found || found.value === null || found.value === undefined) return "";
    const v = found.value;
    if (v && typeof v === "object" && v.kind === "PhysicalQuantity") return v.value !== null && v.value !== undefined ? String(v.value) : "";
    if (v && typeof v === "object" && v.kind === "DataReference") return v.value.split(".").pop().split("/").pop();
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
}

// Substitutes every "<AttributeName>" / "RelatedClass:<AttributeName>" token
// in a LabelTemplate's raw Text (see parseLabelTemplate() in dexpiParser.js)
// with the real value it stands for, preserving all literal text (including
// embedded newlines - see App.jsx's multi-line <tspan> handling in
// renderPrimitive()) around/between tokens unchanged.
//
// "<AttributeName>" resolves against the labeled object's own attribute
// data. "RelatedClass:<AttributeName>" (observed e.g. on alarm-setpoint
// labels: "SignalConveyingFunction:<AlarmValue>") resolves against a
// DIFFERENT object - one this element directly references via its own
// <Association> children whose target's ComponentClass matches RelatedClass
// - since the attribute in question (e.g. an alarm's AlarmValue) lives on
// that related object, not on the labeled element itself. If no such
// association/attribute can be resolved, the token is replaced with an
// empty string rather than left as raw "<...>" text, so a missing/optional
// attribute just quietly omits that part of the label instead of showing
// template syntax to the user.
function resolveLabelTemplateText(rawText, el, ownData, elementById, dataByObjectId) {
    if (!rawText) return "";
    return rawText.replace(LABEL_TEMPLATE_TOKEN_RE, (match, relatedClass, attrName) => {
        if (!relatedClass) return lookupAttributeText(ownData, attrName);
        const relatedId = directChildrenByTag(el, "Association")
            .map(a => a.getAttribute("ItemID"))
            .find(itemId => itemId && elementById.get(itemId)?.getAttribute("ComponentClass") === relatedClass);
        if (!relatedId) return "";
        return lookupAttributeText(dataByObjectId.get(relatedId), attrName);
    });
}

function buildProteusGraphics(elementById, symbolMap, shapeCatalogue, dataByObjectId) {
    const elements = [];

    elementById.forEach((el, id) => {
        const componentName = el.getAttribute("ComponentName");
        const pos = readPosition(el);
        let placedVariant = null; // captured for the label-template fallback below

        // Rule 2: shape placement
        if (componentName && pos) {
            const regNum = shapeCatalogue.get(componentName);
            const symbol = regNum ? symbolMap.get(`DiscProfile/${regNum}`) : null;
            if (symbol) {
                const variant = pickVariant(symbol, dataByObjectId.get(id));
                if (variant) {
                    placedVariant = variant;
                    const scale = readScale(el);
                    elements.push({
                        kind: "symbolUsage", key: `sym_${id}`, representedId: id, elementRole: "symbol",
                        symbol, variant, position: { x: pos.x, y: pos.y }, rotation: pos.rotation,
                        scaleX: scale.x, scaleY: scale.y, isMirrored: pos.isMirrored,
                    });
                }
            }
        }

        // Text labels
        const ownLabelEls = directChildrenByTag(el, "Label");
        ownLabelEls.forEach((labelEl, li) => {
            directChildrenByTag(labelEl, "Text").forEach((textEl, ti) => {
                const str = textEl.getAttribute("String");
                if (!str) return;
                const tPos = readPosition(textEl);
                const j = parseJustification(textEl.getAttribute("Justification"));
                elements.push({
                    kind: "primitive", key: `lbl_${id}_${li}_${ti}`, representedId: id, elementRole: "label",
                    primitive: {
                        kind: "text", key: `lbltxt_${id}_${li}_${ti}`,
                        position: tPos ? { x: tPos.x, y: tPos.y } : { x: 0, y: 0 },
                        value: str, rotation: tPos ? tPos.rotation : 0,
                        style: {
                            color: { r: 0, g: 0, b: 0 },
                            font: textEl.getAttribute("Font") || "Arial",
                            size: parseFloat(textEl.getAttribute("Height")) || 3.5,
                            horizontal: j.horizontal, vertical: j.vertical,
                        },
                    },
                });
            });
        });

        // Fallback: this element carries no <Label> XML elements of its own,
        // but the symbol variant just placed for it (Rule 2 above) may
        // define its own LabelTemplates in the loaded DiscProfile.xml (see
        // parseSymbolCatalogue()'s labelTemplates field in dexpiParser.js) -
        // real Proteus/Comos exports commonly omit per-instance <Label>
        // elements entirely and rely on the profile to define what a
        // symbol's label should show. A LabelTemplate's own Position/
        // Rotation are in the same symbol-local coordinate space as the
        // symbol's own primitives/bounds (both are Core/Diagram.Shape-
        // composed data - see Profile.xml's SymbolVariant class, which
        // composes MinX/MinY/MaxX/MaxY and LabelTemplates side by side), so
        // it's transformed through the exact same translate/rotate/scale/
        // mirror math as the symbol placement itself to get a world
        // position - consistent with "position relative to the symbol".
        // Text content comes from resolveLabelTemplateText() substituting
        // the template's <AttributeName> tokens against this object's own
        // resolved data.
        if (ownLabelEls.length === 0 && placedVariant && placedVariant.labelTemplates?.length) {
            const scale = readScale(el);
            const mirror = pos.isMirrored ? -1 : 1;
            const rad = pos.rotation * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const ownData = dataByObjectId.get(id) || [];
            placedVariant.labelTemplates.forEach((lt, li) => {
                const text = resolveLabelTemplateText(lt.text, el, ownData, elementById, dataByObjectId);
                if (!text.trim()) return;
                const lx = lt.position.x * scale.x * mirror;
                const ly = lt.position.y * scale.y;
                const wx = pos.x + (lx * cos - ly * sin);
                const wy = pos.y + (lx * sin + ly * cos);
                elements.push({
                    kind: "primitive", key: `lbltpl_${id}_${li}`, representedId: id, elementRole: "label",
                    primitive: {
                        kind: "text", key: `lbltpltxt_${id}_${li}`,
                        position: { x: wx, y: wy }, value: text, rotation: pos.rotation + lt.rotation,
                        style: {
                            color: lt.color,
                            font: lt.font, size: lt.size,
                            horizontal: lt.alignment.horizontal, vertical: lt.alignment.vertical,
                        },
                    },
                });
            });
        }

        // Pipe / instrument-loop centerlines (absolute coordinates, same
        // Y-up Proteus frame as <Location> - negate Y for the same reason).
        // A PipingNetworkSegment's own CenterLine children each get their own
        // selectable identity (matching the synthetic sub-component node
        // built in deriveProteusFlowConnectivity()), so clicking the drawn
        // line selects/highlights that specific CenterLine and shows its
        // rule-4 upstream/downstream in the Connections panel - rather than
        // selecting the whole segment. CenterLines owned by other element
        // types (e.g. InformationFlow signal wires, whose own upstream/
        // downstream already comes from rule 2) keep the prior behaviour of
        // representing their owner element.
        const isSegmentCenterLine = el.tagName === "PipingNetworkSegment";
        directChildrenByTag(el, "CenterLine").forEach((clEl, ci) => {
            const points = directChildrenByTag(clEl, "Coordinate").map(c => ({
                x: parseFloat(c.getAttribute("X")) || 0, y: -(parseFloat(c.getAttribute("Y")) || 0),
            }));
            if (points.length < 2) return;
            const representedId = isSegmentCenterLine ? resolveCenterLineId(clEl, id, ci) : id;
            elements.push({
                kind: "primitive", key: `cl_${id}_${ci}`, representedId, elementRole: "connector",
                primitive: { kind: "polyline", key: `clprim_${id}_${ci}`, points, stroke: { color: "#000000", width: 0.25, dashArray: "" } },
                // Bridges this polyline to its owning PipingNetworkSegment's own
                // id for heat-trace lookup purposes only (see App.jsx's heat-trace
                // overlay rendering) - the synthetic CenterLine tree node itself
                // (type "Plant/Segment.CenterLine") is never RDL-eligible for
                // HeatTracingType inheritance (see dexpiParser.js's
                // DEXPI_BUILTIN_HT_ELIGIBLE/buildHtEligibility()), so
                // heatTraceSet never has an entry keyed by the CenterLine's own
                // representedId even when its owning segment's heat tracing is
                // active - only set for a segment's own CenterLine children, not
                // e.g. an InformationFlow signal wire's CenterLine.
                htSegmentId: isSegmentCenterLine ? id : undefined,
            });
        });
    });

    return { elements, nodePosMap: new Map() };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function parseProteusPackage(mainXml, discProfileXml) {
    const parser = new DOMParser();
    const mainDoc = parser.parseFromString(mainXml, "application/xml");
    if (mainDoc.querySelector("parsererror")) throw new Error("Proteus XML is not well-formed.");
    if (!isProteusDoc(mainDoc)) throw new Error("File does not appear to be a Proteus / DEXPI 1.3 PlantModel document.");

    const discDoc = discProfileXml ? parser.parseFromString(discProfileXml, "application/xml") : null;
    if (discDoc && discDoc.querySelector("parsererror")) throw new Error("DiscProfile XML is not well-formed.");
    if (!discDoc) throw new Error("A DiscProfile.xml must be loaded to resolve DEXPI 2.x classes, attributes and symbols for a Proteus file.");

    const classIndex = buildClassRdlUriIndex(discDoc);
    const dataPropIndex = buildDataPropertyRdlUriIndex(discDoc);
    const proteusShapeCatalogue = buildProteusShapeCatalogue(mainDoc);
    const symbolMap = parseSymbolCatalogue(discDoc);

    const { tree, elementById, diagnostics } = buildTree(mainDoc, classIndex, dataPropIndex);
    const flatTree = flattenTree(tree);
    const treeMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    const dataByObjectId = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n.data]));

    const graphics = buildProteusGraphics(elementById, symbolMap, proteusShapeCatalogue, dataByObjectId);

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
