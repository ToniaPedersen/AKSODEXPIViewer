// Validates a parsed Proteus / DEXPI 1.4 document against the DEXPI 1.4
// information model in dexpi14Rdl.json.
//
// Unlike xsdValidate.js's structural checks, this cross-references
// ComponentClass names and GenericAttribute names against the RDL: unknown
// classes, attribute names not on the object's class or its ancestors, enum
// values outside the allowed literal set, and attribute counts outside the
// declared cardinality.
//
// Attributes outside the core DEXPI 1.4 model are not flagged as errors; see
// the AttributeURI namespace check below.
import rdl from "./dexpi14Rdl.json";
import { ISSUE_CODES, PROFILE_CODES, DISC_SCOPED_CODES, UNION_MODEL_CODES, ALL_CODES, UNIMPLEMENTED_CODES, codeState } from "./issueCodes.js";
import {
    buildProfileFacts, expectedCustomFamily, normalizeSymbolName,
    checkDiscScope, checkSymbolCatalogue,
    checkGridAlignment, checkDeclaredVersion, checkZeroLengthConnectors, checkSegmentContinuity,
    detectDiscClaim, isDexpi1x,
} from "./profileRules.js";
import { qsa, directChildrenByTag, parseEnumLiteralSymbols, parseSymbolCatalogue } from "./dexpiParser.js";
import {
    buildProfileClassSuperTypeIndex, buildSymbolUsageIndex, SIGNAL_FLOW_COMPONENT_CLASSES,
    symbolLabelAttributeNames, readTextTemplateDependantAttributes, isValidTextTemplateAttribute,
} from "./proteusParser.js";

const RDL_NAMESPACE = rdl.namespace || "http://www.dexpi.org#";
// Namespaces treated as belonging to the DEXPI 1.4 model for
// AttributeURI-based attribute resolution: the formal RDL namespace and the
// sandbox namespace real exports use for DEXPI-modeled attributes.
const DEXPI_ATTRIBUTE_URI_NAMESPACES = [RDL_NAMESPACE, "http://sandbox.dexpi.org/rdl/"];

// "Custom<X>" ComponentClass check: evaluated against the loaded
// DiscProfile.xml via buildProfileClassSuperTypeIndex(), not against the
// static dexpi14Rdl.json.
const DEXPI_ATTRIBUTE_SETS = new Set(["DexpiAttributes", "DexpiCustomAttributes"]);

const CUSTOM_CLASS_PREFIX = "Custom";

// Custom<X> -> superType family mapping is read from the loaded profile via
// expectedCustomFamily(), not from a static table.
//
// VERSION_RENAMES covers the two class names that changed between DEXPI 1.4
// and the 2.0 model the DISC profile is written against.
const VERSION_RENAMES = new Map([
    ["Equipment", "ProcessEquipment"],
    ["DexpiModel", "PlantModel"],
]);

// ---- ComponentClass-vs-TypeURIAssignmentClass mismatch (unified) ----------
//
// A DEXPI 1.4 type (TypeNameAssignmentClass / TypeURIAssignmentClass) is the
// equivalent of a DEXPI 2.0 profile class extension: TypeURIAssignmentClass
// must resolve to a DiscProfile.xml class, and that class's superType must
// match the element's ComponentClass: its superType family (from
// expectedCustomFamily()) must match the "<X>" of Custom<X>.
// Checked only for CustomObject subtypes (customTypeUri()); an unresolvable
// TypeURIAssignmentClass is reported as MDL-CLS-01.
function lastSegment(name) {
    return name.split(/[./]/).pop();
}

// All superTypes of a profile class, following superTypes that name another
// profile class (e.g. AreaBreak -> /InformationModel.LogicalBreak ->
// Core/ConceptualObject).
function profileSuperTypeChain(resolved, profileClassIndex) {
    const byName = new Map();
    profileClassIndex.forEach(info => byName.set(info.name, info));
    const out = [], seen = new Set();
    const walk = info => (info.superTypes || []).forEach(st => {
        if (seen.has(st)) return;
        seen.add(st);
        out.push(st);
        const next = byName.get(lastSegment(st));
        if (next && next !== info) walk(next);
    });
    walk(resolved);
    return out;
}

function describeComponentClassTypeUriMismatch(el, componentClass, profileClassIndex, profileFacts) {
    const typeUri = customTypeUri(el);
    if (!typeUri || !componentClass) return { applicable: false, reason: null };
    const resolved = profileClassIndex.get(typeUri);
    if (!resolved) return { applicable: false, reason: null };
    const chain = profileSuperTypeChain(resolved, profileClassIndex);

    const actualDesc = resolved.superTypes.length ? resolved.superTypes.join(", ") : "(no superTypes declared)";
    const superTypeWord = `superType${resolved.superTypes.length === 1 ? " is" : "s are"}`;

    const expectedSuffix = expectedCustomFamily(componentClass, profileFacts, VERSION_RENAMES);
    if (!expectedSuffix) return { applicable: false, reason: null };
    if (chain.some(st => lastSegment(st) === expectedSuffix)) return { applicable: true, reason: null };
    return {
        applicable: true,
        reason: `TypeURIAssignmentClass "${typeUri}" resolves to profile class "${resolved.name}", whose ${superTypeWord} ${actualDesc} - expected a superType ending in "${expectedSuffix}"`,
    };
}

// Type-assignment GenericAttributes: the DEXPI 1.4 form of a profile class
// extension (CustomObject.TypeName / .TypeURI). Allowed only on CustomObject
// subtypes; on any other class PRF-SCP-02 reports them, so the model
// attribute check skips them.
const TYPE_ASSIGNMENT_ATTRS = new Set(["TypeNameAssignmentClass", "TypeURIAssignmentClass"]);
const CUSTOM_OBJECT_CLASS = "CustomObject";

function isCustomObjectSubtype(className) {
    return !!className && classDescendsFrom(className, CUSTOM_OBJECT_CLASS);
}

// TypeURIAssignmentClass, only when the element is a CustomObject subtype -
// the type URI is matched against the profile class extensions for those
// alone.
function customTypeUri(el) {
    return isCustomObjectSubtype(el.getAttribute("ComponentClass") || "") ? findTypeUriAssignmentValue(el) : null;
}

// Required GenericAttribute names for a Custom<X> element:
// TypeNameAssignmentClass and TypeURIAssignmentClass, both within a
// GenericAttributes Set="DexpiAttributes" block.
const CUSTOM_CLASS_REQUIRED_ATTRS = ["TypeNameAssignmentClass", "TypeURIAssignmentClass"];
const CUSTOM_CLASS_ATTR_SET = "DexpiAttributes";

// Finds a GenericAttribute by Name within GenericAttributes groups matching
// a specific Set value.
function findAttributeInSet(el, setName, attrName) {
    return directChildrenByTag(el, "GenericAttributes")
        .filter(g => g.getAttribute("Set") === setName)
        .flatMap(g => directChildrenByTag(g, "GenericAttribute"))
        .find(ga => ga.getAttribute("Name") === attrName) || null;
}

// Looks up TypeURIAssignmentClass within DEXPI_ATTRIBUTE_SETS groups only.
function findTypeUriAssignmentValue(el) {
    for (const group of directChildrenByTag(el, "GenericAttributes")) {
        if (!DEXPI_ATTRIBUTE_SETS.has(group.getAttribute("Set") || "")) continue;
        for (const ga of directChildrenByTag(group, "GenericAttribute")) {
            if (ga.getAttribute("Name") === "TypeURIAssignmentClass") return ga.getAttribute("Value");
        }
    }
    return null;
}

