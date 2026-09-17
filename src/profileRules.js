// Profile-derived validation facts and the checks that depend on them.
//
// Reads facts from the loaded DiscProfile.xml: symbol names, the classes and
// properties DISC sanctions, the attributes a symbol's labels may name, and
// the superType families a Custom<X> wrapper may belong to. The profile
// structure stays fixed by Profile.xml while its content varies by release.
//
// Every finding produced here carries a `code` from issueCodes.js.
// buildProfileFacts() returns hasProfile so callers can report
// runsWhen:"profile" checks as not-evaluated when no profile is loaded.

import { qsa, directChildrenByTag, directComponentsObjects, parseSymbolCatalogue } from "./dexpiParser.js";
import { symbolLabelAttributeNames } from "./proteusParser.js";
import versionClasses from "./versionClasses.json";

// Proteus writes a symbol reference with a "_SHAPE" suffix while the profile
// declares the bare symbol name. Stripping the suffix is PRF-MAP-06.
const SYMBOL_NAME_SUFFIX = /_SHAPE$/;

/** Strips the "_SHAPE" suffix from a symbol name. Safe on an already-bare name. */
export function normalizeSymbolName(componentName) {
    return (componentName || "").trim().replace(SYMBOL_NAME_SUFFIX, "");
}

// Proteus writes GenericAttribute names with an AssignmentClass suffix that
// the information model does not use. A label's
// ObjectAttributesReference/@DependantAttribute carries the bare name.
// Normalizing both to the same form is MDL-PRP-06.
const ATTRIBUTE_NAME_SUFFIX = /AssignmentClass$/;

/** Strips the AssignmentClass suffix from an attribute name. Safe on an already-bare name. */
export function normalizeAttributeName(rawName) {
    return (rawName || "").trim().replace(ATTRIBUTE_NAME_SUFFIX, "");
}

function directDataStrings(node, property) {
    const out = [];
    directChildrenByTag(node, "Data")
        .filter(d => d.getAttribute("property") === property)
        .forEach(d => directChildrenByTag(d, "String").forEach(s => out.push((s.textContent || "").trim())));
    return out;
}

/**
 * Reads every fact the profile-dependent checks need, once per run.
 *
 * @param {Document|null} discDoc - the loaded DiscProfile.xml, or null
 * @returns {{
 *   hasProfile: boolean,
 *   allowedClasses: Set<string>,      // Profile/UsageConstraint AllowedClasses, bare class names
 *   allowedProperties: Set<string>,   // AllowedProperties, bare property names
 *   symbolNames: Set<string>,         // every Profile/Symbol in the catalogue, bare
 *   symbolLabelAttrs: Map<string,Set<string>>, // symbol -> attributes its LabelTemplates name
 *   superTypeFamilies: Set<string>,   // last segment of every superTypes entry in the profile
 * }}
 */
