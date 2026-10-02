// Validates a parsed Proteus / DEXPI 1.4 document against the DEXPI 1.4
// information model in dexpi14Rdl.json.
//
// Unlike xsdValidate.js's structural checks, this cross-references
// ComponentClass names and GenericAttribute AttributeURIs against the RDL:
// unknown classes, attributes whose AttributeURI is not the rdl_uri of a
// property on the object's class or its ancestors, enum values outside the
// allowed literal set, and attribute counts outside the declared cardinality.
//
// Attributes outside the core DEXPI 1.4 model are not flagged as errors; see
// the AttributeURI namespace check below.
import rdl from "./dexpi14Rdl.json";
// MetaData/rdl_uri of every DEXPI 1.4 class and data attribute (built by
// scripts/build-rdl-uris.py). The AttributeURI of a GenericAttribute is
// matched against these and against the DataProperty rdl_uris of the loaded
// DiscProfile.xml; the attribute Name is not used for matching.
import rdlUris from "./dexpiRdlUris.json";
import { ISSUE_CODES, PROFILE_CODES, DISC_SCOPED_CODES, UNION_MODEL_CODES, ALL_CODES, UNIMPLEMENTED_CODES, codeState } from "./issueCodes.js";
import {
    buildProfileFacts, expectedCustomFamily, normalizeSymbolName,
    checkDiscScope, checkSymbolCatalogue,
    checkGridAlignment, checkDeclaredVersion, checkZeroLengthConnectors, checkSegmentContinuity, checkPipingLinkage,
    detectDiscClaim, isDexpi1x, isDexpi1xPropertyBreakAttribute,
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

// CustomEquipment typed as a DISC ProcessVesselComponent (the class itself or
// a subtype) is allowed, but only as a <Component> child of a Vessel
// <Equipment> (VesselExtension.ProcessVesselComponents). The placement is
// checked separately as MDL-CMP-02.
const VESSEL_COMPONENT_WRAPPER = "CustomEquipment";
const VESSEL_COMPONENT_FAMILY = "ProcessVesselComponent";
const VESSEL_CLASS = "Vessel";

function isVesselComponentType(el, componentClass, profileClassIndex) {
    if (componentClass !== VESSEL_COMPONENT_WRAPPER) return false;
    const typeUri = customTypeUri(el);
    const resolved = typeUri ? profileClassIndex.get(typeUri) : null;
    if (!resolved) return false;
    return resolved.name === VESSEL_COMPONENT_FAMILY
        || profileSuperTypeChain(resolved, profileClassIndex).some(st => lastSegment(st) === VESSEL_COMPONENT_FAMILY);
}

function isVesselComponentPlacementValid(el) {
    const parentEl = el.parentElement;
    return el.tagName === "Component" && !!parentEl && parentEl.tagName === "Equipment"
        && classDescendsFrom(parentEl.getAttribute("ComponentClass") || "", VESSEL_CLASS);
}

// Accepted ComponentClass / TypeURIAssignmentClass pairs that the superType
// rule would reject. DEXPI 1.4 (Proteus) files carry a Thermowell as a
// CustomInlineMeasuringElement, while the profile derives Thermowell from
// Plant/Piping.Sensorwell. For such an element the allowed attributes are
// those of the wrapper's own class (InlineMeasuringElement and its
// ClassExtensions), not the profile class's chain; TypeNameAssignmentClass /
// TypeURIAssignmentClass are allowed as on any CustomObject subtype.
const TYPE_URI_WRAPPER_EXCEPTIONS = new Map([
    ["http://data.posccaesar.org/rdl/RDS418049", new Set(["CustomInlineMeasuringElement"])], // Thermowell
]);

function isTypeUriWrapperException(componentClass, typeUri) {
    return !!TYPE_URI_WRAPPER_EXCEPTIONS.get(typeUri)?.has(componentClass);
}

function describeComponentClassTypeUriMismatch(el, componentClass, profileClassIndex, profileFacts) {
    const typeUri = customTypeUri(el);
    if (!typeUri || !componentClass) return { applicable: false, reason: null };
    const resolved = profileClassIndex.get(typeUri);
    if (!resolved) return { applicable: false, reason: null };
    if (isVesselComponentType(el, componentClass, profileClassIndex)) return { applicable: true, reason: null };
    if (isTypeUriWrapperException(componentClass, typeUri)) return { applicable: true, reason: null };
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
                result.set(short, { owner: cls, full, rdlUri: rdlUris.properties[full] || "", ...propInfo });
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

// Elements whose Proteus 4.1.1 schema type allows ComponentClass / ComponentClassURI; each must carry both (ShapeCatalogue content and Symbol subtypes excepted).
const CLASS_BEARING_TAGS = [
    "ActuatingElectricalFunction", "ActuatingElectricalSystem", "ActuatingElectricalSystemComponent", "ActuatingFunction",
    "ActuatingSystem", "ActuatingSystemComponent", "Component", "Equipment", "InformationFlow", "InstrumentComponent",
    "InstrumentConnection", "InstrumentLoop", "InstrumentationLoopFunction", "InsulationSymbol", "Label", "MetaData", "Note",
    "Nozzle", "PipeConnectorSymbol", "PipeFlowArrow", "PipeOffPageConnector", "PipeOffPageConnectorReference", "PipeSlopeSymbol",
    "PipingComponent", "PipingNetworkSegment", "PipingNetworkSystem", "PlantArea", "PlantItem", "PlantStructureItem",
    "ProcessInstrument", "ProcessInstrumentationFunction", "ProcessSignalGeneratingFunction", "ProcessSignalGeneratingSystem",
    "ProcessSignalGeneratingSystemComponent", "PropertyBreak", "ScopeBubble", "SignalConnectorSymbol", "SignalOffPageConnector",
    "SignalOffPageConnectorReference", "Symbol",
];

// DEXPI Symbol subtypes are not checked by MDL-CLS-05: by ComponentClass, or by element name when it has none.
const SYMBOL_TAGS = new Set(["Symbol", "InsulationSymbol", "PipeFlowArrow", "PipeSlopeSymbol"]);
function isSymbolElement(el, componentClass) {
    return componentClass
        ? componentClass === "Symbol" || classDescendsFrom(componentClass, "Symbol")
        : SYMBOL_TAGS.has(el.tagName);
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

// The profile symbol an element refers to, identified by its
// SymbolRegistrationNumber only (never the ComponentName itself).
// `usageKey` is what the profile's symbol usage is looked up by.
function resolveSymbolReference(el, registrationIndex, profileFacts) {
    const raw = el.getAttribute("ComponentName") || "";
    const registered = registrationIndex.get(raw) || null;
    const profileSymbol = registered && profileFacts.symbolNames.has(normalizeSymbolName(registered)) ? normalizeSymbolName(registered) : null;
    return { raw, registered, profileSymbol, usageKey: registered };
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

// ---- Actuating signal connector endpoint check ---------------------------
//
// An InformationFlow whose Source or Target is an ActuatingFunction must
// have its <Connection> end on that side (FromID/FromNode for Source,
// ToID/ToNode for Target) on a ControlledActuator. One whose Target is an
// ActuatingElectricalFunction must have its ToID/ToNode on a Nozzle.
const ACTUATOR_CLASSES = new Set(["ControlledActuator"]);

// Resolves a Connection FromID/ToID by ID, TagName, or "<EquipmentTag>-<NozzleTag>".
function buildConnectionTargetResolver(mainDoc, elementById) {
    const byTag = new Map();
    qsa(mainDoc, "[TagName]").forEach(el => {
        const tag = el.getAttribute("TagName");
        if (!tag || el.tagName === "Association") return;
        if (!byTag.has(tag)) byTag.set(tag, el);
        if (el.tagName !== "Nozzle") return;
        const equipTag = el.parentElement?.closest?.("[TagName]")?.getAttribute("TagName");
        if (equipTag && !byTag.has(`${equipTag}-${tag}`)) byTag.set(`${equipTag}-${tag}`, el);
    });
    return value => elementById.get(value) || byTag.get(value) || null;
}

// ---- PipingNodeOwner coverage checks --------------------------------------
//
// PipingNodeOwner.Nodes (RDL) -> PipingNode: represented in Proteus XML by a
// component's own <ConnectionPoints><Node>...</Node></ConnectionPoints>
// children.
const PIPING_NODE_OWNER_ROLE = "PipingNodeOwner";

// MDL-CMP-03 is a warning unless the DEXPI 1.4 model requires the
// sub-component (reference property lower multiplicity >= 1); then the
// finding carries severityOverride "error". In the 1.4 model
// PipingNodeOwner.Nodes and TransmissionSystem.Driver are both 0..*/0..1,
// and "drives" has no model property, so today every MDL-CMP-03 is a warning.
function subComponentRequired(componentClass, propShort) {
    const info = resolveInheritedProperties(componentClass).get(propShort);
    return typeof info?.lower === "number" && info.lower >= 1;
}
function cmp03Finding(componentClass, propShort, finding) {
    return subComponentRequired(componentClass, propShort) ? { ...finding, severityOverride: "error" } : finding;
}

function elementHasPipingNode(el) {
    return directChildrenByTag(el, "ConnectionPoints").some(cp => directChildrenByTag(cp, "Node").length > 0);
}

// ---- Reference multiplicity check (MDL-MUL-03) ----------------------------
//
// A Proteus Association is one end of a model reference; the bound on how
// many objects may sit at its far end is the multiplicity the model declares
// on the reference property. Each entry maps an Association pair to the
// object whose class declares the property (the "holder": the object that
// carries the forward type, or that the inverse type points at) and to the
// property names that may realize it. XML nesting counts as whole-part.
// For every holder, the distinct objects linked to it through either type
// are counted against the property's upper bound; the property is picked by
// the partner's class descending from its valueType, first match wins.
const REFERENCE_MULTIPLICITY = [
    { forward: ["is located in"], inverse: ["is the location of"],
      props: ["Chamber", "SensingLocation", "ActuatingLocation", "ActuatingElectricalLocation", "PlantArea", "PlantSystem", "PlantTrain", "ParentStructure"] },
    { forward: ["is a part of", "is a component of", "is an element of", "is contained in"],
      inverse: ["is a collection including", "is an assembly including", "is a composition including", "contains"], nesting: true,
      props: ["PlantArea", "PlantSystem", "PlantTrain", "ParentStructure"] },
    { forward: ["is fulfilled by"], inverse: ["fulfills"], props: ["Systems"] },
    { forward: ["refers to"], inverse: ["is referenced by"], props: ["ReferencedConnector", "ConnectorReference"] },
    { forward: ["is driven by"], inverse: ["drives"], props: ["Driver", "DrivingTransmissionSystem"] },
    { forward: ["has logical start"], inverse: ["is logical start of"], props: ["Source"] },
    { forward: ["has logical end"], inverse: ["is logical end of"], props: ["Target"] },
];

function checkReferenceMultiplicity(elList) {
    const findings = [];
    const byId = new Map(elList.filter(e => e.objectId).map(e => [e.objectId, e]));
    REFERENCE_MULTIPLICITY.forEach(rel => {
        // holderId -> partnerId -> how the link is expressed
        const links = new Map();
        const add = (holderId, partnerId, via) => {
            if (!holderId || !partnerId || holderId === partnerId || !byId.has(holderId) || !byId.has(partnerId)) return;
            if (!links.has(holderId)) links.set(holderId, new Map());
            const partners = links.get(holderId);
            if (!partners.has(partnerId)) partners.set(partnerId, via);
        };
        elList.forEach(({ el, objectId }) => {
            if (el.closest && el.closest("ShapeCatalogue")) return;
            directChildrenByTag(el, "Association").forEach(a => {
                const type = a.getAttribute("Type") || "";
                const other = a.getAttribute("ItemID");
                if (rel.forward.includes(type)) add(objectId, other, `"${type}"`);
                else if (rel.inverse.includes(type)) add(other, objectId, `"${type}" on ${objectId}`);
            });
            if (rel.nesting) {
                const parent = el.parentElement?.closest?.("[ID]");
                if (parent && parent.tagName !== "Drawing") add(objectId, parent.getAttribute("ID"), "XML nesting");
            }
        });
        links.forEach((partners, holderId) => {
            const holder = byId.get(holderId);
            if (!holder.componentClass || !rdl.classes[holder.componentClass]) return;
            const inherited = resolveInheritedProperties(holder.componentClass);
            const byProp = new Map(); // prop short name -> [{ id, via }]
            partners.forEach((via, partnerId) => {
                const partnerClass = byId.get(partnerId).componentClass;
                const prop = rel.props.find(p => {
                    const info = inherited.get(p);
                    return info && info.kind === "Object" && partnerClass && classDescendsFrom(partnerClass, info.valueType);
                });
                if (!prop) return;
                if (!byProp.has(prop)) byProp.set(prop, []);
                byProp.get(prop).push({ id: partnerId, via });
            });
            byProp.forEach((list, prop) => {
                const info = inherited.get(prop);
                if (typeof info.upper !== "number" || list.length <= info.upper) return;
                findings.push({
                    severity: "error", code: "MDL-MUL-03", category: "reference-multiplicity", objectId: holderId, componentClass: holder.componentClass,
                    message: `${info.owner}.${prop} allows at most ${info.upper} ${info.valueType}, but ${list.length} objects are linked: ${list.map(l => `${l.id} (${l.via})`).join(", ")}.`,
                });
            });
        });
    });
    return findings;
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
    // A direct match counts only for a DEXPI 1.4 class; a profile-only class
    // (e.g. ThreadedPipeCap) is reached through a Custom<X> type URI.
    if (rdl.classes[componentClass] && (componentClass === expectedClass || classDescendsFrom(componentClass, expectedClass))) return true;
    const typeUri = customTypeUri(el);
    const resolved = typeUri ? profileClassIndex.get(typeUri) : null;
    if (!resolved) return false;
    return resolved.name === expectedClass || resolved.superTypes.some(st => st.split(".").pop() === expectedClass);
}

// ---- Attribute scope (class-aware name check) ------------------------------
//
// An attribute in DexpiAttributes / DexpiCustomAttributes is valid only when
// its AttributeURI is the MetaData/rdl_uri of a property declared for the
// class it is used with, directly or via a supertype:
//  - DEXPI 1.4 model properties of the ComponentClass and its ancestors
//    (rdl_uri from dexpiRdlUris.json);
//  - DataProperties of the TypeURIAssignmentClass profile class and its
//    profile superType chain, plus the model properties of the Plant class
//    that chain ends in;
//  - DataProperties of every ClassExtension whose baseType is one of those
//    classes.
// The rdl_uri is the only link; the attribute Name is not matched. An
// attribute with no AttributeURI, or a vendor AttributeURI, is not valid.
// The one exception is a DEXPI 1.x "<Name>AssignmentClass" reference to a
// profile list (enumListFor()): the profile's ReferenceProperties carry no
// rdl_uri, so those are matched by name.

function readProfileDataProperties(classEl, enumListClasses) {
    const uris = new Set(), enumRefs = new Map(); // ref name -> list class
    const propNameByUri = new Map(); // rdl_uri -> DataProperty name
    // A ReferenceProperty to an enumerated list (a class whose values are
    // Objects in the profile, e.g. ProcessInstrumentationFunctionTypeCode).
    directChildrenByTag(classEl, "ReferenceProperty").forEach(rp => {
        const target = directChildrenByTag(rp, "ClassReference")[0]?.getAttribute("type") || "";
        const name = rp.getAttribute("name");
        if (name && enumListClasses.has(lastSegment(target))) enumRefs.set(name, lastSegment(target));
    });
    directChildrenByTag(classEl, "DataProperty").forEach(dp => {
        directChildrenByTag(dp, "Data")
            .filter(d => d.getAttribute("property") === "MetaData/rdl_uri")
            .forEach(d => {
                const t = directChildrenByTag(d, "String")[0]?.textContent?.trim();
                if (t) { uris.add(t); propNameByUri.set(t, dp.getAttribute("name") || ""); }
            });
    });
    return { uris, enumRefs, propNameByUri };
}

// { classProps: Map(profileClassName -> {uris, enumRefs, propNameByUri}),
//   extProps: Map(baseType last segment -> {uris, enumRefs, propNameByUri, extNames}),
//   allUris: Set (every DataProperty rdl_uri in the profile), enumValues: Map }
export function buildProfileAttributeIndex(discDoc) {
    // enumValues: list class -> accepted values (each Object's name and its Abbreviation).
    const index = { classProps: new Map(), extProps: new Map(), allUris: new Set(), enumValues: new Map() };
    if (!discDoc) return index;
    qsa(discDoc, "Object[type]").forEach(o => {
        const cls = lastSegment(o.getAttribute("type"));
        const values = index.enumValues.get(cls) || new Set();
        const name = o.getAttribute("name");
        if (name) values.add(name);
        directChildrenByTag(o, "Data")
            .filter(d => d.getAttribute("property") === "Abbreviation")
            .forEach(d => { const t = directChildrenByTag(d, "String")[0]?.textContent?.trim(); if (t) values.add(t); });
        index.enumValues.set(cls, values);
    });
    const enumListClasses = new Set(index.enumValues.keys());
    const add = (map, key, props, extName) => {
        const hit = map.get(key) || { uris: new Set(), enumRefs: new Map(), propNameByUri: new Map(), extNames: new Set() };
        props.uris.forEach(u => { hit.uris.add(u); index.allUris.add(u); });
        props.enumRefs.forEach((cls, n) => hit.enumRefs.set(n, cls));
        props.propNameByUri.forEach((n, u) => hit.propNameByUri.set(u, n));
        if (extName) hit.extNames.add(extName);
        map.set(key, hit);
    };
    const walk = node => Array.from(node.children || []).forEach(child => {
        const tag = child.tagName;
        if (tag === "ConcreteClass" || tag === "AbstractClass") add(index.classProps, child.getAttribute("name") || "", readProfileDataProperties(child, enumListClasses));
        else if (tag === "ClassExtension") add(index.extProps, lastSegment(child.getAttribute("baseType") || ""), readProfileDataProperties(child, enumListClasses), child.getAttribute("name") || "");
        walk(child);
    });
    walk(discDoc.documentElement);
    return index;
}

const REVERSE_RENAMES = new Map([...VERSION_RENAMES].map(([a, b]) => [b, a]));

// ---- Class resolution by ComponentClassURI --------------------------------
//
// Like attributes, a class is linked by its rdl_uri: ComponentClassURI is
// looked up among the DEXPI 1.4 model classes (dexpiRdlUris.json), then the
// DiscProfile.xml classes. When it resolves to a model class, that class is
// the one the model checks run against; ComponentClass is used only when
// the URI is missing or resolves to nothing. A ComponentClass that disagrees
// with its URI, or a URI that resolves to nothing while the model has an
// rdl_uri for the ComponentClass, is PRF-EXT-04.
const MODEL_CLASS_BY_URI = new Map(Object.entries(rdlUris.classes).map(([name, uri]) => [uri, name]));

function resolveClassByUri(el, profileClassIndex) {
    const uri = el.getAttribute("ComponentClassURI") || "";
    if (!uri) return { uri, name: null, source: null };
    const model = MODEL_CLASS_BY_URI.get(uri);
    if (model) return { uri, name: model, source: "model" };
    const profile = profileClassIndex?.get(uri);
    if (profile) return { uri, name: profile.name, source: "profile" };
    return { uri, name: null, source: null };
}

// The class the model checks run against (see above).
function effectiveComponentClass(el, profileClassIndex) {
    const resolved = resolveClassByUri(el, profileClassIndex);
    return resolved.source === "model" ? resolved.name : (el.getAttribute("ComponentClass") || "");
}

// PRF-EXT-04 finding for an element, or null.
function describeClassUriDisagreement(el, profileClassIndex) {
    const componentClass = el.getAttribute("ComponentClass") || "";
    const resolved = resolveClassByUri(el, profileClassIndex);
    if (!resolved.uri || !componentClass) return null;
    const sameName = n => n === componentClass || REVERSE_RENAMES.get(n) === componentClass || VERSION_RENAMES.get(n) === componentClass;
    if (resolved.name) {
        if (sameName(resolved.name)) return null;
        return resolved.source === "model"
            ? `ComponentClassURI ${resolved.uri} is the rdl_uri of DEXPI 1.4 class "${resolved.name}", not of ComponentClass "${componentClass}"; the model checks use "${resolved.name}".`
            : `ComponentClassURI ${resolved.uri} is the rdl_uri of DiscProfile.xml class "${resolved.name}", not of ComponentClass "${componentClass}".`;
    }
    const expected = rdlUris.classes[componentClass];
    if (expected) return `ComponentClassURI ${resolved.uri} is not the rdl_uri of any DEXPI 1.4 model or DiscProfile.xml class; the model lists ${expected} for "${componentClass}".`;
    return null;
}

// DEXPI 1.4 class plus its model ancestors, with 2.0 renames alongside.
function modelAncestors(className, out) {
    const cls = REVERSE_RENAMES.get(className) || className;
    if (!cls || out.has(cls)) return;
    out.add(cls);
    if (VERSION_RENAMES.has(cls)) out.add(VERSION_RENAMES.get(cls));
    (rdl.classes[cls]?.superTypes || []).forEach(st => modelAncestors(st, out));
}

// Everything that makes an attribute valid on this element:
//   uris          - every rdl_uri in scope (model properties + profile DataProperties)
//   modelByUri    - rdl_uri -> DEXPI 1.4 model property (for enum/cardinality checks)
//   propNameByUri - rdl_uri -> property name (model or profile), for PRF-SCP-02
//   classNames    - the element's class, its ancestors (1.4 and 2.0 names), its
//                   profile class chain and the ClassExtensions on those, for PRF-SCP-02
//   enumRefs      - profile list references, by name (see enumListFor())
function attributeScope(el, componentClass, profileClassIndex, attrIndex) {
    const modelClasses = new Set();
    modelAncestors(componentClass, modelClasses);
    const uris = new Set(), modelByUri = new Map(), propNameByUri = new Map(), enumRefs = new Map(), classNames = new Set();
    const addProps = p => {
        if (!p) return;
        p.uris.forEach(u => uris.add(u));
        p.propNameByUri.forEach((n, u) => propNameByUri.set(u, n));
        p.enumRefs.forEach((cls, n) => enumRefs.set(n, cls));
        p.extNames?.forEach(n => classNames.add(n));
    };

    const typeUri = customTypeUri(el);
    // A wrapper exception (Thermowell on CustomInlineMeasuringElement) takes
    // the attributes of the wrapper's class, not of the profile class.
    const resolved = typeUri && !isTypeUriWrapperException(componentClass, typeUri) ? profileClassIndex.get(typeUri) : null;
    if (resolved) {
        classNames.add(resolved.name);
        addProps(attrIndex.classProps.get(resolved.name));
        profileSuperTypeChain(resolved, profileClassIndex).forEach(st => {
            const seg = lastSegment(st);
            classNames.add(seg);
            if (attrIndex.classProps.has(seg) && !rdl.classes[seg]) addProps(attrIndex.classProps.get(seg));
            else modelAncestors(seg, modelClasses);
        });
    }
    modelClasses.forEach(cls => {
        classNames.add(cls);
        if (rdl.classes[cls]) resolveInheritedProperties(cls).forEach(propInfo => {
            if (!propInfo.rdlUri) return;
            uris.add(propInfo.rdlUri);
            if (!modelByUri.has(propInfo.rdlUri)) modelByUri.set(propInfo.rdlUri, propInfo);
            if (!propNameByUri.has(propInfo.rdlUri)) propNameByUri.set(propInfo.rdlUri, propInfo.full.split(".").pop());
        });
        addProps(attrIndex.extProps.get(cls));
    });
    return { uris, modelByUri, propNameByUri, classNames, enumRefs };
}

// PRF-SCP-02: the DISC profile's AllowedProperties entries are class-qualified
// (<Package>.<Class>.<Property>). An attribute is allowed on an element when
// some entry names its property on the element's class, one of its ancestors,
// its profile class chain, or a ClassExtension on one of those. The property
// is identified through the AttributeURI (rdl_uri) when it resolves in the
// element's scope; a DEXPI 1.x "<Name>AssignmentClass" list reference by its
// bare name; anything unresolved by its bare name as a last resort.
function makeAllowedPropertyCheck(profileFacts, profileClassIndex, attrIndex, dexpi1x) {
    const scopes = new Map();
    const scopeOf = (el, componentClass) => {
        let scope = scopes.get(el);
        if (!scope) { scope = attributeScope(el, componentClass, profileClassIndex, attrIndex); scopes.set(el, scope); }
        return scope;
    };
    return (el, componentClass, ga, bare) => {
        const scope = scopeOf(el, componentClass);
        const attrUri = ga.getAttribute("AttributeURI") || "";
        const name = (ga.getAttribute("Name") || "").trim();
        const prop = (attrUri && scope.propNameByUri.get(attrUri))
            || (enumListFor(scope, name, dexpi1x) ? name.slice(0, -ASSIGNMENT_CLASS_SUFFIX.length) : bare);
        for (const cls of scope.classNames) {
            if (profileFacts.allowedClassProperties.has(`${cls}.${prop}`)) return true;
        }
        return false;
    };
}

// An enumerated-list reference is carried in a DEXPI 1.x file as a
// "<Name>AssignmentClass" attribute (e.g. TypeCodeAssignmentClass on
// ProcessInstrumentationFunction); that form only.
const ASSIGNMENT_CLASS_SUFFIX = "AssignmentClass";

function attributeInScope(scope, name, attrUri, dexpi1x = false) {
    if (!!attrUri && scope.uris.has(attrUri)) return true;
    return !!enumListFor(scope, name, dexpi1x);
}

// The profile list class a "<Name>AssignmentClass" attribute refers to, or null.
function enumListFor(scope, name, dexpi1x) {
    if (!dexpi1x || !name.endsWith(ASSIGNMENT_CLASS_SUFFIX)) return null;
    return scope.enumRefs.get(name.slice(0, -ASSIGNMENT_CLASS_SUFFIX.length)) || null;
}

// A list value is accepted as the value's name or its Abbreviation. An
// empty value (no selection) is accepted.
function enumListValueValid(attrIndex, listClass, value) {
    const values = attrIndex.enumValues.get(listClass);
    const v = (value || "").trim();
    return !v || !values || values.has(v);
}

// ---- Element usage (Export Element…) ---------------------------------------
//
// Per document: every class used and every DexpiAttributes /
// DexpiCustomAttributes attribute, with the same validity rules as
// validateAgainstRdl(). An element with TypeURIAssignmentClass is counted
// under the profile class it maps to (superType from DiscProfile.xml);
// otherwise under its ComponentClass (superType from the DEXPI 1.4 model).
//
// Returns { classes: [{className, superType, rdlUri, count, valid}],
//           attributes: [{className, superType, attribute, rdlUri, count, valid}],
//           symbols: [{reference, className, superType, kind, count, valid}],
//           usesProfile: boolean }.
export function collectElementUsage(mainDoc, discDoc) {
    const profileClassIndex = buildProfileClassSuperTypeIndex(discDoc);
    const attrIndex = buildProfileAttributeIndex(discDoc);
    const dexpi1x = isDexpi1x(mainDoc);
    const profileFacts = buildProfileFacts(discDoc);
    const classes = new Map();
    const attributes = new Map();
    const bump = (map, key, row) => {
        const hit = map.get(key);
        if (hit) hit.count++;
        else map.set(key, { ...row, count: 1 });
    };

    collectValidatableElements(mainDoc).forEach(el => {
        const componentClass = effectiveComponentClass(el, profileClassIndex);
        const classInfo = rdl.classes[componentClass];
        const typeUri = customTypeUri(el);
        let className, superType, rdlUri, valid;

        if (typeUri) {
            const resolved = discDoc ? profileClassIndex.get(typeUri) : null;
            rdlUri = typeUri;
            if (resolved) {
                className = resolved.name;
                superType = resolved.superTypes.join(" ");
                valid = resolved.kind !== "Abstract"
                    && !describeComponentClassTypeUriMismatch(el, componentClass, profileClassIndex, profileFacts).reason
                    && (!isVesselComponentType(el, componentClass, profileClassIndex) || isVesselComponentPlacementValid(el));
            } else {
                className = findAttributeInSet(el, CUSTOM_CLASS_ATTR_SET, "TypeNameAssignmentClass")?.getAttribute("Value") || typeUri;
                superType = "";
                valid = false;
            }
        } else {
            className = componentClass;
            superType = (classInfo?.superTypes || []).join(" ");
            // The model's rdl_uri for the class; what the file claims if the model has none.
            rdlUri = rdlUris.classes[componentClass] || el.getAttribute("ComponentClassURI") || "";
            const isCustom = componentClass.startsWith(CUSTOM_CLASS_PREFIX) && componentClass.length > CUSTOM_CLASS_PREFIX.length;
            valid = !!classInfo && classInfo.kind !== "Abstract" && !isCustom && !describeClassUriDisagreement(el, profileClassIndex);
        }
        bump(classes, `${className}\u0000${superType}\u0000${rdlUri}\u0000${valid}`, { className, superType, rdlUri, valid });

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
                else if (enumListFor(scope, name, dexpi1x)) attrValid = enumListValueValid(attrIndex, enumListFor(scope, name, dexpi1x), ga.getAttribute("Value"));
                else attrValid = attributeInScope(scope, name, attrUri, dexpi1x)
                    || (dexpi1x && isDexpi1xPropertyBreakAttribute(componentClass, name, attrUri));
                // Attribute RDL: the AttributeURI the file carries (the value matched against the rdl_uris).
                bump(attributes, `${className}\u0000${superType}\u0000${name}\u0000${attrUri}\u0000${attrValid}`,
                    { className, superType, attribute: name, rdlUri: attrUri, valid: attrValid });
            });
        });
    });

    // Symbols: every placed object and <Label> with a ComponentName, the
    // symbol identified by its SymbolRegistrationNumber. Valid when that
    // resolves in the profile catalogue (PRF-SYM-01, placed objects only)
    // and, if the profile gives the symbol a usage class, the object's class
    // satisfies it (PRF-SYM-02). No usage setting -> valid.
    const symbols = new Map();
    const registrationIndex = buildSymbolRegistrationIndex(mainDoc);
    const symbolUsageIndex = buildSymbolUsageIndex(discDoc);
    const checkCatalogue = profileFacts.hasProfile && profileFacts.symbolNames.size > 0;
    // SuperType of the listed class: from the DEXPI 1.4 model, else from the
    // profile class of that name (a profile-only class such as ThreadedPipeCap).
    const profileClassByName = new Map([...profileClassIndex.values()].map(info => [info.name, info]));
    const superTypeOf = cls => (rdl.classes[cls]?.superTypes || profileClassByName.get(cls)?.superTypes || []).join(" ");
    // `cls` is checked against the symbol's usage; `shownClass` is what the
    // sheet lists (for a label, the class of the object using the label).
    const addSymbol = (el, kind, cls, shownClass = cls) => {
        const { raw, registered, profileSymbol, usageKey } = resolveSymbolReference(el, registrationIndex, profileFacts);
        if (!raw) return;
        let valid = kind === "Label" || !checkCatalogue || !!profileSymbol;
        const usage = usageKey ? symbolUsageIndex.get(usageKey) : null;
        if (valid && usage && classIsResolvable(usage, profileClassIndex)) {
            valid = classSatisfiesConstraint(el, cls, usage, profileClassIndex);
        }
        const reference = profileSymbol || registered || raw;
        const superType = superTypeOf(shownClass);
        bump(symbols, `${reference}\u0000${shownClass}\u0000${kind}\u0000${valid}`, { reference, className: shownClass, superType, kind, valid });
    };
    collectValidatableElements(mainDoc).forEach(el => addSymbol(el, "Symbol", el.getAttribute("ComponentClass") || ""));
    const elementById = buildElementByIdIndex(mainDoc);
    // The object a label belongs to: the element it is nested in, else the
    // object its text references (ObjectAttributesReference/@ItemID).
    const labelOwnerClass = el => {
        const parent = el.parentElement?.closest?.("[ComponentClass]");
        if (parent && parent.tagName !== "Label") return parent.getAttribute("ComponentClass");
        const ref = qsa(el, "ObjectAttributesReference[ItemID]")[0];
        const target = ref ? elementById.get(ref.getAttribute("ItemID")) : null;
        return target?.getAttribute("ComponentClass") || "";
    };
    qsa(mainDoc, "Label[ComponentName]").forEach(el => {
        if (el.closest && el.closest("ShapeCatalogue")) return;
        const labelClass = el.getAttribute("ComponentClass") || "";
        addSymbol(el, "Label", labelClass, labelOwnerClass(el) || labelClass);
    });

    // Symbol validity is a profile rule: only meaningful for a file that
    // uses the profile (same test as the DISC-scoped codes).
    const usesProfile = profileFacts.hasProfile && detectDiscClaim(mainDoc, profileFacts).claims;

    return { classes: [...classes.values()], attributes: [...attributes.values()], symbols: [...symbols.values()], usesProfile };
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
    const resolveConnectionTarget = buildConnectionTargetResolver(mainDoc, elementById);
    const symbolRegistrationIndex = buildSymbolRegistrationIndex(mainDoc);
    const symbolUsageIndex = buildSymbolUsageIndex(discDoc);
    // Class-scoped DiscProfile.xml DataProperties, for the attribute-name check below.
    const profileAttrIndex = buildProfileAttributeIndex(discDoc);
    const dexpi1x = isDexpi1x(mainDoc);
    // DiscProfile.xml's own Profile/Symbol catalogue (keyed "DiscProfile/<name>"),
    // used by checkLabelTextTemplates() below. Empty when no DiscProfile.xml
    // is loaded.
    const symbolMap = parseSymbolCatalogue(discDoc);
    // Every profile-derived fact this run needs, read once from the profile
    // that was actually loaded.
    const profileFacts = buildProfileFacts(discDoc);

    let classUriDisagreementCount = 0;
    let unknownClassCount = 0, unknownAttrCount = 0, malformedNameCount = 0,
        invalidEnumCount = 0, cardinalityCount = 0, extensionAttrCount = 0, profileExtensionAttrCount = 0,
        customClassCheckedCount = 0, customClassUnresolvedCount = 0,
        customClassAttrMissingCount = 0, typeUriUnresolvedCount = 0,
        componentClassMismatchCheckedCount = 0, componentClassMismatchCount = 0,
        signalFlowClassMissingCount = 0, signalFlowClassInvalidCount = 0,
        componentClassMissingCount = 0, componentClassUriMissingCount = 0,
        signalEndpointUnresolvedCount = 0, signalEndpointInvalidCount = 0,
        actuatingConnectorCheckedCount = 0, actuatingConnectorInvalidCount = 0,
        missingSignalConnectionCount = 0, pipingNodeOwnerNoNodeCount = 0, pipingNodeOwnerNoConnectionCount = 0,
        transmissionSystemCheckedCount = 0, transmissionSystemParentIssueCount = 0, transmissionSystemDriveChainIssueCount = 0,
        vesselComponentCheckedCount = 0, vesselComponentParentIssueCount = 0,
        pifSymbolAttrCheckedCount = 0, pifSymbolAttrMissingCount = 0,
        zeroScaleSymbolCheckedCount = 0, zeroScaleSymbolCount = 0,
        textTemplateAttrCheckedCount = 0, textTemplateAttrInvalidCount = 0,
        abstractClassUsedCount = 0, abstractComponentClassUsedCount = 0,
        genericAttributesNumberCheckedCount = 0, genericAttributesNumberMismatchCount = 0,
        persistentIdContextCheckedCount = 0, persistentIdContextDuplicateCount = 0,
        referenceCheckedCount = 0, referenceUnresolvedCount = 0, cycleCount = 0;

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

    // ---- Unresolved in-file reference check ------------------------------
    //
    // ItemID (xs:IDREF) must name an ID in the file; libxml2 does not enforce
    // this during schema validation. Connection FromID/ToID may carry either
    // an ID or a TagName (Nozzles as "<EquipmentTag>-<NozzleTag>").
    const tagNames = new Set();
    qsa(mainDoc, "[TagName]").forEach(el => {
        const tag = el.getAttribute("TagName");
        if (!tag || el.tagName === "Association") return; // a reference, not a declaration
        tagNames.add(tag);
        if (el.tagName !== "Nozzle") return;
        const equipTag = el.parentElement?.closest?.("[TagName]")?.getAttribute("TagName");
        if (equipTag) tagNames.add(`${equipTag}-${tag}`);
    });
    const reportUnresolved = (el, attr, value, alsoTag) => {
        referenceCheckedCount++;
        if (elementById.has(value) || (alsoTag && tagNames.has(value))) return;
        referenceUnresolvedCount++;
        const ownerEl = el.closest ? el.closest("[ID]") : null;
        const objectId = ownerEl ? ownerEl.getAttribute("ID") : null;
        const componentClass = ownerEl ? ownerEl.getAttribute("ComponentClass") : null;
        const where = ownerEl === el ? "" : ` on <${el.tagName}>`;
        findings.push({
            severity: "warning", code: "SER-IDN-03", category: "unresolved-reference", objectId, componentClass,
            message: `${attr}="${value}"${where} does not match any ID${alsoTag ? " or TagName" : ""} in the file.`,
        });
    };
    qsa(mainDoc, "[ItemID]").forEach(el => {
        const value = el.getAttribute("ItemID");
        if (value) reportUnresolved(el, "ItemID", value, false);
    });
    qsa(mainDoc, "Connection").forEach(el => {
        ["FromID", "ToID"].forEach(attr => {
            const value = el.getAttribute(attr);
            if (value) reportUnresolved(el, attr, value, true);
        });
    });

    // Node indices: Connection FromNode/ToNode and ConnectionPoints
    // FlowIn/FlowOut index the target's ConnectionPoints Nodes from 0.
    const reportBadIndex = (ownerSource, message) => {
        referenceUnresolvedCount++;
        const ownerEl = ownerSource.closest ? ownerSource.closest("[ID]") : null;
        findings.push({
            severity: "warning", code: "SER-IDN-03", category: "unresolved-node-index",
            objectId: ownerEl ? ownerEl.getAttribute("ID") : null,
            componentClass: ownerEl ? ownerEl.getAttribute("ComponentClass") : null,
            message,
        });
    };
    const nodeCount = el => {
        const cp = directChildrenByTag(el, "ConnectionPoints")[0];
        return cp ? directChildrenByTag(cp, "Node").length : 0;
    };
    qsa(mainDoc, "Connection").forEach(el => {
        [["FromID", "FromNode"], ["ToID", "ToNode"]].forEach(([idAttr, nodeAttr]) => {
            const raw = el.getAttribute(nodeAttr);
            const ref = el.getAttribute(idAttr);
            if (raw == null || !ref) return;
            const target = resolveConnectionTarget(ref);
            if (!target) return; // unresolved ID already reported above
            if (!directChildrenByTag(target, "ConnectionPoints")[0]) return; // e.g. a segment: no node list to index
            referenceCheckedCount++;
            const idx = parseInt(raw, 10), n = nodeCount(target);
            if (Number.isInteger(idx) && idx >= 0 && idx < n) return;
            reportBadIndex(el, `${nodeAttr}="${raw}" on <Connection> does not match a Node of ${idAttr}="${ref}", which has ${n} Node${n === 1 ? "" : "s"} (indexed from 0).`);
        });
    });
    qsa(mainDoc, "ConnectionPoints").forEach(cp => {
        const n = directChildrenByTag(cp, "Node").length;
        ["FlowIn", "FlowOut"].forEach(attr => {
            const raw = cp.getAttribute(attr);
            if (raw == null) return;
            referenceCheckedCount++;
            const idx = parseInt(raw, 10);
            if (Number.isInteger(idx) && idx >= 0 && idx < n) return;
            reportBadIndex(cp, `ConnectionPoints ${attr}="${raw}" does not match any of its ${n} Node${n === 1 ? "" : "s"} (indexed from 0).`);
        });
    });

    // Association TagName / PersistentID references (ItemReferenceGroup).
    const persistentIds = new Set(qsa(mainDoc, "PersistentID").map(p => `${p.getAttribute("Context") || ""}\u0000${p.getAttribute("Identifier") || ""}`));
    const persistentIdentifiers = new Set(qsa(mainDoc, "PersistentID").map(p => p.getAttribute("Identifier") || ""));
    qsa(mainDoc, "Association").forEach(el => {
        const tag = el.getAttribute("TagName");
        if (tag) {
            referenceCheckedCount++;
            if (!tagNames.has(tag)) {
                referenceUnresolvedCount++;
                const ownerEl = el.closest ? el.closest("[ID]") : null;
                findings.push({
                    severity: "warning", code: "SER-IDN-03", category: "unresolved-reference",
                    objectId: ownerEl ? ownerEl.getAttribute("ID") : null, componentClass: ownerEl ? ownerEl.getAttribute("ComponentClass") : null,
                    message: `TagName="${tag}" on <Association> does not match any TagName in the file.`,
                });
            }
        }
        const pid = el.getAttribute("PersistentIDIdentifier");
        if (pid) {
            referenceCheckedCount++;
            const ctx = el.getAttribute("PersistentIDContext");
            const ok = ctx != null ? persistentIds.has(`${ctx}\u0000${pid}`) : persistentIdentifiers.has(pid);
            if (!ok) {
                referenceUnresolvedCount++;
                const ownerEl = el.closest ? el.closest("[ID]") : null;
                findings.push({
                    severity: "warning", code: "SER-IDN-03", category: "unresolved-reference",
                    objectId: ownerEl ? ownerEl.getAttribute("ID") : null, componentClass: ownerEl ? ownerEl.getAttribute("ComponentClass") : null,
                    message: `PersistentIDIdentifier="${pid}"${ctx != null ? ` PersistentIDContext="${ctx}"` : ""} on <Association> does not match any PersistentID in the file.`,
                });
            }
        }
    });

    // ---- Cyclic dependency check (MDL-CYC-01) ---------------------------
    //
    // Whole-part, location, drive and fulfilment relations must not loop
    // back on themselves. Edges point from the dependent object to the one
    // it depends on (part -> whole, located -> location, driven -> driver,
    // fulfiller -> fulfilled); inverse Association types are flipped.
    // XML nesting counts as part -> whole. Flow, signal and connection
    // relations are excluded: loops there are legitimate (recycles, control
    // loops).
    {
        const CYCLE_RELATIONS = {
            "whole-part": { forward: ["is a part of", "is a component of", "is an element of", "is contained in"],
                            inverse: ["is a collection including", "is an assembly including", "is a composition including", "contains"] },
            "location": { forward: ["is located in"], inverse: ["is the location of"] },
            "drive": { forward: ["is driven by"], inverse: ["drives"] },
            "fulfilment": { forward: ["fulfills"], inverse: ["is fulfilled by"] },
        };
        // Self-references: a Connection end, or a signal Source/Target, that
        // points back at the element owning it.
        const reportSelf = (ownerEl, message) => {
            cycleCount++;
            findings.push({
                severity: "warning", code: "MDL-CYC-01", category: "self-reference",
                objectId: ownerEl.getAttribute("ID"), componentClass: ownerEl.getAttribute("ComponentClass") || null, message,
            });
        };
        qsa(mainDoc, "Connection").forEach(conn => {
            const ownerEl = conn.parentElement?.closest?.("[ID]");
            if (!ownerEl) return;
            [["FromID", "FromNode"], ["ToID", "ToNode"]].forEach(([idAttr, nodeAttr]) => {
                const ref = conn.getAttribute(idAttr);
                if (!ref || resolveConnectionTarget(ref) !== ownerEl) return;
                const node = conn.getAttribute(nodeAttr);
                reportSelf(ownerEl, `<Connection> ${idAttr}="${ref}"${node ? ` ${nodeAttr}="${node}"` : ""} refers back to the ${ownerEl.tagName} that owns the connection.`);
            });
        });
        collectInformationFlowElements(mainDoc).forEach(flow => {
            const id = flow.getAttribute("ID");
            directChildrenByTag(flow, "Association").forEach(a => {
                const type = a.getAttribute("Type") || "";
                if ((type === "has logical start" || type === "has logical end") && a.getAttribute("ItemID") === id)
                    reportSelf(flow, `${type === "has logical start" ? "Source" : "Target"} ("${type}") refers back to the InformationFlow itself.`);
            });
        });

        const graphs = Object.fromEntries(Object.keys(CYCLE_RELATIONS).map(k => [k, new Map()]));
        const addEdge = (kind, from, to) => {
            const g = graphs[kind];
            if (!g.has(from)) g.set(from, new Set());
            g.get(from).add(to);
        };
        qsa(mainDoc, "[ID]").forEach(el => {
            if (el.closest && el.closest("ShapeCatalogue")) return;
            const id = el.getAttribute("ID");
            const parent = el.parentElement?.closest?.("[ID]");
            if (parent && parent.tagName !== "Drawing") addEdge("whole-part", id, parent.getAttribute("ID"));
            directChildrenByTag(el, "Association").forEach(a => {
                const type = a.getAttribute("Type") || "";
                const other = a.getAttribute("ItemID");
                if (!other || !elementById.has(other)) return;
                for (const [kind, rel] of Object.entries(CYCLE_RELATIONS)) {
                    if (rel.forward.includes(type)) addEdge(kind, id, other);
                    else if (rel.inverse.includes(type)) addEdge(kind, other, id);
                }
            });
        });
        for (const [kind, g] of Object.entries(graphs)) {
            const state = new Map(); // 1 = on stack, 2 = done
            const stack = [];
            const seen = new Set();
            const visit = start => {
                const iters = [[start, [...(g.get(start) || [])][Symbol.iterator]()]];
                state.set(start, 1); stack.push(start);
                while (iters.length) {
                    const [node, it] = iters[iters.length - 1];
                    const nx = it.next();
                    if (nx.done) { state.set(node, 2); stack.pop(); iters.pop(); continue; }
                    const next = nx.value;
                    if (state.get(next) === 1) {
                        const cycle = stack.slice(stack.indexOf(next));
                        const key = [...cycle].sort().join("\u0000");
                        if (seen.has(key)) continue;
                        seen.add(key);
                        cycleCount++;
                        const first = elementById.get(cycle[0]);
                        findings.push({
                            severity: "warning", code: "MDL-CYC-01", category: `cyclic-${kind}`,
                            objectId: cycle[0], componentClass: first ? first.getAttribute("ComponentClass") : null,
                            message: cycle.length === 1
                                ? `Object refers to itself in a ${kind} relation.`
                                : `Cyclic ${kind} relation: ${[...cycle, cycle[0]].join(" \u2192 ")}.`,
                        });
                    } else if (!state.get(next)) {
                        state.set(next, 1); stack.push(next);
                        iters.push([next, [...(g.get(next) || [])][Symbol.iterator]()]);
                    }
                }
            };
            for (const node of g.keys()) if (!state.get(node)) visit(node);
        }
    }

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
                severity: "error", code: "MDL-CLS-05", category: "componentclass-missing", objectId, componentClass: null,
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

        // Actuating signal connector endpoint check - see ACTUATOR_CLASSES above.
        {
            const endClass = type => {
                const a = findDirectAssociation(el, type);
                const ref = a ? elementById.get(a.getAttribute("ItemID") || "") : null;
                return ref ? ref.getAttribute("ComponentClass") : null;
            };
            const sourceClass = endClass("has logical start");
            const targetClass = endClass("has logical end");
            const connection = directChildrenByTag(el, "Connection")[0] || null;
            const checkEnd = (side, fnClass, allowed, expected) => {
                actuatingConnectorCheckedCount++;
                const idAttr = `${side}ID`, nodeAttr = `${side}Node`;
                const value = connection ? connection.getAttribute(idAttr) : null;
                const endEl = value ? resolveConnectionTarget(value) : null;
                if (endEl && allowed(endEl)) return;
                actuatingConnectorInvalidCount++;
                const node = connection?.getAttribute(nodeAttr);
                const got = !connection ? "the InformationFlow has no <Connection>"
                    : !value ? `<Connection> has no ${idAttr}`
                    : !endEl ? `${idAttr}="${value}" does not resolve to any object`
                    : `${idAttr}="${value}"${node ? ` ${nodeAttr}="${node}"` : ""} is a ${endEl.tagName}${endEl.getAttribute("ComponentClass") ? ` (${endEl.getAttribute("ComponentClass")})` : ""}`;
                findings.push({
                    severity: "warning", code: "GEO-MDL-01", category: "actuating-connector-endpoint", objectId, componentClass,
                    message: `${side === "From" ? "Source" : "Target"} is ${fnClass}, so the connector's ${idAttr}/${nodeAttr} must be ${expected}, but ${got}.`,
                });
            };
            const isActuator = e => ACTUATOR_CLASSES.has(e.getAttribute("ComponentClass") || "");
            if (sourceClass === "ActuatingFunction") checkEnd("From", sourceClass, isActuator, "a ControlledActuator");
            if (targetClass === "ActuatingFunction") checkEnd("To", targetClass, isActuator, "a ControlledActuator");
            if (targetClass === "ActuatingElectricalFunction") checkEnd("To", targetClass, e => e.tagName === "Nozzle", "a Nozzle");
        }
    });

    // MDL-CLS-05: ComponentClass / ComponentClassURI missing. InformationFlow without a ComponentClass is reported above.
    // Keyed by ComponentName when the element has no ID.
    qsa(mainDoc, CLASS_BEARING_TAGS.join(", ")).forEach(el => {
        if (el.closest && el.closest("ShapeCatalogue")) return;
        if (isSymbolElement(el, el.getAttribute("ComponentClass"))) return;
        const objectId = el.getAttribute("ID") || el.getAttribute("ComponentName") || null;
        const componentClass = el.getAttribute("ComponentClass") || null;
        if (!componentClass && el.tagName !== "InformationFlow") {
            componentClassMissingCount++;
            findings.push({
                severity: "error", code: "MDL-CLS-05", category: "componentclass-missing", objectId, componentClass,
                message: `<${el.tagName}> has no ComponentClass attribute, so it cannot be mapped to a DEXPI class.`,
            });
        }
        if (!el.getAttribute("ComponentClassURI")) {
            componentClassUriMissingCount++;
            findings.push({
                severity: "error", code: "MDL-CLS-05", category: "componentclassuri-missing", objectId, componentClass,
                message: componentClass
                    ? `ComponentClass "${componentClass}" has no ComponentClassURI (RDL reference).`
                    : `<${el.tagName}> has no ComponentClassURI (RDL reference).`,
            });
        }
    });

    els.forEach(el => {
        const objectId = el.getAttribute("ID");
        // PRF-EXT-04: ComponentClass vs ComponentClassURI. The checks below
        // run against the class the URI resolves to (see effectiveComponentClass()).
        const classUriDisagreement = describeClassUriDisagreement(el, profileClassIndex);
        if (classUriDisagreement) {
            classUriDisagreementCount++;
            findings.push({
                severity: "warning", code: "PRF-EXT-04", category: "class-uri-disagreement", objectId,
                componentClass: el.getAttribute("ComponentClass"), message: classUriDisagreement,
            });
        }
        const componentClass = effectiveComponentClass(el, profileClassIndex) || null;
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

            const symbol = resolveSymbolReference(el, symbolRegistrationIndex, profileFacts).usageKey;
            const rawExpectedSymbolClass = symbol ? symbolUsageIndex.get(symbol) : null;
            const expectedSymbolClass = rawExpectedSymbolClass && classIsResolvable(rawExpectedSymbolClass, profileClassIndex) ? rawExpectedSymbolClass : null;
            let symbolEvidenceUsed = false;
            if (expectedSymbolClass) {
                checked = true;
                if (!classSatisfiesConstraint(el, componentClass, expectedSymbolClass, profileClassIndex)) {
                    symbolEvidenceUsed = true;
                    reasons.push(componentClass === expectedSymbolClass && !rdl.classes[componentClass]
                        ? `the drawn symbol "${symbol}" is for "${expectedSymbolClass}", which is a profile class, not a DEXPI 1.4 class - use a Custom class whose TypeURIAssignmentClass resolves to it`
                        : `the drawn symbol "${symbol}" is expected to be used only by "${expectedSymbolClass}" (or a Custom class whose TypeURIAssignmentClass resolves to it)`);
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
                findings.push(cmp03Finding(componentClass, "Nodes", {
                    severity: "warning", code: "MDL-CMP-03", category: "piping-node-owner-no-node", objectId, componentClass,
                    message: `${componentClass} object has no ConnectionPoints/Node (PipingNode) defined.`,
                }));
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

        // CustomEquipment-as-ProcessVesselComponent placement - see
        // isVesselComponentType() above.
        if (isVesselComponentType(el, componentClass, profileClassIndex)) {
            vesselComponentCheckedCount++;
            if (!isVesselComponentPlacementValid(el)) {
                vesselComponentParentIssueCount++;
                const parentEl = el.parentElement;
                const parentDesc = parentEl ? `<${parentEl.tagName}${parentEl.getAttribute("ComponentClass") ? ` ComponentClass="${parentEl.getAttribute("ComponentClass")}"` : ""}>` : "no parent";
                findings.push({
                    severity: "warning", code: "MDL-CMP-02", category: "vessel-component-parent", objectId, componentClass,
                    message: `CustomEquipment typed as a ProcessVesselComponent ("${profileClassIndex.get(customTypeUri(el)).name}") must be a <Component> element nested directly in a Vessel <Equipment>; found <${el.tagName}> in ${parentDesc}.`,
                });
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
                // "is driven by" is TransmissionSystem.Driver; "drives" has no model property.
                const prop = type === "is driven by" ? "Driver" : "";
                if (!assoc) {
                    transmissionSystemDriveChainIssueCount++;
                    findings.push(cmp03Finding(componentClass, prop, {
                        severity: "warning", code: "MDL-CMP-03", category: "transmission-system-drive-chain", objectId, componentClass,
                        message: `TransmissionSystem has no Association Type="${type}".`,
                    }));
                    return;
                }
                const itemId = assoc.getAttribute("ItemID");
                const refEl = itemId ? elementById.get(itemId) : null;
                if (!refEl || refEl.tagName !== "Equipment") {
                    transmissionSystemDriveChainIssueCount++;
                    findings.push(cmp03Finding(componentClass, prop, {
                        severity: "warning", code: "MDL-CMP-03", category: "transmission-system-drive-chain", objectId, componentClass,
                        message: refEl
                            ? `TransmissionSystem's "${type}" Association refers to "${itemId}", which is a <${refEl.tagName}> element, not <Equipment>.`
                            : `TransmissionSystem's "${type}" Association refers to "${itemId}", which does not resolve to any object in the document.`,
                    }));
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

        const scope = attributeScope(el, componentClass, profileClassIndex, profileAttrIndex);
        const occurrenceCounts = new Map(); // rdl_uri -> { propInfo, count }, for cardinality check

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

                // Matched by AttributeURI against the rdl_uri of the model
                // properties in scope; the Name is not used.
                const propInfo = attrUri ? scope.modelByUri.get(attrUri) : undefined;
                const shortName = propInfo ? propInfo.full.split(".").pop() : stripNameSuffix(rawName.trim());

                if (!propInfo) {
                    // DEXPI 1.x PropertyBreak attributes (see profileRules.js).
                    if (dexpi1x && isDexpi1xPropertyBreakAttribute(componentClass, rawName, attrUri)) return;
                    // Declared for this class in the profile (directly, via
                    // its profile superType chain, or a ClassExtension on
                    // one of its classes): no finding.
                    const listClass = enumListFor(scope, rawName.trim(), dexpi1x);
                    if (listClass) {
                        if (!enumListValueValid(profileAttrIndex, listClass, rawValue)) {
                            invalidEnumCount++;
                            const allowed = [...profileAttrIndex.enumValues.get(listClass)];
                            findings.push({
                                severity: "warning", code: "SER-VAL-04", category: "invalid-enum-value", objectId, componentClass,
                                message: `${rawName.trim()} = "${rawValue ?? ""}" is not a value of the DiscProfile.xml list ${listClass} (${allowed.join(", ")}).`,
                            });
                        }
                        return;
                    }
                    if (attributeInScope(scope, rawName.trim(), attrUri, dexpi1x)) {
                        profileExtensionAttrCount++;
                        return;
                    }
                    unknownAttrCount++;
                    const shortTrim = rawName.trim();
                    // The URI is a profile DataProperty rdl_uri, just not one in this class's scope.
                    const isProfileProp = !!attrUri && profileAttrIndex.allUris.has(attrUri);
                    const isDexpiNamespace = DEXPI_ATTRIBUTE_URI_NAMESPACES.some(ns => attrUri.startsWith(ns));
                    const enumRefName = stripNameSuffix(shortTrim);
                    const wrongEnumForm = dexpi1x && scope.enumRefs.has(enumRefName) && !shortTrim.endsWith(ASSIGNMENT_CLASS_SUFFIX);
                    findings.push({
                        code: isProfileProp ? "PRF-EXT-01" : isDexpiNamespace ? "MDL-PRP-05" : "MDL-PRP-01",
                        severity: "warning", category: "unknown-attribute", objectId, componentClass,
                        message: wrongEnumForm
                            ? `Attribute "${rawName}" refers to the DiscProfile.xml list "${enumRefName}" - in a DEXPI 1.x file it must be written as "${enumRefName}${ASSIGNMENT_CLASS_SUFFIX}".`
                            : !attrUri
                            ? `Attribute "${rawName}" has no AttributeURI. An attribute is matched to the DEXPI 1.4 model and the loaded DiscProfile.xml by its AttributeURI (the property's rdl_uri) only.`
                            : isProfileProp
                            ? `AttributeURI ${attrUri} of "${rawName}" is a DiscProfile.xml property rdl_uri, but not one declared for ${componentClass}, its TypeURIAssignmentClass profile class, or their supertypes/ClassExtensions.`
                            : `AttributeURI ${attrUri} of "${rawName}" is not the rdl_uri of a property declared for ${componentClass} or its supertypes in the DEXPI 1.4 model or the loaded DiscProfile.xml.`,
                    });
                    return;
                }

                const seen = occurrenceCounts.get(attrUri) || { propInfo, count: 0 };
                seen.count++;
                occurrenceCounts.set(attrUri, seen);

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
        occurrenceCounts.forEach(({ propInfo, count }, uri) => {
            if (typeof propInfo.upper === "number" && count > propInfo.upper) {
                cardinalityCount++;
                findings.push({
                    severity: "warning", code: "MDL-MUL-01", category: "cardinality", objectId, componentClass,
                    message: `${propInfo.full} (${uri}) appears ${count} times but the RDL allows at most ${propInfo.upper}.`,
                });
            }
        });
    });

    // ---- checks that read the loaded profile directly -------------------
    const elList = els.map(el => ({
        el,
        objectId: el.getAttribute("ID") || el.getAttribute("id") || "",
        componentClass: effectiveComponentClass(el, profileClassIndex),
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
    findings.push(...checkPipingLinkage(mainDoc, lookup));
    findings.push(...checkReferenceMultiplicity(elList));
    findings.push(...checkDiscScope(elList, profileFacts, DEXPI_ATTRIBUTE_SETS, {
        dexpi1x: isDexpi1x(mainDoc), isCustomObject: isCustomObjectSubtype,
        isAllowedProperty: makeAllowedPropertyCheck(profileFacts, profileClassIndex, profileAttrIndex, isDexpi1x(mainDoc)),
    }));
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
            classUriDisagreements: classUriDisagreementCount,
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
            referencesChecked: referenceCheckedCount,
            referencesUnresolved: referenceUnresolvedCount,
            cyclicDependencies: cycleCount,
            customClassesChecked: customClassCheckedCount,
            customClassUnresolved: customClassUnresolvedCount,
            typeUriUnresolved: typeUriUnresolvedCount,
            componentClassMismatchChecked: componentClassMismatchCheckedCount,
            componentClassMismatches: componentClassMismatchCount,
            signalFlowClassMissing: signalFlowClassMissingCount,
            componentClassMissing: componentClassMissingCount,
            componentClassUriMissing: componentClassUriMissingCount,
            signalFlowClassInvalid: signalFlowClassInvalidCount,
            signalEndpointUnresolved: signalEndpointUnresolvedCount,
            signalEndpointInvalid: signalEndpointInvalidCount,
            actuatingConnectorChecked: actuatingConnectorCheckedCount,
            actuatingConnectorInvalid: actuatingConnectorInvalidCount,
            missingSignalConnection: missingSignalConnectionCount,
            pipingNodeOwnerNoNode: pipingNodeOwnerNoNodeCount,
            pipingNodeOwnerNoConnection: pipingNodeOwnerNoConnectionCount,
            transmissionSystemsChecked: transmissionSystemCheckedCount,
            transmissionSystemParentIssues: transmissionSystemParentIssueCount,
            vesselComponentsChecked: vesselComponentCheckedCount,
            vesselComponentParentIssues: vesselComponentParentIssueCount,
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