// ---- Abstract-class-used checks -------------------------------------------
//
// Abstract classes are organizational supertypes; a real object should
// resolve to a Concrete leaf class. Two independent checks:
//  1. "abstract-class-used" - the class resolved via TypeURIAssignmentClass
//     (falling back to ComponentClassURI) is looked up in the loaded
//     DiscProfile.xml's class index and flagged if tagged AbstractClass.
//     Only runs once a DiscProfile.xml is loaded.
//  2. "abstract-componentclass-used" - the object's raw ComponentClass
//     attribute is checked against the static dexpi14Rdl.json class list's
//     `kind` field.
// Both can independently fire on the same object.
function findResolvedRdlUriForAbstractCheck(el) {
    const typeUri = customTypeUri(el);
    if (typeUri) return typeUri;
    return el.getAttribute("ComponentClassURI") || null;
}

// Strips the "AssignmentClass"/"Specialization" GenericAttribute/@Name
// suffix to recover the bare RDL property name.
function stripNameSuffix(name) {
    for (const suf of ["AssignmentClass", "Specialization"]) {
        if (name.endsWith(suf)) return name.slice(0, -suf.length);
    }
    return name;
}

// True if the name has leading/trailing whitespace (including non-breaking)
// or doubled internal spaces.
function nameLooksMalformed(rawName) {
    if (rawName !== rawName.trim()) return true;
    if (/\s{2,}/.test(rawName)) return true;
    // Non-breaking space (U+00A0), zero-width space, and BOM (U+200B, U+FEFF).
    if (/[\u00A0\u200B\uFEFF]/.test(rawName)) return true;
    return false;
}

// Recursively resolves every property a class owns, including inherited
// ones from its superType chain. Memoized.
const inheritedCache = new Map();
function resolveInheritedProperties(className) {
    if (inheritedCache.has(className)) return inheritedCache.get(className);
    const result = new Map(); // shortPropName -> { owner, full, ...propInfo }
    const visited = new Set();
    function walk(cls) {
        if (!cls || visited.has(cls)) return;
        visited.add(cls);
        const info = rdl.classes[cls];
        if (!info) return;
        (info.ownedProperties || []).forEach(full => {
            const dot = full.indexOf(".");
            const short = dot === -1 ? full : full.slice(dot + 1);
            if (!result.has(short)) {
                const propInfo = rdl.properties[full] || {};
                result.set(short, { owner: cls, full, ...propInfo });
            }
        });
        (info.superTypes || []).forEach(walk);
    }
    walk(className);
    inheritedCache.set(className, result);
    return result;
}

// Builds { literalName -> shortCode } for every enum literal in the loaded
// DiscProfile.xml. GenericAttribute Values may use either the short-code
// form or the literal's bare name, so both are accepted.
function buildEnumValueLookup(discDoc) {
    const symbolByLiteral = parseEnumLiteralSymbols(discDoc); // literalName -> symbol
    const acceptedByEnum = new Map(); // enumName -> Set of accepted raw Value strings
    Object.entries(rdl.enums).forEach(([enumName, literals]) => {
        const accepted = new Set();
        literals.forEach(lit => {
            accepted.add(lit);
            const sym = symbolByLiteral.get(lit);
            if (sym) accepted.add(sym);
        });
        acceptedByEnum.set(enumName, accepted);
    });
    return acceptedByEnum;
}


// Same [ID][ComponentClass] filter proteusParser.js's buildTree() uses.
function collectValidatableElements(mainDoc) {
    return qsa(mainDoc, "[ID][ComponentClass]").filter(el => {
        if (el.tagName === "Label" || el.tagName === "MetaData") return false;
        if (el.closest && el.closest("ShapeCatalogue")) return false;
        return true;
    });
}

// InformationFlow[ID] regardless of ComponentClass presence, to also catch
// InformationFlow elements missing a ComponentClass.
function collectInformationFlowElements(mainDoc) {
    return qsa(mainDoc, "InformationFlow[ID]");
}

// ---- SignalConveyingFunction Source/Target endpoint-type check -----------
//
// SignalConveyingFunction.Source and .Target are typed against two abstract
// RDL role classes, "SignalConveyingFunctionSource" and
// "SignalConveyingFunctionTarget" - only classes descending from one of
// these may appear as a signal wire's Source/Target. The allowed sets are
// derived from dexpi14Rdl.json's class hierarchy at load time.
//
// In the Proteus XML, Source/Target are carried by the InformationFlow's own
// Association Type="has logical start" (-> Source) / Type="has logical end"
// (-> Target) elements, whose ItemID points at the referenced object. Both
// properties are optional (cardinality 0..1); a missing association is not
// an error, only a present one referencing the wrong ComponentClass is.
const SIGNAL_SOURCE_ROLE = "SignalConveyingFunctionSource";
const SIGNAL_TARGET_ROLE = "SignalConveyingFunctionTarget";

const descendsFromCache = new Map(); // "className::ancestorName" -> boolean
function classDescendsFrom(className, ancestorName) {
    const key = `${className}::${ancestorName}`;
    if (descendsFromCache.has(key)) return descendsFromCache.get(key);
    const visited = new Set();
    function walk(cls) {
        if (!cls || visited.has(cls)) return false;
        visited.add(cls);
        if (cls === ancestorName) return true;
        const info = rdl.classes[cls];
        if (!info) return false;
        return (info.superTypes || []).some(walk);
    }
    const result = walk(className);
    descendsFromCache.set(key, result);
    return result;
}

// Index of every [ID] element in the document, for resolving an
// Association's ItemID to the object it references.
function buildElementByIdIndex(mainDoc) {
    const map = new Map();
    qsa(mainDoc, "[ID]").forEach(el => {
        const id = el.getAttribute("ID");
        if (id && !map.has(id)) map.set(id, el);
    });
    return map;
}

// Symbol registration-number lookup: a ComponentName's registration number
// is carried by a GenericAttribute
// Name="SymbolRegistrationNumberAssignmentClass" on the Shape element
// sharing that ComponentName, inside a GenericAttributes
// Set="DexpiAttributes" block. Resolved via the attribute's AttributeURI
// rather than its Name.
const SYMBOL_REGISTRATION_URI = "http://sandbox.dexpi.org/rdl/SymbolRegistrationNumberAssignmentClass";

function buildSymbolRegistrationIndex(mainDoc) {
    const map = new Map(); // ComponentName -> registration number
    qsa(mainDoc, "[ComponentName]").forEach(el => {
        const componentName = el.getAttribute("ComponentName");
        if (!componentName || map.has(componentName)) return;
        const attr = directChildrenByTag(el, "GenericAttributes")
            .filter(g => DEXPI_ATTRIBUTE_SETS.has(g.getAttribute("Set") || ""))
            .flatMap(g => directChildrenByTag(g, "GenericAttribute"))
            .find(ga => ga.getAttribute("AttributeURI") === SYMBOL_REGISTRATION_URI);
        const value = attr ? attr.getAttribute("Value") : null;
        if (value) map.set(componentName, value);
    });
    return map;
}

// ---- ProcessInstrumentationFunction Source/Target coverage check ---------
//
// Every ProcessInstrumentationFunction (or subtype) is expected to
// participate as some InformationFlow's Source or Target.
const PROCESS_INSTRUMENTATION_ROLE = "ProcessInstrumentationFunction";

