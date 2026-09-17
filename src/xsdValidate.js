// Client-side XSD Schema validation for Proteus 4.1.1 / DEXPI 1.4 XML files.
//
// Uses xmllint-wasm (libxml2 compiled to WebAssembly, run in a Web Worker) to
// perform XML Schema validation in the browser. The schema itself
// (ProteusPIDSchema 4.1.1 disc.xsd) is bundled into the app build via Vite's
// `?raw` import.
//
// The bundled schema copy (src/assets/proteus-4.1.1-disc.xsd) is adjusted for
// this tool and is the copy validation runs against.
import { validateXML } from "xmllint-wasm";
import proteusXsdSource from "./assets/proteus-4.1.1-disc.xsd?raw";

// GenericAttributes/@Set values that carry DEXPI-defined attributes.
// Vendor/tool-specific attribute groups outside this set are stripped
// before schema validation.
const DEXPI_ATTRIBUTE_SETS = new Set(["DexpiAttributes", "DexpiCustomAttributes"]);

/**
 * Strips <GenericAttributes Set="..."> groups whose Set isn't a DEXPI-owned
 * set. Removed content is replaced with the same number of blank lines, so
 * line numbers in the result match the original document.
 *
 * @param {string} xmlText
 * @returns {{ xml: string, removedCount: number, removedSets: string[] }}
 */
function stripNonDexpiGenericAttributes(xmlText) {
    let removedCount = 0;
    const removedSets = new Set();
    const keepOrBlank = (whole, attrs) => {
        const setMatch = attrs.match(/\bSet="([^"]*)"/);
        const set = setMatch ? setMatch[1] : null;
        // No Set attribute at all: leave it alone.
        if (!set || DEXPI_ATTRIBUTE_SETS.has(set)) return whole;
        removedCount++;
        removedSets.add(set);
        // Replace with the same number of newlines to keep later line
        // numbers identical to the original document.
        return "\n".repeat((whole.match(/\n/g) || []).length);
    };
    let xml = xmlText.replace(/<GenericAttributes\b([^>]*)\/>/g, keepOrBlank);
    xml = xml.replace(/<GenericAttributes\b([^>]*)>[\s\S]*?<\/GenericAttributes>/g, keepOrBlank);
    return { xml, removedCount, removedSets: [...removedSets].sort() };
}

// ─── Duplicate-ID error rewriting ──────────────────────────────────────────
// libxml2 reports a duplicate xs:ID attribute value with the same wording
// it uses for a malformed one:
//   Element 'X', attribute 'ID': 'value' is not a valid value of the atomic
//   type 'xs:ID'.
// Detects the duplicate case by checking whether the same attribute="value"
// text appears more than once in the validated document, and rewrites the
// message to say so, listing every line where the value recurs. A
// malformed ID only ever appears once and falls through unchanged.
const XS_ID_ERROR_RE = /^Element '([^']+)', attribute '([^']+)': '([^']*)' is not a valid value of the atomic type 'xs:ID'\.?$/;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Line numbers (1-based) on which `attrName="value"` literally appears. */
function findAttributeValueLines(xmlText, attrName, value) {
    const re = new RegExp(`\\b${escapeRegExp(attrName)}="${escapeRegExp(value)}"`);
    const hits = [];
    xmlText.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(i + 1); });
    return hits;
}

function rewriteDuplicateIdErrors(errors, xmlText) {
    return errors.map(err => {
        const m = err.message ? XS_ID_ERROR_RE.exec(err.message) : null;
        if (!m) return err;
        const [, elementName, attrName, idValue] = m;
        const lines = findAttributeValueLines(xmlText, attrName, idValue);
        if (lines.length < 2) return err; // only one occurrence: not a duplicate
        const message =
            `Duplicate ID value: '${idValue}' is used as the '${attrName}' attribute on ${lines.length} ` +
            `<${elementName}> elements (lines ${lines.join(", ")}), but xs:ID values must be unique within the ` +
            `document. Assign a distinct '${attrName}' to each of these elements.`;
        return { ...err, message };
    });
}