export function buildProfileFacts(discDoc) {
    const facts = {
        hasProfile: !!discDoc,
        allowedClasses: new Set(),
        allowedProperties: new Set(),
        symbolNames: new Set(),
        symbolLabelAttrs: new Map(),
        superTypeFamilies: new Set(),
    };
    if (!discDoc) return facts;

    // ---- Profile/UsageConstraint: what DISC sanctions -------------------
    // Reads AllowedClasses and AllowedProperties. Entries are fully-qualified;
    // the bare trailing name is also stored, since a ComponentClass and a
    // GenericAttribute name are bare names.
    qsa(discDoc, 'Object[type="Profile/UsageConstraint"]').forEach(obj => {
        directDataStrings(obj, "AllowedClasses").forEach(v => {
            facts.allowedClasses.add(v);
            facts.allowedClasses.add(v.split(".").pop());
        });
        directDataStrings(obj, "AllowedProperties").forEach(v => {
            facts.allowedProperties.add(v);
            facts.allowedProperties.add(v.split(".").pop());
        });
    });

    // ---- Symbol catalogue and the attributes each symbol's labels name ---
    const catalogue = parseSymbolCatalogue(discDoc);
    catalogue.forEach((symbol, key) => {
        const bare = key.replace(/^DiscProfile\//, "");
        facts.symbolNames.add(bare);
        const attrs = symbolLabelAttributeNames(symbol);
        if (attrs && attrs.size) facts.symbolLabelAttrs.set(bare, attrs);
    });

    // ---- superType families, for the Custom<X> bridge --------------------
    // Collects the superType families declared in the profile. A Custom<X>
    // wrapper is expected to resolve to a class whose superTypes include a
    // family ending in X.
    const walk = node => {
        Array.from(node.children || []).forEach(child => {
            if (child.tagName === "ConcreteClass" || child.tagName === "AbstractClass") {
                (child.getAttribute("superTypes") || "").split(/\s+/).filter(Boolean)
                    .forEach(st => facts.superTypeFamilies.add(st.split(".").pop()));
            }
            walk(child);
        });
    };
    walk(discDoc.documentElement);

    return facts;
}

/**
 * The superType family a Custom<X> ComponentClass is expected to resolve
 * into, or null when the profile has no such family.
 *
 * Returning null means the caller should emit nothing rather than a finding.
 *
 * @param {string} componentClass a Custom<X> class name
 * @param {ReturnType<typeof buildProfileFacts>} facts
 * @param {Map<string,string>} versionRenames 1.4 -> 2.0 class renames
 */
export function expectedCustomFamily(componentClass, facts, versionRenames) {
    if (!componentClass.startsWith("Custom") || componentClass.length <= "Custom".length) return null;
    const x = componentClass.slice("Custom".length);
    if (facts.superTypeFamilies.has(x)) return x;
    // The wrapper may name a class the profile knows under its 2.0 name.
    const renamed = versionRenames?.get(x);
    if (renamed && facts.superTypeFamilies.has(renamed)) return renamed;
    return null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * PRF-SCP-01 / PRF-SCP-02 - checks whether the class, and each DEXPI-modeled
 * attribute, is in the set the DISC profile sanctions.
 */
export function checkDiscScope(els, facts, dexpiAttributeSets) {
    const findings = [];
    if (!facts.hasProfile || !facts.allowedClasses.size) return findings;
    els.forEach(({ el, objectId, componentClass }) => {
        // A Custom<X> wrapper is a Proteus construct; the profile's
        // AllowedClasses list names 2.0 classes. A Custom<X> wrapper is
        // excluded here and reported as not-evaluated for PRF-SCP-01 until it
        // is resolved through its type URI.
        const isCustomWrapper = componentClass.startsWith("Custom") && componentClass.length > "Custom".length;
        if (componentClass && !isCustomWrapper && !facts.allowedClasses.has(componentClass)) {
            findings.push({
                code: "PRF-SCP-01", severity: "warning", objectId, componentClass,
                message: `Class "${componentClass}" is not in the DISC profile's AllowedClasses list.`,
            });
        }
        if (!facts.allowedProperties.size) return;
        directChildrenByTag(el, "GenericAttributes").forEach(group => {
            // Only DEXPI-modeled attribute groups are in DISC scope; vendor
            // attribute groups are excluded from this check.
            if (dexpiAttributeSets && !dexpiAttributeSets.has(group.getAttribute("Set") || "")) return;
            directChildrenByTag(group, "GenericAttribute").forEach(ga => {
                const bare = normalizeAttributeName(ga.getAttribute("Name") || "");
                if (!bare || facts.allowedProperties.has(bare)) return;
                findings.push({
                    code: "PRF-SCP-02", severity: "warning", objectId, componentClass,
                    message: `Property "${bare}" is not in the DISC profile's AllowedProperties list.`,
                });
            });
        });
    });
    return findings;
}

/**
 * PRF-SYM-01 - a symbol reference that resolves to nothing.
 *
 * Resolution path:
 *
 *   drawn element @ComponentName
 *     -> the file's own ShapeCatalogue entry of that ComponentName
 *       -> that entry's SymbolRegistrationNumber
 *         -> the profile's symbol catalogue
 *
 * A ComponentName is a local catalogue name, not a DISC symbol id.
 *
 * Three outcomes:
 *   - no ComponentName: nothing is referenced, nothing to report.
 *   - the reference resolves, directly or through the registration number: fine.
 *   - the reference resolves nowhere: PRF-SYM-01.
 *
 * @param {Map<string,string>} registrationIndex ComponentName -> SymbolRegistrationNumber
 */
export function checkSymbolCatalogue(els, facts, registrationIndex) {
    const findings = [];
    if (!facts.hasProfile || !facts.symbolNames.size) return findings;
    els.forEach(({ el, objectId, componentClass }) => {
        const raw = el.getAttribute("ComponentName") || "";
        if (!raw) return;                       // no ComponentName reference
        const bare = normalizeSymbolName(raw);
        if (!bare) return;
        if (facts.symbolNames.has(bare)) return;            // names the profile symbol directly

        const registered = registrationIndex ? registrationIndex.get(raw) : null;
        if (registered && facts.symbolNames.has(normalizeSymbolName(registered))) return;

        findings.push({
            code: "PRF-SYM-01", severity: "warning", objectId, componentClass,
            message: registered
                ? `ComponentName "${raw}" registers symbol "${registered}", which the loaded DiscProfile.xml does not declare. No symbol can be drawn for it.`
                : `ComponentName "${raw}" is not declared by the file's ShapeCatalogue and is not a profile symbol, so it resolves to nothing. No symbol can be drawn for it.`,
        });
    });
    return findings;
}

// A symbol's label templates name the attributes a label draws from. This is
// a placement rule, not a requirement.
//
// PRF-LBL-01 checks that a label present on an object references an
// attribute the symbol permits; it lives in the label checks, not here.


// ---------------------------------------------------------------------------
// Geometry - evaluable from the Proteus file, with the grid unit taken from
// the profile where it states one.
// ---------------------------------------------------------------------------

/** Default DISC grid unit. Overridden by the profile when it declares one. */
const DEFAULT_GRID_UNIT = 1;

export function profileGridUnit(discDoc) {
    if (!discDoc) return DEFAULT_GRID_UNIT;
    const stated = qsa(discDoc, 'Object[type="Profile/Grid"]')
        .map(o => parseFloat(directDataStrings(o, "Unit")[0]))
        .find(v => Number.isFinite(v) && v > 0);
    return stated || DEFAULT_GRID_UNIT;
}

/**
 * Does the file claim the DISC profile, independent of whether a profile was
 * loaded for this run.
 *
 * When a profile is loaded, membership in its symbol catalogue decides.
 * Otherwise, falls back to the markers a DISC export leaves in the Proteus
 * serialization.
 *
 * @returns {{claims: boolean, evidence: string[]}}
 */
export function detectDiscClaim(mainDoc, facts) {
    const evidence = [];
    const names = qsa(mainDoc, "[ComponentName]")
        .map(el => normalizeSymbolName(el.getAttribute("ComponentName") || ""))
        .filter(Boolean);

    // Strongest signal: the file places symbols the loaded profile declares.
    if (facts && facts.hasProfile && facts.symbolNames && facts.symbolNames.size) {
        const hits = names.filter(n => facts.symbolNames.has(n)).length;
        if (hits > 0) evidence.push(`${hits} symbol name(s) found in the loaded profile catalogue`);
    }

    // Fallbacks, usable with no profile loaded.
    const nd = names.filter(n => /^ND\d{4}[A-Z]?$/.test(n)).length;
    if (nd > 0) evidence.push(`${nd} DISC symbol id(s) of the form ND####`);

    const srn = qsa(mainDoc, "GenericAttribute")
        .filter(a => (a.getAttribute("Name") || "").startsWith("SymbolRegistrationNumber")).length;
    if (srn > 0) evidence.push(`${srn} SymbolRegistrationNumber attribute(s)`);

    const noaka = qsa(mainDoc, "[URI]")
        .filter(e => /noaka\.org|disc/i.test(e.getAttribute("URI") || "")).length;
    if (noaka > 0) evidence.push(`${noaka} DISC/NOAKA RDL reference(s)`);

    return { claims: evidence.length > 0, evidence };
}

const onGrid = (v, unit) => Number.isFinite(v) && Math.abs(v / unit - Math.round(v / unit)) < 1e-9;

/**
 * GEO-GRD-01 / 02 - symbol placements and node positions must sit on the
 * grid.
 *
 * Piping and instrumentation nodes share GEO-GRD-02; the node kind is
 * included in the message.
 *
 * Not run without a profile.
 */
export function checkGridAlignment(mainDoc, discDoc, elementLookup) {
    const findings = [];
    if (!discDoc) return findings;
    const unit = profileGridUnit(discDoc);

    const report = (code, loc, owner, what) => {
        const x = parseFloat(loc.getAttribute("X"));
        const y = parseFloat(loc.getAttribute("Y"));
        if (onGrid(x, unit) && onGrid(y, unit)) return;
        findings.push({
            code, severity: "warning",
            objectId: owner?.objectId || "", componentClass: owner?.componentClass || "",
            message: `(${x}, ${y}) is not on the ${unit}-unit diagram grid and is therefore not a valid ${what}.`,
        });
    };

    // A placed symbol: the object's own Position/Location.
    qsa(mainDoc, "[ComponentName]").forEach(el => {
        const pos = directChildrenByTag(el, "Position")[0];
        const loc = pos ? directChildrenByTag(pos, "Location")[0] : null;
        if (loc) report("GEO-GRD-01", loc, elementLookup(el), "SymbolUsage position");
    });

    // Connection-point nodes, split by the kind of object that owns them.
    qsa(mainDoc, "ConnectionPoints").forEach(cp => {
        const owner = elementLookup(cp.parentNode);
        const cls = owner?.componentClass || "";
        const kind = /Instrument|Signal|Process(Instrumentation|Signal)/.test(cls)
            ? "InstrumentationNodePosition" : "PipingNodePosition";
        directChildrenByTag(cp, "Node").forEach(node => {
            const pos = directChildrenByTag(node, "Position")[0];
            const loc = pos ? directChildrenByTag(pos, "Location")[0] : null;
            if (loc) report("GEO-GRD-02", loc, owner, kind);
        });
    });

    return findings;
}

/**
 * SER-FMT-04 - checks whether PlantInformation/@ApplicationVersion agrees
 * with the classes the file actually uses, via membership in the set of
 * classes unique to each version.
 */
export function checkDeclaredVersion(mainDoc) {
    const findings = [];
    const info = qsa(mainDoc, "PlantInformation")[0];
    if (!info) return findings;
    const declared = (info.getAttribute("ApplicationVersion") || "").trim();
    const used = new Set(qsa(mainDoc, "[ComponentClass]").map(el => el.getAttribute("ComponentClass")));

    const hits = v => versionClasses[v].filter(c => used.has(c));
    const only131 = hits("only_1_3_1");
    const only14 = hits("only_1_4");
    const describe = list => list.slice(0, 6).join(", ") + (list.length > 6 ? `, +${list.length - 6} more` : "");

    if (only131.length && only14.length) {
        findings.push({
            code: "SER-FMT-04", severity: "warning", objectId: "", componentClass: "",
            message: `File declares ApplicationVersion="${declared}" but mixes both information models: `
                + `1.3.1-only ${describe(only131)}; 1.4-only ${describe(only14)}.`,
        });
        return findings;
    }
    if (declared.startsWith("1.3") && only14.length) {
        findings.push({
            code: "SER-FMT-04", severity: "warning", objectId: "", componentClass: "",
            message: `File declares ApplicationVersion="${declared}" but uses ${only14.length} class(es) that exist only in 1.4: ${describe(only14)}.`,
        });
    } else if (declared.startsWith("1.4") && only131.length) {
        findings.push({
            code: "SER-FMT-04", severity: "warning", objectId: "", componentClass: "",
            message: `File declares ApplicationVersion="${declared}" but uses ${only131.length} class(es) dropped after 1.3.1: ${describe(only131)}.`,
        });
    }
    return findings;
}

/**
 * GEO-ALN-02 - a connector whose two ends resolve to the same point has zero
 * length.
 */
export function checkZeroLengthConnectors(mainDoc, elementLookup) {
    const findings = [];
    qsa(mainDoc, "CenterLine").forEach(cl => {
        const coords = directChildrenByTag(cl, "Coordinate");
        if (coords.length < 2) return;
        const pt = c => `${c.getAttribute("X")},${c.getAttribute("Y")}`;
        if (new Set(coords.map(pt)).size > 1) return;
        const owner = elementLookup(cl.parentNode);
        findings.push({
            code: "GEO-ALN-02", severity: "warning",
            objectId: owner?.objectId || cl.getAttribute("ID") || "",
            componentClass: owner?.componentClass || "",
            message: `CenterLine has ${coords.length} coordinates that are all at (${pt(coords[0])}) - the line has zero length.`,
        });
    });
    return findings;
}

/**
 * GEO-ALN-01 - the items of a PipingNetworkSegment must form one continuous
 * run, and its ends must sit on the nodes named by the segment's Connection.
 * CenterLines contribute their first/last Coordinate, components their
 * ConnectionPoints nodes; items with neither are skipped.
 */
const SEGMENT_MATCH_TOLERANCE = 0.01;

function readLocation(el) {
    const pos = directChildrenByTag(el, "Position")[0];
    const loc = pos ? directChildrenByTag(pos, "Location")[0] : null;
    if (!loc) return null;
    const x = parseFloat(loc.getAttribute("X")), y = parseFloat(loc.getAttribute("Y"));
    return Number.isNaN(x) || Number.isNaN(y) ? null : { x, y };
}

function nodePoints(el) {
    const cp = directChildrenByTag(el, "ConnectionPoints")[0];
    return cp ? directChildrenByTag(cp, "Node").map(readLocation) : [];
}

export function checkSegmentContinuity(mainDoc, elementLookup) {
    const findings = [];
    const near = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= SEGMENT_MATCH_TOLERANCE;
    const fmt = p => `(${+p.x.toFixed(3)}, ${+p.y.toFixed(3)})`;
    const byId = new Map(qsa(mainDoc, "[ID]").map(e => [e.getAttribute("ID"), e]));

    qsa(mainDoc, "PipingNetworkSegment").forEach(seg => {
        const segId = seg.getAttribute("ID") || "";
        const owner = elementLookup(seg);
        const report = message => findings.push({
            code: "GEO-ALN-01", severity: "warning",
            objectId: owner?.objectId || segId, componentClass: owner?.componentClass || "",
            message,
        });

        let clCount = 0;
        const items = [];
        Array.from(seg.children).forEach(c => {
            if (c.tagName === "CenterLine") {
                clCount++;
                const pts = directChildrenByTag(c, "Coordinate")
                    .map(k => ({ x: parseFloat(k.getAttribute("X")), y: parseFloat(k.getAttribute("Y")) }))
                    .filter(p => !Number.isNaN(p.x) && !Number.isNaN(p.y));
                if (pts.length >= 2) items.push({ name: c.getAttribute("ID") || `CenterLine ${clCount}`, pts: [pts[0], pts[pts.length - 1]] });
            } else if (c.getAttribute("ID")) {
                const pts = nodePoints(c).filter(Boolean);
                if (pts.length) items.push({ name: c.getAttribute("ID"), pts });
            }
        });
        if (!items.length) return;

        // Continuity: group items whose end points touch (union-find).
        const parent = items.map((_, i) => i);
        const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (let i = 0; i < items.length; i++)
            for (let j = i + 1; j < items.length; j++)
                if (items[i].pts.some(p => items[j].pts.some(q => near(p, q)))) parent[find(i)] = find(j);
        const runs = new Map();
        items.forEach((it, i) => {
            const r = find(i);
            if (!runs.has(r)) runs.set(r, []);
            runs.get(r).push(it.name);
        });
        if (runs.size > 1) {
            const list = [...runs.values()].map((r, i) => `run ${i + 1}: ${r.join(", ")}`).join("; ");
            report(`Segment items are not all connected - ${runs.size} separate runs (${list}).`);
        }

        // Ends: the Connection's From/To nodes must touch an item of the segment.
        const conn = directChildrenByTag(seg, "Connection")[0];
        if (!conn) return;
        [["From", "start"], ["To", "end"]].forEach(([side, word]) => {
            const targetId = conn.getAttribute(`${side}ID`);
            if (!targetId) return;
            const target = byId.get(targetId);
            if (!target || target.tagName === "PipingNetworkSegment") return;
            const nodes = nodePoints(target);
            const idx = parseInt(conn.getAttribute(`${side}Node`) || "", 10);
            const p = Number.isInteger(idx) ? nodes[idx] : null; // Proteus node index is 0-based, DefaultNode first
            if (!p) return;
            if (items.some(it => it.pts.some(q => near(p, q)))) return;
            let best = null, bestD = Infinity;
            items.forEach(it => it.pts.forEach(q => {
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (d < bestD) { bestD = d; best = q; }
            }));
            report(`Segment ${word} does not meet ${targetId} node ${idx} at ${fmt(p)}; nearest segment point is ${fmt(best)}, ${+bestD.toFixed(3)} away.`);
        });
    });
    return findings;
}