// A subset of PIF symbols additionally require
// ProcessInstrumentationFunctionLocationAssignmentClass and
// ProcessInstrumentationFunctionTypeAssignmentClass, both inside a
// GenericAttributes Set="DexpiCustomAttributes" block. The symbol is
// resolved via buildSymbolRegistrationIndex() above.
const PIF_SYMBOL_ATTR_SET = "DexpiCustomAttributes";
const PIF_LOCATION_ATTR = "ProcessInstrumentationFunctionLocationAssignmentClass";
const PIF_TYPE_ATTR = "ProcessInstrumentationFunctionTypeAssignmentClass";

// Every ItemID referenced by an InformationFlow's "has logical start"/"has
// logical end" Association across the whole document - i.e. every object
// used as some signal wire's Source or Target.
function collectSignalEndpointReferencedIds(mainDoc) {
    const ids = new Set();
    collectInformationFlowElements(mainDoc).forEach(el => {
        directChildrenByTag(el, "Association").forEach(a => {
            const t = a.getAttribute("Type") || "";
            if (t !== "has logical start" && t !== "has logical end") return;
            const itemId = a.getAttribute("ItemID");
            if (itemId) ids.add(itemId);
        });
    });
    return ids;
}

// ---- PipingNodeOwner coverage checks --------------------------------------
//
// PipingNodeOwner.Nodes (RDL) -> PipingNode: represented in Proteus XML by a
// component's own <ConnectionPoints><Node>...</Node></ConnectionPoints>
// children.
const PIPING_NODE_OWNER_ROLE = "PipingNodeOwner";

function elementHasPipingNode(el) {
    return directChildrenByTag(el, "ConnectionPoints").some(cp => directChildrenByTag(cp, "Node").length > 0);
}

// ---- TransmissionSystem sub-model check -----------------------------------
//
// A mechanical drive train between two pieces of Equipment is modeled as a
// nested <Equipment ComponentClass="TransmissionSystem"> sub-element of the
// driven equipment, rather than as its own top-level object.
//
// Besides the model checks every class gets, TransmissionSystem is checked
// structurally:
//  1. it must be nested directly inside a parent <Equipment> element, and
//     that parent must carry an Association Type="is driven by" pointing
//     back at this sub-element;
//  2. it must carry its own Association Type="drives", whose ItemID
//     resolves to an <Equipment> element;
//  3. it must carry its own Association Type="is driven by", whose ItemID
//     also resolves to an <Equipment> element.
const TRANSMISSION_SYSTEM_CLASS = "TransmissionSystem";

function findDirectAssociation(el, type) {
    return directChildrenByTag(el, "Association").find(a => (a.getAttribute("Type") || "") === type) || null;
}

// ---- Zero/missing Scale check ----------------------------------------------
//
// A placed symbol (an element carrying both ComponentName and a <Position>
// child) is expected to also carry a <Scale X Y Z/> sibling. A Scale with
// X="0" or Y="0" collapses the symbol to zero size; a missing Scale is
// flagged too.
function readScaleForValidation(el) {
    const scaleEl = directChildrenByTag(el, "Scale")[0];
    if (!scaleEl) return { present: false, x: null, y: null };
    const x = parseFloat(scaleEl.getAttribute("X"));
    const y = parseFloat(scaleEl.getAttribute("Y"));
    return { present: true, x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y };
}

// ---- Symbol-to-class usage constraints ------------------------------------
//
// Every Profile/Shape symbol registered in the loaded DiscProfile.xml is
// valid for only one specific DEXPI class, or for a Custom<X> ComponentClass
// whose TypeURIAssignmentClass resolves to that class. Read from the profile
// via buildSymbolUsageIndex() rather than hardcoded.
//
// A registered symbol's declared usage may be a diagram-decoration concept
// with no corresponding real DEXPI class; classIsResolvable() guards against
// treating such an unresolvable expected class as a constraint.
function classIsResolvable(className, profileClassIndex) {
    if (rdl.classes[className]) return true;
    for (const info of profileClassIndex.values()) {
        if (info.name === className) return true;
    }
    return false;
}

// True if componentClass either is expectedClass (or a static-RDL descendant
// of it), or is a Custom<X> class whose TypeURIAssignmentClass resolves to
// expectedClass or one of its declared superTypes.
function classSatisfiesConstraint(el, componentClass, expectedClass, profileClassIndex) {
    if (!componentClass) return false;
    if (componentClass === expectedClass || classDescendsFrom(componentClass, expectedClass)) return true;
    if (!componentClass.startsWith(CUSTOM_CLASS_PREFIX)) return false;
    const typeUri = findTypeUriAssignmentValue(el);
    const resolved = typeUri ? profileClassIndex.get(typeUri) : null;
    if (!resolved) return false;
    return resolved.name === expectedClass || resolved.superTypes.some(st => st.split(".").pop() === expectedClass);
}

// ---- Attribute scope (class-aware name check) ------------------------------
//
// An attribute in DexpiAttributes / DexpiCustomAttributes is valid only when
// its name (or AttributeURI) is declared for the class it is used with,
// directly or via a supertype:
//  - DEXPI 1.4 model properties of the ComponentClass and its ancestors;
//  - DataProperties of the TypeURIAssignmentClass profile class and its
//    profile superType chain, plus the model properties of the Plant class
//    that chain ends in;
//  - DataProperties of every ClassExtension whose baseType is one of those
//    classes.
// A vendor AttributeURI does not make an attribute valid.

function readProfileDataProperties(classEl) {
    const names = new Set(), uris = new Set();
    directChildrenByTag(classEl, "DataProperty").forEach(dp => {
        const name = dp.getAttribute("name");
        if (name) names.add(name);
        directChildrenByTag(dp, "Data")
            .filter(d => d.getAttribute("property") === "MetaData/rdl_uri")
            .forEach(d => { const t = directChildrenByTag(d, "String")[0]?.textContent?.trim(); if (t) uris.add(t); });
    });
    return { names, uris };
}

// { classProps: Map(profileClassName -> {names, uris}), extProps: Map(baseType last segment -> {names, uris}),
//   allNames: Set, allUris: Set }
export function buildProfileAttributeIndex(discDoc) {
    const index = { classProps: new Map(), extProps: new Map(), allNames: new Set(), allUris: new Set() };
    if (!discDoc) return index;
    const add = (map, key, props) => {
        const hit = map.get(key) || { names: new Set(), uris: new Set() };
        props.names.forEach(n => { hit.names.add(n); index.allNames.add(n); });
        props.uris.forEach(u => { hit.uris.add(u); index.allUris.add(u); });
        map.set(key, hit);
    };
    const walk = node => Array.from(node.children || []).forEach(child => {
        const tag = child.tagName;
        if (tag === "ConcreteClass" || tag === "AbstractClass") add(index.classProps, child.getAttribute("name") || "", readProfileDataProperties(child));
        else if (tag === "ClassExtension") add(index.extProps, lastSegment(child.getAttribute("baseType") || ""), readProfileDataProperties(child));
        walk(child);
    });
    walk(discDoc.documentElement);
    return index;
}

const REVERSE_RENAMES = new Map([...VERSION_RENAMES].map(([a, b]) => [b, a]));

// DEXPI 1.4 class plus its model ancestors, with 2.0 renames alongside.
function modelAncestors(className, out) {
    const cls = REVERSE_RENAMES.get(className) || className;
    if (!cls || out.has(cls)) return;
    out.add(cls);
    if (VERSION_RENAMES.has(cls)) out.add(VERSION_RENAMES.get(cls));
    (rdl.classes[cls]?.superTypes || []).forEach(st => modelAncestors(st, out));
}

