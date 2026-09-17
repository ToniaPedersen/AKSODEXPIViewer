// Folder validation - runs both engines over a list of picked files and
// returns one result per file. Same entry points the single-file view uses
// (parseProteusPackage / validateAgainstRdl / validateProteusXsd), so a
// finding here is the finding the viewer and the CLI report.

import { parseProteusPackage } from "./proteusParser.js";
import { validateAgainstRdl } from "./rdlValidate.js";
import { validateProteusXsd } from "./xsdValidate.js";
import { buildLineResolver } from "./lineResolve.js";
import { buildReportRows, buildTagIndex, locationFromModel, locationFromXsd } from "./reportColumns.js";

const XML_EXTS = [".xml"];

const isXml = (name) => XML_EXTS.includes((name.match(/\.[^.]+$/) || [""])[0].toLowerCase());

/** Files a folder pick should actually validate. */
export function pickXmlFiles(fileList) {
    return [...(fileList || [])].filter(f => isXml(f.name));
}

/** True when the browser offers showDirectoryPicker(). */
export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function collectXmlFiles(dirHandle, prefix, out) {
    for await (const entry of dirHandle.values()) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
            await collectXmlFiles(entry, rel, out);
        } else if (isXml(entry.name)) {
            const file = await entry.getFile();
            try { file.relPath = rel; } catch { /* File is not extensible in this engine */ }
            out.push(file);
        }
    }
}

/**
 * Opens the directory picker and reads every .xml in the chosen folder and
 * its subfolders.
 *
 * @returns {Promise<{name:string, files:File[]}|null>} null if cancelled
 */
export async function pickDirectory() {
    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: "read", id: "dexpi-folder-validate" });
    } catch (e) {
        if (e?.name === "AbortError") return null;
        throw e;
    }
    const files = [];
    await collectXmlFiles(dirHandle, "", files);
    files.sort((a, b) => (a.relPath || a.name).localeCompare(b.relPath || b.name));
    return { name: dirHandle.name, files };
}

/**
 * @param {File[]} files
 * @param {string} profileText - DiscProfile.xml source, or "" for none
 * @param {{ onProgress?: (p:{done:number,total:number,name:string}) => void,
 *           runXsd?: boolean, isCancelled?: () => boolean }} [opts]
 * @returns {Promise<Array<{
 *   name: string, path: string, findings: object[], error: string, note: string,
 *   hasProfile: boolean, fileUsesProfile: boolean
 * }>>}
 */
export async function validateFiles(files, profileText, opts = {}) {
    const { onProgress, runXsd = true, isCancelled } = opts;
    const results = [];

    for (let i = 0; i < files.length; i++) {
        if (isCancelled?.()) break;
        const file = files[i];
        onProgress?.({ done: i, total: files.length, name: file.name });

        const r = {
            name: file.name,
            path: file.relPath || file.webkitRelativePath || file.name,
            findings: [], error: "", note: "",
            hasProfile: false, fileUsesProfile: false,
        };

        let text = "";
        try {
            text = await file.text();
        } catch (e) {
            r.error = `could not be read: ${e.message || e}`;
            results.push(r);
            continue;
        }

        try {
            const pkg = parseProteusPackage(text, profileText || "");
            const res = validateAgainstRdl(pkg.mainDoc, pkg.discDoc, pkg.connectivityMap);
            const lineOf = buildLineResolver(text);
            const tagById = buildTagIndex(pkg.mainDoc);
            r.hasProfile = !!res.hasProfile;
            r.fileUsesProfile = !!res.fileUsesProfile;
            r.findings = (res.findings || []).map(f => ({
                code: f.code, message: f.message || "",
                objectId: f.objectId || "", line: lineOf(f), source: "rdl",
                location: locationFromModel(tagById.get(f.objectId), f.message),
            }));
        } catch (e) {
            r.error = e.message || String(e);
        }

        if (runXsd && !r.error) {
            try {
                const xsd = await validateProteusXsd(text);
                (xsd.errors || []).forEach(err => r.findings.push({
                    code: err.issueCode || "SER-VAL-01",
                    message: err.message || "", objectId: "",
                    line: err.line ?? null, source: "xsd",
                    location: locationFromXsd(err.rawMessage || err.message),
                }));
            } catch (e) {
                r.note = e.schemaCompileError ? "XSD stage unavailable" : `XSD stage failed: ${e.message || e}`;
            }
        }

        results.push(r);
        // Let the progress line paint between files.
        await new Promise(done => setTimeout(done, 0));
    }

    onProgress?.({ done: files.length, total: files.length, name: "" });
    return results;
}

/**
 * Report rows for a folder run - see reportColumns.js for the layout.
 *
 * @param {Array} results - from validateFiles()
 * @param {(code:string) => string} typeOf - resolved Error/Warning/Info label
 */
export function buildFolderReport(results, typeOf) {
    return buildReportRows(results, typeOf);
}