// ─── Validation codes ──────────────────────────────────────────────────────
// libxml2/xmllint-wasm reports schema violations as free-text messages.
// Each error's message is matched against the libxml2 XML Schema wording
// below and bucketed into a small set of stable codes. Rules are checked
// top to bottom, most-specific first, and the first match wins. Each rule
// also carries the classification code it maps to. issueCodes.js is the
// registry both sides draw from. `issueCode: null` means the wording was
// not recognised and stays unclassified.
const XSD_CODE_RULES = [
    { code: "xsd-duplicate-id", issueCode: "SER-IDN-01", label: "Duplicate xs:ID value", test: m => /^Duplicate ID value:/.test(m) },
    { code: "xsd-missing-required-attribute", issueCode: "SER-REQ-01", label: "Missing required attribute", test: m => /is required but missing/i.test(m) },
    { code: "xsd-unexpected-attribute", issueCode: "SER-STR-03", label: "Attribute not allowed", test: m => /attribute '[^']*' is not allowed/i.test(m) },
    { code: "xsd-missing-child-element", issueCode: "SER-REQ-02", label: "Missing required child element", test: m => /Missing child element/i.test(m) },
    { code: "xsd-unexpected-element", issueCode: "SER-STR-01", label: "Element not expected here", test: m => /This element is not expected/i.test(m) || /is not allowed to appear in element/i.test(m) },
    // An xs:ID that is malformed rather than duplicated is classified as
    // SER-IDN-02, not a generic invalid-value code.
    { code: "xsd-invalid-attribute-value", issueCode: "SER-VAL-01", label: "Invalid attribute value", test: m => /attribute '[^']*'.*is not a valid value/i.test(m) },
    { code: "xsd-invalid-content", issueCode: "SER-VAL-03", label: "Invalid element content", test: m => /content type is|character content/i.test(m) },
    { code: "xsd-no-matching-declaration", issueCode: "SER-FMT-02", label: "No matching schema declaration", test: m => /No matching global declaration/i.test(m) },
    { code: "xsd-invalid-value", issueCode: "SER-VAL-03", label: "Invalid value", test: m => /is not a valid value/i.test(m) },
];
const XSD_FALLBACK_CODE = "xsd-schema-violation";
const XSD_FALLBACK_ISSUE_CODE = null; // unrecognised wording stays unclassified
const XSD_FALLBACK_LABEL = "Other schema violation";

/** code -> display label for every XSD validation code this module can produce. */
export const XSD_CODE_LABELS = Object.fromEntries(
    XSD_CODE_RULES.map(r => [r.code, r.label]).concat([[XSD_FALLBACK_CODE, XSD_FALLBACK_LABEL]])
);

/** xsd code -> classification code, for reporting both engines in one vocabulary. */
export const XSD_ISSUE_CODES = Object.fromEntries(
    XSD_CODE_RULES.map(r => [r.code, r.issueCode]).concat([[XSD_FALLBACK_CODE, XSD_FALLBACK_ISSUE_CODE]])
);

function categorizeXsdError(message) {
    const msg = message || "";
    for (const rule of XSD_CODE_RULES) {
        if (rule.test(msg)) {
            // A malformed-but-unique xs:ID is classified as SER-IDN-02.
            const issueCode = rule.code === "xsd-invalid-attribute-value" && /'xs:ID'/.test(msg)
                ? "SER-IDN-02" : rule.issueCode;
            return { code: rule.code, codeLabel: rule.label, issueCode };
        }
    }
    return { code: XSD_FALLBACK_CODE, codeLabel: XSD_FALLBACK_LABEL, issueCode: XSD_FALLBACK_ISSUE_CODE };
}

/**
 * Validates a Proteus/DEXPI 1.4 XML document against the bundled
 * ProteusPIDSchema 4.1.1 disc.xsd.
 *
 * Only GenericAttributes groups with Set="DexpiAttributes" or
 * Set="DexpiCustomAttributes" are included in the validated document; other
 * attribute groups are stripped out first, via
 * stripNonDexpiGenericAttributes() above.
 *
 * @param {string} xmlText - raw XML file contents
 * @returns {Promise<{
 *   valid: boolean,
 *   errors: Array<{ message: string, rawMessage: string, line: number|null, code: string, codeLabel: string }>,
 *   rawOutput: string,
 *   filteredOut: { count: number, sets: string[] },
 * }>}
 */
export async function validateProteusXsd(xmlText) {
    const { xml: filteredXml, removedCount, removedSets } = stripNonDexpiGenericAttributes(xmlText);
    let result;
    try {
        result = await validateXML({
            xml: filteredXml,
            schema: proteusXsdSource,
        });
    } catch (e) {
        const raw = e?.message || String(e);
        // Fallback for a schema-compile failure: reports a clear error
        // instead of letting the exception propagate unhandled.
        if (/failed to compile|content model is not determinist|Schemas parser error/i.test(raw)) {
            const friendly = new Error(
                "Full XSD validation isn't possible in-browser right now: the bundled schema " +
                "failed to compile in this app's in-browser validation engine (libxml2), which " +
                "enforces the XML Schema spec more strictly than some other XSD processors " +
                "(e.g. Xerces, MSXML) about certain structural ambiguities. This is a schema " +
                "compatibility issue, not a bug in your loaded file."
            );
            friendly.schemaCompileError = true;
            friendly.rawMessage = raw;
            throw friendly;
        }
        throw e;
    }
    const errors = rewriteDuplicateIdErrors(
        result.errors.map(e => ({
            message: e.message,
            rawMessage: e.rawMessage,
            line: e.loc ? e.loc.lineNumber : null,
        })),
        filteredXml
    ).map(err => ({ ...err, ...categorizeXsdError(err.message) }));
    return {
        valid: result.valid,
        errors,
        rawOutput: result.rawOutput,
        filteredOut: { count: removedCount, sets: removedSets },
    };
}
