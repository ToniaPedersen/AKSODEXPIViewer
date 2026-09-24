// Folder validation - runs both engines over a list of picked files and
// returns one result per file. Same entry points the single-file view uses
// (parseProteusPackage / validateAgainstRdl / validateProteusXsd), so a
// finding here is the finding the viewer and the CLI report.

import { parseProteusPackage } from "./proteusParser.js";
import { validateAgainstRdl, collectElementUsage } from "./rdlValidate.js";
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
 * Opens the directory picker with write access, for saving output next to
 * each .xml in the chosen folder and its subfolders.
 *
 * @returns {Promise<{name:string, files:File[], dirHandle:FileSystemDirectoryHandle}|null>} null if cancelled
 */
export async function pickDirectoryForWrite() {
    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "dexpi-folder-png" });
    } catch (e) {
        if (e?.name === "AbortError") return null;
        throw e;
    }
    const files = [];
    await collectXmlFiles(dirHandle, "", files);
    files.sort((a, b) => (a.relPath || a.name).localeCompare(b.relPath || b.name));
    return { name: dirHandle.name, files, dirHandle };
}

/** "sub/drawing.xml" -> "sub/drawing.png" */
export function pngPathFor(relPath) {
    return relPath.replace(/\.[^./]+$/, "") + ".png";
}

/** Writes blob to relPath (subfolders must already exist) under dirHandle. */
export async function writeFileAt(dirHandle, relPath, blob) {
    const parts = relPath.split("/");
    const fileName = parts.pop();
    let dir = dirHandle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
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

/**
 * Export Element…: classes, DEXPI attributes and symbols used per file, as
 * three xlsx sheets (see collectElementUsage() in rdlValidate.js).
 *
 * @returns {Promise<{name:string, columns:object[], rows:any[][]}[]>}
 */
export async function collectFolderElements(files, profileText, opts = {}) {
    const { onProgress, isCancelled } = opts;
    const parser = new DOMParser();
    const discDoc = profileText ? parser.parseFromString(profileText, "application/xml") : null;
    const classRows = [], attrRows = [], symbolRows = [];
    const yn = v => (v ? "Yes" : "No");

    for (let i = 0; i < files.length; i++) {
        if (isCancelled?.()) break;
        const file = files[i];
        const path = file.relPath || file.webkitRelativePath || file.name;
        onProgress?.({ done: i, total: files.length, name: path });
        try {
            const mainDoc = parser.parseFromString(await file.text(), "application/xml");
            if (mainDoc.getElementsByTagName("parsererror").length) throw new Error("not well-formed XML");
            const usage = collectElementUsage(mainDoc, discDoc);
            usage.classes
                .sort((a, b) => a.className.localeCompare(b.className))
                .forEach(c => classRows.push([path, c.className, c.superType, c.count, yn(c.valid)]));
            usage.attributes
                .sort((a, b) => a.className.localeCompare(b.className) || a.attribute.localeCompare(b.attribute))
                .forEach(a => attrRows.push([path, a.className, a.superType, a.attribute, a.count, yn(a.valid)]));
            usage.symbols
                .sort((a, b) => a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference) || a.className.localeCompare(b.className))
                .forEach(y => symbolRows.push([path, y.reference, y.className, y.superType, y.kind, y.count, usage.usesProfile ? yn(y.valid) : "N/A"]));
        } catch (e) {
            classRows.push([path, `(error: ${e.message || e})`, "", 0, "No"]);
        }
        await new Promise(done => setTimeout(done, 0));
    }

    return [
        {
            name: "Classes",
            columns: [{ header: "File", width: 40 }, { header: "Class", width: 32 }, { header: "SuperType", width: 40 },
                { header: "Count", width: 8 }, { header: "IsValid", width: 9 }],
            rows: classRows,
        },
        {
            name: "Attributes",
            columns: [{ header: "File", width: 40 }, { header: "Class", width: 32 }, { header: "SuperType", width: 40 },
                { header: "Attribute", width: 36 }, { header: "Count", width: 8 }, { header: "IsValid", width: 9 }],
            rows: attrRows,
        },
        {
            name: "Symbols",
            columns: [{ header: "File", width: 40 }, { header: "Symbol", width: 28 }, { header: "Class", width: 32 }, { header: "SuperType", width: 40 },
                { header: "Reference Type", width: 14 }, { header: "Count", width: 8 }, { header: "IsValid", width: 9 }],
            rows: symbolRows,
        },
    ];
}