// Everything that makes an attribute name valid on this element.
function attributeScope(el, componentClass, profileClassIndex, attrIndex) {
    const modelClasses = new Set();
    modelAncestors(componentClass, modelClasses);
    const names = new Set(), uris = new Set();
    const addProps = p => { if (p) { p.names.forEach(n => names.add(n)); p.uris.forEach(u => uris.add(u)); } };

    const typeUri = customTypeUri(el);
    const resolved = typeUri ? profileClassIndex.get(typeUri) : null;
    if (resolved) {
        addProps(attrIndex.classProps.get(resolved.name));
        profileSuperTypeChain(resolved, profileClassIndex).forEach(st => {
            const seg = lastSegment(st);
            if (attrIndex.classProps.has(seg) && !rdl.classes[seg]) addProps(attrIndex.classProps.get(seg));
            else modelAncestors(seg, modelClasses);
        });
    }
    modelClasses.forEach(cls => {
        if (rdl.classes[cls]) resolveInheritedProperties(cls).forEach((_, short) => names.add(short));
        addProps(attrIndex.extProps.get(cls));
    });
    return { names, uris };
}

function attributeInScope(scope, name, attrUri) {
    return scope.names.has(name) || scope.names.has(stripNameSuffix(name)) || (!!attrUri && scope.uris.has(attrUri));
}

// ---- Element usage (Export Element…) ---------------------------------------
//
// Per document: every class used and every DexpiAttributes /
// DexpiCustomAttributes attribute, with the same validity rules as
// validateAgainstRdl(). An element with TypeURIAssignmentClass is counted
// under the profile class it maps to (superType from DiscProfile.xml);
// otherwise under its ComponentClass (superType from the DEXPI 1.4 model).
//
// Returns { classes: [{className, superType, count, valid}],
//           attributes: [{className, superType, attribute, count, valid}] }.
export function collectElementUsage(mainDoc, discDoc) {
    const profileClassIndex = buildProfileClassSuperTypeIndex(discDoc);
    const attrIndex = buildProfileAttributeIndex(discDoc);
    const profileFacts = buildProfileFacts(discDoc);
    const classes = new Map();
    const attributes = new Map();
    const bump = (map, key, row) => {
        const hit = map.get(key);
        if (hit) hit.count++;
        else map.set(key, { ...row, count: 1 });
    };

    collectValidatableElements(mainDoc).forEach(el => {
        const componentClass = el.getAttribute("ComponentClass") || "";
        const classInfo = rdl.classes[componentClass];
        const typeUri = customTypeUri(el);
        let className, superType, valid;

        if (typeUri) {
            const resolved = discDoc ? profileClassIndex.get(typeUri) : null;
            if (resolved) {
                className = resolved.name;
                superType = resolved.superTypes.join(" ");
                valid = resolved.kind !== "Abstract"
                    && !describeComponentClassTypeUriMismatch(el, componentClass, profileClassIndex, profileFacts).reason;
            } else {
                className = findAttributeInSet(el, CUSTOM_CLASS_ATTR_SET, "TypeNameAssignmentClass")?.getAttribute("Value") || typeUri;
                superType = "";
                valid = false;
            }
        } else {
            className = componentClass;
            superType = (classInfo?.superTypes || []).join(" ");
            const isCustom = componentClass.startsWith(CUSTOM_CLASS_PREFIX) && componentClass.length > CUSTOM_CLASS_PREFIX.length;
            valid = !!classInfo && classInfo.kind !== "Abstract" && !isCustom;
        }
        bump(classes, `${className}\u0000${superType}\u0000${valid}`, { className, superType, valid });

        const scope = attributeScope(el, componentClass, profileClassIndex, attrIndex);
        directChildrenByTag(el, "GenericAttributes").forEach(group => {
            if (!DEXPI_ATTRIBUTE_SETS.has(group.getAttribute("Set") || "")) return;
            directChildrenByTag(group, "GenericAttribute").forEach(ga => {
                const rawName = ga.getAttribute("Name") || "";
                const name = rawName.trim();
                const attrUri = ga.getAttribute("AttributeURI") || "";
                let attrValid;
                if (nameLooksMalformed(rawName)) attrValid = false;
                else if (TYPE_ASSIGNMENT_ATTRS.has(name)) {
                    // An unresolvable type URI is the MDL-CLS-01 case.
                    attrValid = isCustomObjectSubtype(componentClass)
                        && (name !== "TypeURIAssignmentClass" || !discDoc || !!profileClassIndex.get(ga.getAttribute("Value") || ""));
                }
                else attrValid = attributeInScope(scope, name, attrUri);
                bump(attributes, `${className}\u0000${superType}\u0000${name}\u0000${attrValid}`,
                    { className, superType, attribute: name, valid: attrValid });
            });
        });
    });

    return { classes: [...classes.values()], attributes: [...attributes.values()] };
}

