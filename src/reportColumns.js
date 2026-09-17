// Report layout shared by the findings exports.

import { ISSUE_CODES } from "./issueCodes.js";

export const REPORT_COLUMNS = [
    { header: "Classification code", width: 20 },
    { header: "Causes", width: 10 },
    { header: "Nr", width: 6 },
    { header: "Source URI", width: 22 },
    { header: "File", width: 38 },
    { header: "Line", width: 9 },
    { header: "Location", width: 38 },
    { header: "Level", width: 10 },
    { header: "Type", width: 16 },
    { header: "Description", width: 100 },
];

const LAYER_TYPE = {
    SER: "Schema Error",
    MDL: "Model Error",
    PRF: "Profile Error",
    GEO: "Geometry Error",
};

/** Element and attribute named by a schema validator message. */
export function locationFromXsd(message) {
    const m = /Element\s+'([^']+)'(?:\s*,\s*attribute\s+'([^']+)')?/i.exec(String(message || ""));
    if (!m) return "";
    return m[2] ? `<${m[1]}>, attribute "${m[2]}"` : `<${m[1]}>`;
}

/** Element tag, plus the attribute a model finding names. */
export function locationFromModel(tagName, message) {
    if (!tagName) return "";
    const m = /(?:GenericAttribute|[Aa]ttribute|property)\s+"([^"]+)"/.exec(String(message || ""));
    return m ? `<${tagName}>, attribute "${m[1]}"` : `<${tagName}>`;
}

/** id -> element tag name, for every element carrying an ID. */
export function buildTagIndex(doc) {
    const map = new Map();
    if (!doc) return map;
    let els = [];
    try { els = doc.querySelectorAll("[ID], [id]"); } catch { return map; }
    for (const el of els) {
        const id = el.getAttribute("ID") || el.getAttribute("id");
        if (id && !map.has(id)) map.set(id, el.tagName);
    }
    return map;
}

/**
 * Flattens per-file findings into report rows.
 *
 * @param {Array<{path:string, findings:Array, error?:string}>} files
 * @param {(code:string) => string} typeOf - resolved Error/Warning/Info label
 */
export function buildReportRows(files, typeOf) {
    const rows = [];
    for (const f of files) {
        let nr = 0;
        if (f.error) {
            rows.push(["", "", ++nr, "", f.path, "", "", "ERROR", "File Error", f.error]);
            continue;
        }
        for (const finding of f.findings || []) {
            const code = finding.code || "";
            const meta = ISSUE_CODES[code] || {};
            rows.push([
                code,
                "",
                ++nr,
                finding.sourceUri || "",
                f.path,
                finding.line ?? "",
                finding.location || "",
                String(typeOf(code) || "").toUpperCase(),
                LAYER_TYPE[code.slice(0, 3)] || "",
                finding.message || (meta.title || ""),
            ]);
        }
    }
    return { columns: REPORT_COLUMNS, rows };
}