// connectivityMap is the Map parseProteusPackage() returns (objectId ->
// { upstream, downstream, group } Sets of connected objectIds), passed in
// by the caller. Optional: if omitted, the PipingNodeOwner connectivity
// check below does not run.
export function validateAgainstRdl(mainDoc, discDoc, connectivityMap) {
    const findings = [];
    const enumLookup = buildEnumValueLookup(discDoc);
    const profileClassIndex = buildProfileClassSuperTypeIndex(discDoc);
    const els = collectValidatableElements(mainDoc);
    const elementById = buildElementByIdIndex(mainDoc);
    const signalEndpointReferencedIds = collectSignalEndpointReferencedIds(mainDoc);
    const symbolRegistrationIndex = buildSymbolRegistrationIndex(mainDoc);
    const symbolUsageIndex = buildSymbolUsageIndex(discDoc);
    // Class-scoped DiscProfile.xml DataProperties, for the attribute-name check below.
    const profileAttrIndex = buildProfileAttributeIndex(discDoc);
    // DiscProfile.xml's own Profile/Symbol catalogue (keyed "DiscProfile/<name>"),
    // used by checkLabelTextTemplates() below. Empty when no DiscProfile.xml
    // is loaded.
    const symbolMap = parseSymbolCatalogue(discDoc);
    // Every profile-derived fact this run needs, read once from the profile
    // that was actually loaded.
    const profileFacts = buildProfileFacts(discDoc);

    let unknownClassCount = 0, unknownAttrCount = 0, malformedNameCount = 0,
        invalidEnumCount = 0, cardinalityCount = 0, extensionAttrCount = 0, profileExtensionAttrCount = 0,
        customClassCheckedCount = 0, customClassUnresolvedCount = 0,
        customClassAttrMissingCount = 0, typeUriUnresolvedCount = 0,
        componentClassMismatchCheckedCount = 0, componentClassMismatchCount = 0,
        signalFlowClassMissingCount = 0, signalFlowClassInvalidCount = 0,
        signalEndpointUnresolvedCount = 0, signalEndpointInvalidCount = 0,
        missingSignalConnectionCount = 0, pipingNodeOwnerNoNodeCount = 0, pipingNodeOwnerNoConnectionCount = 0,
        transmissionSystemCheckedCount = 0, transmissionSystemParentIssueCount = 0, transmissionSystemDriveChainIssueCount = 0,
        pifSymbolAttrCheckedCount = 0, pifSymbolAttrMissingCount = 0,
        zeroScaleSymbolCheckedCount = 0, zeroScaleSymbolCount = 0,
        textTemplateAttrCheckedCount = 0, textTemplateAttrInvalidCount = 0,
        abstractClassUsedCount = 0, abstractComponentClassUsedCount = 0,
        genericAttributesNumberCheckedCount = 0, genericAttributesNumberMismatchCount = 0,
        persistentIdContextCheckedCount = 0, persistentIdContextDuplicateCount = 0;

    // ---- GenericAttributes Number/actual-count mismatch check -------------
    //
    // Every <GenericAttributes Set="..." Number="N"> group's Number attribute
    // should equal the number of <GenericAttribute> children it carries.
    //
    // Runs across the whole document, independent of
    // collectValidatableElements()'s `els`, restricted to
    // DEXPI_ATTRIBUTE_SETS. Findings are attributed to the nearest ancestor
    // element carrying an ID, falling back to no objectId when there is none.
    qsa(mainDoc, "GenericAttributes").forEach(group => {
        // DEXPI-modeled groups only.
        if (!DEXPI_ATTRIBUTE_SETS.has(group.getAttribute("Set") || "")) return;
        const declaredRaw = group.getAttribute("Number");
        if (declaredRaw === null) return; // no Number attribute
        const declared = parseInt(declaredRaw, 10);
        if (Number.isNaN(declared)) return;
        const actual = directChildrenByTag(group, "GenericAttribute").length;
        genericAttributesNumberCheckedCount++;
        if (actual === declared) return;
        genericAttributesNumberMismatchCount++;
        const ownerEl = group.closest ? group.closest("[ID]") : null;
        const objectId = ownerEl ? ownerEl.getAttribute("ID") : null;
        const componentClass = ownerEl ? ownerEl.getAttribute("ComponentClass") : null;
        findings.push({
            severity: "warning", code: "SER-CNT-01", category: "generic-attributes-number-mismatch", objectId, componentClass,
            message: `GenericAttributes Set="${group.getAttribute("Set") || "(no Set)"}" declares Number="${declared}" but actually contains ${actual} GenericAttribute element${actual === 1 ? "" : "s"}.`,
        });
    });

    // ---- Duplicate PersistentID Context (same element) check --------------
    //
    // Context disambiguates multiple PersistentID children of the same
    // element. An element with two or more PersistentID children sharing the
    // same Context (including two both omitting Context) is flagged. Not
    // caught by XSD validation. Runs across the whole document, independent
    // of collectValidatableElements()'s [ID][ComponentClass] filter.
    qsa(mainDoc, "[ID]").forEach(el => {
        const persistentIdEls = directChildrenByTag(el, "PersistentID");
        if (persistentIdEls.length < 2) return;
        persistentIdContextCheckedCount++;
        const byContext = new Map();
        persistentIdEls.forEach(p => {
            const context = p.getAttribute("Context") || "";
            if (!byContext.has(context)) byContext.set(context, []);
            byContext.get(context).push(p.getAttribute("Identifier") || "");
        });
        const dupes = [...byContext.entries()].filter(([, ids]) => ids.length > 1);
        if (dupes.length === 0) return;
        persistentIdContextDuplicateCount++;
        const objectId = el.getAttribute("ID");
        const componentClass = el.getAttribute("ComponentClass") || null;
        const detail = dupes
            .map(([context, ids]) => `${context ? `Context="${context}"` : "no Context"} used ${ids.length} times (Identifier${ids.length === 1 ? "" : "s"}: ${ids.map(id => `'${id}'`).join(", ")})`)
            .join("; ");
        findings.push({
            severity: "warning", code: "SER-IDN-04", category: "duplicate-persistentid-context", objectId, componentClass,
            message: `Element has more than one PersistentID sharing the same Context, which defeats Context's purpose of separately identifying them: ${detail}.`,
        });
    });

    // "Invalid Text Template Attribute Reference" check - see
    // symbolLabelAttributeNames()/isValidTextTemplateAttribute() in
    // proteusParser.js. componentName is whichever element carries the
    // ComponentName that placed the symbol; labelEls is the set of <Label>
    // elements whose Text children are checked. Runs for every Label once
    // any DiscProfile.xml is loaded.
    function checkLabelTextTemplates(componentName, objectId, componentClass, labelEls) {
        if (!discDoc) return;
        const regNum = componentName ? symbolRegistrationIndex.get(componentName) : null;
        const symbol = regNum ? symbolMap.get(`DiscProfile/${regNum}`) : null;
        const allowed = symbol ? symbolLabelAttributeNames(symbol) : new Set();
        labelEls.forEach(labelEl => {
            directChildrenByTag(labelEl, "Text").forEach(textEl => {
                const str = textEl.getAttribute("String");
                if (!str) return;
                textTemplateAttrCheckedCount++;
                if (isValidTextTemplateAttribute(textEl, allowed, elementById)) return;
                textTemplateAttrInvalidCount++;
                const depAttrs = readTextTemplateDependantAttributes(textEl);
                const got = depAttrs === null ? "no <TextStringFormatSpecification> at all"
                    : depAttrs.length ? `DependantAttribute ${depAttrs.map(a => `"${a}"`).join(", ")}`
                    : "an empty <TextStringFormatSpecification>";
                const expected = symbol
                    ? (allowed.size ? ` (expected: ${[...allowed].map(a => `"${a}"`).join(", ")})` : " (this symbol defines no attribute-templated label at all)")
                    : componentName
                        ? ` (ComponentName "${componentName}" does not resolve to any symbol in the loaded DiscProfile.xml)`
                        : " (this Label has no ComponentName - no symbol to validate against)";
                findings.push({
                    code: (symbol && allowed.size) ? "PRF-LBL-01" : "PRF-LBL-02",
                    severity: "warning", category: "invalid-text-template-attribute", objectId, componentClass,
                    message: `Label Text "${str}" has ${got}, which is not valid now that a DiscProfile.xml is loaded${expected}.`,
                });
            });
        });
    }

    // Standalone <Label> elements, excluded from
    // collectValidatableElements()'s `els` below. A Label that is a direct
    // XML child of another tracked element is skipped here since it is
    // covered by that owner's own pass in the els.forEach loop below.
    qsa(mainDoc, "Label[ID]").forEach(el => {
        const parentId = el.parentNode?.getAttribute?.("ID");
        if (parentId && elementById.has(parentId)) return;
        checkLabelTextTemplates(el.getAttribute("ComponentName"), el.getAttribute("ID"), el.getAttribute("ComponentClass") || null, [el]);
    });

    // InformationFlow ComponentClass check: expected to be
    // "SignalConveyingFunction" or one of its two concrete subtypes
    // (MeasuringLineFunction, SignalLineFunction).
    collectInformationFlowElements(mainDoc).forEach(el => {
        const objectId = el.getAttribute("ID");
        const componentClass = el.getAttribute("ComponentClass");
        if (!componentClass) {
            signalFlowClassMissingCount++;
            findings.push({
                severity: "warning", code: "MDL-CLS-01", category: "signal-flow-class", objectId, componentClass: null,
                message: `InformationFlow has no ComponentClass attribute - expected "SignalConveyingFunction" or a subtype (MeasuringLineFunction, SignalLineFunction).`,
            });
        } else if (!SIGNAL_FLOW_COMPONENT_CLASSES.has(componentClass)) {
            signalFlowClassInvalidCount++;
            findings.push({
                severity: "warning", code: "MDL-REF-03", category: "signal-flow-class", objectId, componentClass,
                message: `InformationFlow ComponentClass "${componentClass}" is not "SignalConveyingFunction" or a known subtype (MeasuringLineFunction, SignalLineFunction).`,
            });
        }

        // Source/Target endpoint-type check - see SIGNAL_SOURCE_ROLE /
        // SIGNAL_TARGET_ROLE above.
        directChildrenByTag(el, "Association").forEach(a => {
            const assocType = a.getAttribute("Type") || "";
            const isStart = assocType === "has logical start";
            const isEnd = assocType === "has logical end";
            if (!isStart && !isEnd) return;
            const itemId = a.getAttribute("ItemID");
            if (!itemId) return;

            const role = isStart ? "Source" : "Target";
            const roleClass = isStart ? SIGNAL_SOURCE_ROLE : SIGNAL_TARGET_ROLE;
            const refEl = elementById.get(itemId);

            if (!refEl) {
                signalEndpointUnresolvedCount++;
                findings.push({
                    severity: "warning", code: "MDL-REF-04", category: "signal-endpoint-unresolved", objectId, componentClass,
                    message: `${role} reference "${itemId}" ("has logical ${isStart ? "start" : "end"}") does not resolve to any object in the document.`,
                });
                return;
            }

            const refClass = refEl.getAttribute("ComponentClass");
            if (!refClass) {
                signalEndpointUnresolvedCount++;
                findings.push({
                    severity: "warning", code: "MDL-REF-04", category: "signal-endpoint-unresolved", objectId, componentClass,
                    message: `${role} object "${itemId}" has no ComponentClass, so its type can't be verified against the allowed ${role} classes.`,
                });
                return;
            }

            if (!classDescendsFrom(refClass, roleClass)) {
                signalEndpointInvalidCount++;
                findings.push({
                    severity: "warning", code: "MDL-REF-03", category: "signal-endpoint-invalid", objectId, componentClass,
                    message: `${role} object "${itemId}" has ComponentClass "${refClass}", which is not a valid SignalConveyingFunction.${role} type (must descend from ${roleClass}).`,
                });
            }
        });
    });

    els.forEach(el => {
        const objectId = el.getAttribute("ID");
        const componentClass = el.getAttribute("ComponentClass");
        const classInfo = rdl.classes[componentClass];

        // Abstract-class-used check 1 ("abstract-class-used") - see doc
        // comment above findResolvedRdlUriForAbstractCheck().
        {
            const resolvedUri = findResolvedRdlUriForAbstractCheck(el);
            const resolvedProfileClass = resolvedUri ? profileClassIndex.get(resolvedUri) : null;
            if (resolvedProfileClass && resolvedProfileClass.kind === "Abstract") {
                abstractClassUsedCount++;
                findings.push({
                    severity: "warning", code: "MDL-CLS-02", category: "abstract-class-used", objectId, componentClass,
                    message: `Object resolves (via TypeURIAssignmentClass/ComponentClassURI) to "${resolvedProfileClass.name}", which is an Abstract class in the loaded DiscProfile.xml - a Concrete leaf class should be used instead.`,
                });
            }
        }

        // Abstract-class-used check 2 ("abstract-componentclass-used") - see
        // doc comment above findResolvedRdlUriForAbstractCheck().
        if (classInfo && classInfo.kind === "Abstract") {
            abstractComponentClassUsedCount++;
            findings.push({
                severity: "warning", code: "MDL-CLS-02", category: "abstract-componentclass-used", objectId, componentClass,
                message: `ComponentClass "${componentClass}" is an Abstract class in the DEXPI 1.4 model - a Concrete leaf class should be used instead.`,
            });
        }

        // Custom<X> class check, independent of the static-RDL class lookup
        // above/below.
        if (componentClass && componentClass.length > CUSTOM_CLASS_PREFIX.length && componentClass.startsWith(CUSTOM_CLASS_PREFIX)) {
            customClassCheckedCount++;
            const typeUri = findTypeUriAssignmentValue(el);
            if (!typeUri) {
                customClassUnresolvedCount++;
                findings.push({
                    severity: "warning", code: "MDL-CLS-04", category: "custom-class-unresolved", objectId, componentClass,
                    message: `ComponentClass "${componentClass}" has no TypeURIAssignmentClass attribute, so its real semantic type can't be verified against the loaded DiscProfile.xml.`,
                });
            }
            // Unresolved / wrong-superType TypeURIAssignmentClass is covered
            // by the type-assignment checks below.

            // Required-attribute check - see CUSTOM_CLASS_REQUIRED_ATTRS above.
            const missingCustomAttrs = CUSTOM_CLASS_REQUIRED_ATTRS.filter(name => !findAttributeInSet(el, CUSTOM_CLASS_ATTR_SET, name));
            if (missingCustomAttrs.length) {
                customClassAttrMissingCount++;
                findings.push({
                    severity: "warning", code: "MDL-PRP-03", category: "custom-class-required-attribute", objectId, componentClass,
                    message: `Custom class "${componentClass}" is missing ${missingCustomAttrs.map(m => `"${m}"`).join(" and ")} in GenericAttributes Set="${CUSTOM_CLASS_ATTR_SET}".`,
                });
            }
        }

        // Type-assignment check (CustomObject subtypes only):
        // TypeURIAssignmentClass must resolve to a DiscProfile.xml class
        // (profile class extension).
        if (discDoc) {
            const typeUri = customTypeUri(el);
            if (typeUri && !profileClassIndex.get(typeUri)) {
                typeUriUnresolvedCount++;
                findings.push({
                    severity: "warning", code: "MDL-CLS-01", category: "type-uri-unresolved", objectId, componentClass,
                    message: `TypeURIAssignmentClass "${typeUri}" does not match any class extension in the loaded DiscProfile.xml.`,
                });
            }
        }

        // ComponentClass mismatch check (unified) - see
        // describeComponentClassTypeUriMismatch() above. Merges the
        // TypeURIAssignmentClass-based evidence (both directions) and the
        // drawn-symbol-based evidence into one finding per object.
        {
            const reasons = [];
            let checked = false;

            const typeUriResult = describeComponentClassTypeUriMismatch(el, componentClass, profileClassIndex, profileFacts);
            if (typeUriResult.applicable) {
                checked = true;
                if (typeUriResult.reason) reasons.push(typeUriResult.reason);
            }

            const symbol = symbolRegistrationIndex.get(el.getAttribute("ComponentName") || "");
            const rawExpectedSymbolClass = symbol ? symbolUsageIndex.get(symbol) : null;
            const expectedSymbolClass = rawExpectedSymbolClass && classIsResolvable(rawExpectedSymbolClass, profileClassIndex) ? rawExpectedSymbolClass : null;
            let symbolEvidenceUsed = false;
            if (expectedSymbolClass) {
                checked = true;
                if (!classSatisfiesConstraint(el, componentClass, expectedSymbolClass, profileClassIndex)) {
                    symbolEvidenceUsed = true;
                    reasons.push(`the drawn symbol "${symbol}" is expected to be used only by "${expectedSymbolClass}" (or a Custom class whose TypeURIAssignmentClass resolves to it)`);
                }
            }

            if (checked) componentClassMismatchCheckedCount++;
            if (reasons.length) {
                componentClassMismatchCount++;
                findings.push({
                    code: symbolEvidenceUsed ? "PRF-SYM-02" : "MDL-CLS-03",
                    severity: "warning", category: "componentclass-mismatch", objectId, componentClass,
                    message: `ComponentClass "${componentClass}" does not match: ${reasons.join("; ")}.`,
                });
            }
        }

        // ProcessInstrumentationFunction Source/Target coverage check - see
        // PROCESS_INSTRUMENTATION_ROLE above.
        if (classDescendsFrom(componentClass, PROCESS_INSTRUMENTATION_ROLE) && !signalEndpointReferencedIds.has(objectId)) {
            missingSignalConnectionCount++;
            findings.push({
                severity: "warning", code: "MDL-REF-05", category: "missing-signal-connection", objectId, componentClass,
                message: `${componentClass} object is not referenced as the Source or Target ("has logical start"/"has logical end") of any InformationFlow.`,
            });
        }


        // Zero/missing Scale check - see readScaleForValidation() above.
        // Only runs against elements carrying both ComponentName and a
        // Position child.
        if (el.getAttribute("ComponentName") && directChildrenByTag(el, "Position")[0]) {
            zeroScaleSymbolCheckedCount++;
            const scale = readScaleForValidation(el);
            if (!scale.present) {
                zeroScaleSymbolCount++;
                findings.push({
                    severity: "warning", code: "PRF-TRN-05", category: "zero-scale-symbol", objectId, componentClass,
                    message: `Placed symbol has no <Scale> element - expected an explicit Scale sizing the symbol.`,
                });
            } else if (scale.x === 0 || scale.y === 0) {
                zeroScaleSymbolCount++;
                findings.push({
                    severity: "warning", code: "PRF-TRN-05", category: "zero-scale-symbol", objectId, componentClass,
                    message: `Placed symbol has a zero-sized Scale (X="${scale.x}" Y="${scale.y}") - the symbol will render as a point.`,
                });
            }
        }

        // "Invalid Text Template Attribute Reference" check for <Label>
        // elements nested directly under this object.
        checkLabelTextTemplates(el.getAttribute("ComponentName"), objectId, componentClass, directChildrenByTag(el, "Label"));

        // PipingNodeOwner coverage checks - see PIPING_NODE_OWNER_ROLE above.
        // The two checks are independent.
        if (classDescendsFrom(componentClass, PIPING_NODE_OWNER_ROLE)) {
            if (!elementHasPipingNode(el)) {
                pipingNodeOwnerNoNodeCount++;
                findings.push({
                    severity: "warning", code: "MDL-CMP-03", category: "piping-node-owner-no-node", objectId, componentClass,
                    message: `${componentClass} object has no ConnectionPoints/Node (PipingNode) defined.`,
                });
            }
            if (connectivityMap) {
                const conn = connectivityMap.get(objectId);
                // group counts as a real connection here too - see Rule 5 in
                // proteusParser.js's deriveProteusFlowConnectivity().
                const hasConnection = !!conn && (conn.upstream.size > 0 || conn.downstream.size > 0 || conn.group.size > 0);
                if (!hasConnection) {
                    pipingNodeOwnerNoConnectionCount++;
                    findings.push({
                        severity: "warning", code: "GEO-NCT-01", category: "piping-node-owner-no-connection", objectId, componentClass,
                        message: `${componentClass} object has no upstream/downstream/group connection after connectivity was calculated.`,
                    });
                }
            }
        }

        // TransmissionSystem sub-model check - see TRANSMISSION_SYSTEM_CLASS
        // above.
        if (componentClass === TRANSMISSION_SYSTEM_CLASS) {
            transmissionSystemCheckedCount++;
            const parentEl = el.parentElement;
            const parentIsEquipment = !!parentEl && parentEl.tagName === "Equipment";
            const parentDrivenByAssoc = parentIsEquipment ? findDirectAssociation(parentEl, "is driven by") : null;
            const parentOk = parentIsEquipment && parentDrivenByAssoc && parentDrivenByAssoc.getAttribute("ItemID") === objectId;
            if (!parentOk) {
                transmissionSystemParentIssueCount++;
                findings.push({
                    severity: "warning", code: "MDL-CMP-02", category: "transmission-system-parent", objectId, componentClass,
                    message: !parentIsEquipment
                        ? `TransmissionSystem must be nested directly inside a parent <Equipment> element.`
                        : `Parent Equipment "${parentEl.getAttribute("ID") || ""}" has no Association Type="is driven by" pointing back at this TransmissionSystem.`,
                });
            }

            const checkDriveAssociation = (type) => {
                const assoc = findDirectAssociation(el, type);
                if (!assoc) {
                    transmissionSystemDriveChainIssueCount++;
                    findings.push({
                        severity: "warning", code: "MDL-CMP-03", category: "transmission-system-drive-chain", objectId, componentClass,
                        message: `TransmissionSystem has no Association Type="${type}".`,
                    });
                    return;
                }
                const itemId = assoc.getAttribute("ItemID");
                const refEl = itemId ? elementById.get(itemId) : null;
                if (!refEl || refEl.tagName !== "Equipment") {
                    transmissionSystemDriveChainIssueCount++;
                    findings.push({
                        severity: "warning", code: "MDL-CMP-03", category: "transmission-system-drive-chain", objectId, componentClass,
                        message: refEl
                            ? `TransmissionSystem's "${type}" Association refers to "${itemId}", which is a <${refEl.tagName}> element, not <Equipment>.`
                            : `TransmissionSystem's "${type}" Association refers to "${itemId}", which does not resolve to any object in the document.`,
                    });
                }
            };
            checkDriveAssociation("drives");
            checkDriveAssociation("is driven by");
        }

        if (!classInfo) {
            unknownClassCount++;
            findings.push({
                code: "MDL-CLS-01",
                severity: "warning", category: "unknown-class", objectId, componentClass,
                message: `ComponentClass "${componentClass}" was not found in the DEXPI 1.4 model. Vendor and marker classes are not valid.`,
            });
            return; // can't meaningfully check attributes against an unresolved class
        }

        const inherited = resolveInheritedProperties(componentClass);
        const scope = attributeScope(el, componentClass, profileClassIndex, profileAttrIndex);
        const occurrenceCounts = new Map(); // shortPropName -> count, for cardinality check

        directChildrenByTag(el, "GenericAttributes").forEach(group => {
            const set = group.getAttribute("Set");
            if (!DEXPI_ATTRIBUTE_SETS.has(set)) return; // only real DEXPI-modeled attributes are RDL-checked
            directChildrenByTag(group, "GenericAttribute").forEach(ga => {
                const rawName = ga.getAttribute("Name") || "";
                if (TYPE_ASSIGNMENT_ATTRS.has(rawName.trim())) return;
                const attrUri = ga.getAttribute("AttributeURI") || "";
                const rawValue = ga.getAttribute("Value");

                if (nameLooksMalformed(rawName)) {
                    malformedNameCount++;
                    findings.push({
                        severity: "warning", code: "SER-VAL-01", category: "malformed-name", objectId, componentClass,
                        message: `GenericAttribute Name ${JSON.stringify(rawName)} has stray whitespace (possibly a non-breaking space) - likely a copy/paste artifact in the export mapping.`,
                    });
                }

                const shortName = stripNameSuffix(rawName.trim());
                const propInfo = inherited.get(shortName);

                if (!propInfo) {
                    // Declared for this class in the profile (directly, via
                    // its profile superType chain, or a ClassExtension on
                    // one of its classes): no finding.
                    if (attributeInScope(scope, rawName.trim(), attrUri)) {
                        profileExtensionAttrCount++;
                        return;
                    }
                    unknownAttrCount++;
                    const shortTrim = rawName.trim();
                    const isProfileProp = profileAttrIndex.allNames.has(shortTrim) || profileAttrIndex.allNames.has(stripNameSuffix(shortTrim))
                        || (!!attrUri && profileAttrIndex.allUris.has(attrUri));
                    const isDexpiNamespace = DEXPI_ATTRIBUTE_URI_NAMESPACES.some(ns => attrUri.startsWith(ns));
                    findings.push({
                        code: isProfileProp ? "PRF-EXT-01" : isDexpiNamespace ? "MDL-PRP-05" : "MDL-PRP-01",
                        severity: "warning", category: "unknown-attribute", objectId, componentClass,
                        message: isProfileProp
                            ? `Attribute "${rawName}" is a DiscProfile.xml property, but not one declared for ${componentClass}, its TypeURIAssignmentClass profile class, or their supertypes/ClassExtensions.`
                            : `Attribute "${rawName}" is not declared for ${componentClass} or its supertypes in the DEXPI 1.4 model or the loaded DiscProfile.xml${attrUri ? ` (AttributeURI: ${attrUri})` : " (no AttributeURI)"}.`,
                    });
                    return;
                }

                occurrenceCounts.set(shortName, (occurrenceCounts.get(shortName) || 0) + 1);

                // Enum value check
                if (propInfo.valueType && rdl.enums[propInfo.valueType] && rawValue) {
                    const accepted = enumLookup.get(propInfo.valueType);
                    if (accepted && !accepted.has(rawValue)) {
                        invalidEnumCount++;
                        findings.push({
                            severity: "warning", code: "SER-VAL-04", category: "invalid-enum-value", objectId, componentClass,
                            message: `${propInfo.owner}.${shortName} = "${rawValue}" is not a valid ${propInfo.valueType} literal (or its short code).`,
                        });
                    }
                }
            });
        });

        // Cardinality check: compare each resolved property's occurrence
        // count against the RDL's declared upper bound.
        occurrenceCounts.forEach((count, shortName) => {
            const propInfo = inherited.get(shortName);
            if (typeof propInfo.upper === "number" && count > propInfo.upper) {
                cardinalityCount++;
                findings.push({
                    severity: "warning", code: "MDL-MUL-01", category: "cardinality", objectId, componentClass,
                    message: `${propInfo.owner}.${shortName} appears ${count} times but the RDL allows at most ${propInfo.upper}.`,
                });
            }
        });
    });

    // ---- checks that read the loaded profile directly -------------------
    const elList = els.map(el => ({
        el,
        objectId: el.getAttribute("ID") || el.getAttribute("id") || "",
        componentClass: el.getAttribute("ComponentClass") || "",
    }));
    const byNode = new Map(elList.map(e => [e.el, e]));
    const lookup = node => {
        for (let n = node; n; n = n.parentNode) {
            const hit = byNode.get(n);
            if (hit) return hit;
        }
        return null;
    };
    const hasAttribute = (el, bareName) =>
        directChildrenByTag(el, "GenericAttributes")
            .filter(g => DEXPI_ATTRIBUTE_SETS.has(g.getAttribute("Set") || ""))
            .some(g => directChildrenByTag(g, "GenericAttribute").some(ga =>
                stripNameSuffix((ga.getAttribute("Name") || "").trim()) === bareName));

    findings.push(...checkDeclaredVersion(mainDoc));
    findings.push(...checkZeroLengthConnectors(mainDoc, lookup));
    findings.push(...checkSegmentContinuity(mainDoc, lookup));
    findings.push(...checkDiscScope(elList, profileFacts, DEXPI_ATTRIBUTE_SETS, { dexpi1x: isDexpi1x(mainDoc), isCustomObject: isCustomObjectSubtype }));
    findings.push(...checkSymbolCatalogue(elList, profileFacts, symbolRegistrationIndex));
    findings.push(...checkGridAlignment(mainDoc, discDoc, lookup));

    // ---- three-state result per code -------------------------------------
    // A code that cannot be evaluated is reported as such, never as a pass.
    const counts = {};
    findings.forEach(f => { if (f.code) counts[f.code] = (counts[f.code] || 0) + 1; });

    // hasProfile: whether a profile was loaded. fileUsesProfile: whether the
    // file claims DISC. A plain DEXPI file is not judged against the profile;
    // a DISC file with no profile loaded reports not-evaluated.
    const discClaim = detectDiscClaim(mainDoc, profileFacts);
    const ctx = {
        hasProfile: profileFacts.hasProfile,
        fileUsesProfile: discClaim.claims,
    };

    // Codes gated on an input the caller may not have supplied; without it
    // the check does not run and must not report "pass".
    const RUNTIME_PRECONDITIONS = {
        "GEO-NCT-01": !!connectivityMap,   // needs the caller's connectivity map
        "MDL-REF-05": !!connectivityMap,
    };

    const codeStates = {};
    ALL_CODES.forEach(code => {
        codeStates[code] = RUNTIME_PRECONDITIONS[code] === false
            ? "not-evaluated"
            : codeState(code, { ...ctx, findingCount: counts[code] || 0 });
    });
    const notEvaluated = ALL_CODES.filter(c => codeStates[c] === "not-evaluated");

    // Findings withheld from the result:
    //   - a finding under a code that could not be evaluated.
    //   - a finding carrying no classification code (legacy, pre-register
    //     checks).
    // Both counts are returned separately, so nothing is dropped silently.
    const emitted = findings.filter(f => f.code && codeStates[f.code] !== "not-evaluated");
    const uncoded = findings.filter(f => !f.code).length;
    const suppressed = findings.length - emitted.length - uncoded;

    return {
        codeStates,
        notEvaluated,
        hasProfile: profileFacts.hasProfile,
        fileUsesProfile: discClaim.claims,
        discEvidence: discClaim.evidence,
        suppressedFindings: suppressed,
        uncodedFindings: uncoded,
        unimplementedCodes: UNIMPLEMENTED_CODES,
        summary: {
            totalObjects: els.length,
            unknownClasses: unknownClassCount,
            unknownAttributes: unknownAttrCount,
            malformedNames: malformedNameCount,
            invalidEnumValues: invalidEnumCount,
            cardinalityViolations: cardinalityCount,
            extensionAttributes: extensionAttrCount,
            profileExtensionAttributes: profileExtensionAttrCount,
            genericAttributesNumberChecked: genericAttributesNumberCheckedCount,
            genericAttributesNumberMismatches: genericAttributesNumberMismatchCount,
            persistentIdContextChecked: persistentIdContextCheckedCount,
            persistentIdContextDuplicates: persistentIdContextDuplicateCount,
            customClassesChecked: customClassCheckedCount,
            customClassUnresolved: customClassUnresolvedCount,
            typeUriUnresolved: typeUriUnresolvedCount,
            componentClassMismatchChecked: componentClassMismatchCheckedCount,
            componentClassMismatches: componentClassMismatchCount,
            signalFlowClassMissing: signalFlowClassMissingCount,
            signalFlowClassInvalid: signalFlowClassInvalidCount,
            signalEndpointUnresolved: signalEndpointUnresolvedCount,
            signalEndpointInvalid: signalEndpointInvalidCount,
            missingSignalConnection: missingSignalConnectionCount,
            pipingNodeOwnerNoNode: pipingNodeOwnerNoNodeCount,
            pipingNodeOwnerNoConnection: pipingNodeOwnerNoConnectionCount,
            transmissionSystemsChecked: transmissionSystemCheckedCount,
            transmissionSystemParentIssues: transmissionSystemParentIssueCount,
            transmissionSystemDriveChainIssues: transmissionSystemDriveChainIssueCount,
            customClassAttrMissing: customClassAttrMissingCount,
            pifSymbolAttrChecked: pifSymbolAttrCheckedCount,
            pifSymbolAttrMissing: pifSymbolAttrMissingCount,
            zeroScaleSymbolsChecked: zeroScaleSymbolCheckedCount,
            zeroScaleSymbols: zeroScaleSymbolCount,
            textTemplateAttrChecked: textTemplateAttrCheckedCount,
            textTemplateAttrInvalid: textTemplateAttrInvalidCount,
            abstractClassUsed: abstractClassUsedCount,
            abstractComponentClassUsed: abstractComponentClassUsedCount,
        },
        // Only findings whose code was actually evaluated; suppressedFindings
        // above counts what was withheld.
        findings: emitted,
    };
}
