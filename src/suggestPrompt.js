// Builds the "Suggest..." content for one finding:
//  - current: the lines of the file the finding is about, the related ones marked "bad" (red);
//  - fix:     a suggested change or the expected syntax as diff rows ("-" red, "+" green, " " context);
//  - text:    a self-contained question for Copilot or another assistant (with the same diff).
// Where the fix can be worked out from the file it is filled in; otherwise the rows show the
// syntax with {placeholders}.

import rdl from "./dexpi14Rdl.json";
import rdlUris from "./dexpiRdlUris.json";
import { ISSUE_CODES } from "./issueCodes.js";

const MAX_ROWS = 80;
const CONTEXT_LINES = 5;
const FOCUS_LINES = 2;
const MAX_PROPS = 40;
const SNAP_GAP = 10;
const TOL = 0.01;

const REFERENCE_SOURCES = [
    "DEXPI 1.4 information model (XMI used by the viewer): https://github.com/ToniaPedersen/AKSODEXPIViewer/blob/main/src/DEXPI%20P%26ID%20Specification.xmi",
    "DISC profile (DiscProfile.xml): https://github.com/ToniaPedersen/DISCDEXPI_2026Pack/blob/main/Profile/xml/DiscProfile.xml",
    "Proteus 4.1.1 schema used by the viewer: https://github.com/ToniaPedersen/AKSODEXPIViewer/blob/main/src/assets/proteus-4.1.1-disc.xsd",
    "Proteus XML schema and examples: https://github.com/DEXPI/ProteusXML",
];

// PowerShell fix scripts (DexpiFix folder) that repair a code automatically.
const FIX_SCRIPTS = {
    "MDL-REF-07": "09-Add-SegmentConnections.ps1 (segment SourceItem/TargetItem; CNV-09-Add-PipeOffPageConnectors.ps1 first for raw COMOS files), 10-Link-ActuatingSystems.ps1 / 11-Retarget-InstrumentSignals.ps1 (ActuatingFunction Systems)",
    "GEO-ALN-01": "01-Remove-SlopeSymbolConnectionPoints.ps1, 02-Move-MisplacedPipingComponents.ps1, 04-Split-CenterLinesAtInlineItems.ps1, 05-Close-PipingGaps.ps1, 06-Split-DisconnectedSegments.ps1",
    "SER-STR-01": "03-Move-SystemLevelSegmentItems.ps1, 07-Move-SignalOffPageConnectors.ps1, 08-Convert-SignalLineSymbols.ps1, 02-Move-MisplacedPipingComponents.ps1",
    "MDL-CLS-05": "CNV-03-Convert-AnnotationEquipment.ps1 (notes, revision clouds, text boxes), CNV-04-Complete-ComponentClasses.ps1, CNV-05-Set-SignalClasses.ps1, 02-Move-MisplacedPipingComponents.ps1 (orphan containers)",
    "MDL-CLS-02": "CNV-05-Set-SignalClasses.ps1",
    "PRF-SCP-01": "CNV-04-Complete-ComponentClasses.ps1 (-RenameClasses), 02-Move-MisplacedPipingComponents.ps1 (COMOS Orphan containers, e.g. OrphanPipingNetworkSystem)",
    "MDL-PRP-05": "CNV-08-Register-SymbolNames.ps1 (SymbolRegistrationNumberAssignmentClass)",
    "PRF-SCP-02": "CNV-08-Register-SymbolNames.ps1 (SymbolRegistrationNumberAssignmentClass)",
    "PRF-EXT-04": "CNV-07-Split-BlindFlangePlugs.ps1 (BlindFlange with the Flange URI)",
    "PRF-SYM-02": "CNV-07-Split-BlindFlangePlugs.ps1 (BlindFlange with the Flange URI)",
    "GEO-GRD-01": "CNV-10-Snap-ToGrid.ps1",
    "GEO-GRD-02": "CNV-10-Snap-ToGrid.ps1",
    "SER-FMT-04": "CNV-01-Set-ApplicationVersion.ps1",
    "MDL-REF-03": "CNV-06-Add-SignalEndFunctions.ps1",
    "PRF-LBL-02": "CNV-09-Add-PipeOffPageConnectors.ps1 (OffPageReference labels), CNV-03-Convert-AnnotationEquipment.ps1 (notes)",
    "SER-IDN-03": "CNV-02-Convert-ConnectionNodeReferences.ps1 (Connection pointing at a Node ID)",
    "GEO-MDL-01": "10-Link-ActuatingSystems.ps1, 11-Retarget-InstrumentSignals.ps1",
};

// Where an element that is "not expected" belongs (SER-STR-01).
const REQUIRED_PARENT = {
    PropertyBreak: "PipingNetworkSegment", PipeSlopeSymbol: "PipingNetworkSegment", PipeFlowArrow: "PipingNetworkSegment",
    InsulationSymbol: "PipingNetworkSegment", PipeConnectorSymbol: "PipingNetworkSegment", PipingComponent: "PipingNetworkSegment",
    PipeOffPageConnector: "PipingNetworkSegment", CenterLine: "PipingNetworkSegment or InformationFlow",
    SignalOffPageConnector: "ProcessInstrumentationFunction", ActuatingFunction: "ProcessInstrumentationFunction",
    ProcessSignalGeneratingFunction: "ProcessInstrumentationFunction", InformationFlow: "ProcessInstrumentationFunction or PlantModel",
};

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)\b([^>]*?)(\/?)>/g;
const ASSOC_RE = /<Association\b[^>]*?\bType="([^"]*)"[^>]*?\bItemID="([^"]*)"[^>]*?\/>/g;
const splitLines = s => s.split(/\r\n|\r|\n/);
const indentOf = s => (/^\s*/.exec(s) || [""])[0];
const fmt = v => String(+(+v).toFixed(4));
const near = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= TOL;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pt = p => `(${fmt(p.x)}, ${fmt(p.y)})`;

// Line starts, counting CRLF, CR and LF as one break each (as the line numbers in the findings do).
let lineCache = { text: null, starts: [] };
function lineStarts(text) {
    if (lineCache.text === text) return lineCache.starts;
    const starts = [0];
    const re = /\r\n|\r|\n/g;
    for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index + m[0].length);
    lineCache = { text, starts };
    return starts;
}

function lineNumberAt(text, offset) {
    const starts = lineStarts(text);
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
}

function capLines(lines, first) {
    const shown = lines.slice(0, 60);
    const more = lines.length - shown.length;
    return { first, last: first + shown.length - 1, body: shown.join("\n") + (more > 0 ? `\n<!-- ... ${more} more lines -->` : "") };
}

function elementFrom(text, start, tag) {
    const tagRe = new RegExp(`<(/?)${esc(tag)}\\b[^>]*?(/?)>`, "g");
    tagRe.lastIndex = start;
    let depth = 0, end = text.length;
    for (let t = tagRe.exec(text); t; t = tagRe.exec(text)) {
        if (t[1]) depth--;
        else if (!t[2]) depth++;
        if (depth === 0) { end = tagRe.lastIndex; break; }
    }
    const starts = lineStarts(text);
    const line = lineNumberAt(text, start);
    const raw = text.slice(starts[line - 1], end);
    return { tag, offset: start, line, raw, cls: (/\bComponentClass="([^"]+)"/.exec(raw.slice(0, raw.indexOf(">") + 1)) || [])[1] || null };
}

// The element carrying ID="id": raw text from the start of its line to its end tag.
function findElement(text, id) {
    const open = new RegExp(`<([A-Za-z_][\\w.:-]*)\\b[^>]*?\\bID="${esc(id)}"`).exec(text);
    return open ? elementFrom(text, open.index, open[1]) : null;
}

// The element whose start tag is on line `line` (1-based).
// Schema (libxml2) line numbers can be off by a line or two in very large files, so when the
// message names the element ("Element 'PropertyBreak': ...") the nearest such start tag is used.
function elementForXsd(text, issue) {
    const name = (/Element '([\w.:-]+)'/.exec(issue.message || "") || [])[1];
    if (!name) return elementAtLine(text, issue.line);
    for (const d of [0, -1, 1, -2, 2, -3, 3]) {
        const el = elementAtLine(text, issue.line + d);
        if (el && el.tag === name) return el;
    }
    return elementAtLine(text, issue.line);
}

function elementAtLine(text, line) {
    const starts = lineStarts(text);
    if (line < 1 || line > starts.length) return null;
    const off = starts[line - 1];
    const end = line < starts.length ? starts[line] : text.length;
    const m = /<([A-Za-z_][\w.:-]*)\b/.exec(text.slice(off, end));
    return m ? elementFrom(text, off + m.index, m[1]) : null;
}

function parentStartLine(text, offset) {
    const stack = [];
    TAG_RE.lastIndex = 0;
    for (let m = TAG_RE.exec(text); m && m.index < offset; m = TAG_RE.exec(text)) {
        if (m[1]) stack.pop();
        else if (!m[4] && m[2] !== "?xml") stack.push({ tag: m[2], index: m.index });
    }
    const p = stack.pop();
    if (!p) return null;
    const line = lineNumberAt(text, p.index);
    const starts = lineStarts(text);
    return { tag: p.tag, line, text: text.slice(starts[line - 1], line < starts.length ? starts[line] : text.length).replace(/[\r\n]+$/, "") };
}

function lineSnippet(text, line) {
    const all = splitLines(text);
    const from = Math.max(1, line - CONTEXT_LINES);
    const to = Math.min(all.length, line + CONTEXT_LINES);
    return capLines(all.slice(from - 1, to), from);
}

// Open elements (with an ID) enclosing `offset`, outermost first.
function ancestorsAt(text, offset) {
    const stack = [];
    TAG_RE.lastIndex = 0;
    for (let m = TAG_RE.exec(text); m && m.index < offset; m = TAG_RE.exec(text)) {
        if (m[1]) stack.pop();
        else if (!m[4]) stack.push({ tag: m[2], id: (/\bID="([^"]*)"/.exec(m[3]) || [])[1] || null });
    }
    return stack.filter(a => a.id);
}

function associations(raw) {
    const out = [];
    ASSOC_RE.lastIndex = 0;
    for (let m = ASSOC_RE.exec(raw); m; m = ASSOC_RE.exec(raw)) out.push({ type: m[1], itemId: m[2] });
    return out;
}

// IDs of the elements that carry <Association Type="type" ItemID="id"/>.
function reverseOwners(text, type, id) {
    const re = new RegExp(`<Association\\b[^>]*?\\bType="${esc(type)}"[^>]*?\\bItemID="${esc(id)}"`, "g");
    const out = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const owner = ancestorsAt(text, m.index).pop();
        if (owner && !out.includes(owner.id)) out.push(owner.id);
    }
    return out;
}

function parseXml(raw) {
    if (typeof DOMParser === "undefined") return null;
    const doc = new DOMParser().parseFromString(raw.trim(), "application/xml");
    return doc.getElementsByTagName("parsererror").length ? null : doc.documentElement;
}
const kids = (el, tag) => Array.from(el.children).filter(c => !tag || c.tagName === tag);
const readPt = el => el ? { x: parseFloat(el.getAttribute("X")), y: parseFloat(el.getAttribute("Y")) } : null;
function nodePoints(el) {
    const cp = kids(el, "ConnectionPoints")[0];
    return cp ? kids(cp, "Node").map(n => { const pos = kids(n, "Position")[0]; return pos ? readPt(kids(pos, "Location")[0]) : null; }) : [];
}

// ---- Marking the related lines ---------------------------------------------

function tokensFromMessage(msg) {
    const tokens = [];
    const attrRe = /\b([A-Za-z]+)="([^"]*)"/g;
    for (let m = attrRe.exec(msg); m; m = attrRe.exec(msg)) tokens.push([`${m[1]}="${m[2]}"`]);
    const coordRe = /\((-?[\d.]+),\s*(-?[\d.]+)\)/g;
    for (let m = coordRe.exec(msg); m; m = coordRe.exec(msg)) tokens.push([`X="${m[1]}"`, `Y="${m[2]}"`]);
    const quoteRe = /"([^"]{3,})"/g;
    for (let m = quoteRe.exec(msg); m; m = quoteRe.exec(msg)) if (!/^\d+$/.test(m[1])) tokens.push([`"${m[1]}"`]);
    const uriRe = /https?:\/\/[^\s)"]+[^\s)".,]/g;
    for (let m = uriRe.exec(msg); m; m = uriRe.exec(msg)) tokens.push([m[0]]);
    return tokens;
}

// IDs named after "run 2:" / "group 2:" etc. (everything except the first run/group).
function strayIds(msg) {
    const ids = [];
    const re = /(?:run|group) (\d+): ([^;)]*)/g;
    for (let m = re.exec(msg); m; m = re.exec(msg)) if (m[1] !== "1") ids.push(...m[2].split(",").map(s => s.trim()).filter(Boolean));
    return ids;
}

// Lines inside GenericAttributes blocks of tool-specific sets (ComosProperties, XMpLant ...).
function vendorLines(lines) {
    const out = new Set();
    let inVendor = false;
    lines.forEach((l, i) => {
        const open = /<GenericAttributes\b[^>]*\bSet="([^"]*)"/.exec(l);
        if (open) inVendor = !["DexpiAttributes", "DexpiCustomAttributes"].includes(open[1]);
        if (inVendor) out.add(i);
        if (/<\/GenericAttributes>|<GenericAttributes\b[^>]*\/>/.test(l)) inVendor = false;
    });
    return out;
}

// Lines inside a nested child element that has its own ID (a nozzle inside equipment ...).
function nestedLines(lines) {
    const out = new Set();
    const stack = [];
    lines.forEach((l, i) => {
        if (i === 0) return;
        if (stack.length) out.add(i);
        const open = /<([\w.:-]+)\b[^>]*\bID="[^"]*"[^>]*?(\/?)>/.exec(l);
        if (open && !open[2] && !new RegExp(`</${open[1]}>`).test(l)) stack.push(open[1]);
        else if (stack.length && new RegExp(`</${stack[stack.length - 1]}>`).test(l)) { stack.pop(); }
    });
    return out;
}

function markLines(lines, issue, firstLine) {
    const code = issue.code || "";
    const msg = issue.message || "";
    const marks = new Set();
    const vendor = vendorLines(lines);
    nestedLines(lines).forEach(i => vendor.add(i));
    const hit = pred => lines.forEach((l, i) => { if (!vendor.has(i) && pred(l)) marks.add(i); });
    if (code === "GEO-ALN-01") {
        const ids = strayIds(msg);
        hit(l => ids.some(id => l.includes(`ID="${id}"`)));
        const m = /meet (\S+) node/.exec(msg) || /\((FromID|ToID)\)/.exec(msg);
        if (m) hit(l => /<Connection\b/.test(l));
    } else if (code === "MDL-REF-07" && /has no \w+ reference/.test(msg)) {
        marks.add(0);
        hit(l => /<Connection\b/.test(l));
    } else if (code === "MDL-MUL-03") {
        const ids = [...msg.matchAll(/\b([\w.-]+) \("([^"]+)"\)/g)].map(m => m[1]);
        hit(l => /<Association\b/.test(l) && ids.some(id => l.includes(`ItemID="${id}"`)));
    } else if (code === "SER-CNT-01") {
        const m = /Set="([^"]*)" declares Number="(\d+)"/.exec(msg);
        if (m) lines.forEach((l, i) => { if (/<GenericAttributes\b/.test(l) && l.includes(`Set="${m[1]}"`) && l.includes(`Number="${m[2]}"`)) marks.add(i); });
    } else if (code === "SER-STR-01" || /^XSD|^SER-VAL/.test(code)) {
        marks.add(0);
    } else {
        const tokens = tokensFromMessage(msg);
        hit(l => tokens.some(group => group.every(t => l.includes(t))));
    }
    if (issue.line != null && issue.line >= firstLine && issue.line < firstLine + lines.length && !["MDL-REF-07", "GEO-ALN-01", "SER-STR-01"].includes(code) && !/^Schemas/.test(msg)) marks.add(issue.line - firstLine);
    if (!marks.size) marks.add(0);
    return marks;
}

// Keeps the start/end tag and FOCUS_LINES around every marked line; the rest folds into "...".
function focusRows(lines, firstLine, marks) {
    const keep = new Set([0, lines.length - 1]);
    marks.forEach(i => { for (let k = i - FOCUS_LINES; k <= i + FOCUS_LINES; k++) if (k >= 0 && k < lines.length) keep.add(k); });
    const rows = [];
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!keep.has(i)) { skipped++; continue; }
        if (skipped) { rows.push({ fold: skipped }); skipped = 0; }
        rows.push({ n: firstLine + i, text: lines[i], bad: marks.has(i) });
        if (rows.length >= MAX_ROWS) { rows.push({ fold: lines.length - 1 - i }); break; }
    }
    return rows;
}

// ---- Fix builders: rows of { op: " " | "-" | "+", text } -------------------

const ctx = text => ({ op: " ", text });
const del = text => ({ op: "-", text });
const add = text => ({ op: "+", text });
const childIndent = (raw, line0) => {
    const ls = splitLines(raw);
    return ls.length > 2 ? indentOf(ls[1]) : indentOf(line0) + "  ";
};
const withAttr = (startTag, name, value) => new RegExp(`\\b${name}="`).test(startTag)
    ? startTag.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`)
    : startTag.replace(/\s*(\/?>)\s*$/, ` ${name}="${value}"$1`);

function subclassesOf(cls) {
    return Object.keys(rdl.classes).filter(c => (rdl.classes[c].superTypes || []).includes(cls));
}
function concreteLeaves(cls) {
    const out = new Set(), seen = new Set();
    const walk = c => subclassesOf(c).forEach(sub => {
        if (seen.has(sub)) return;
        seen.add(sub);
        if (rdl.classes[sub]?.kind !== "Abstract") out.add(sub);
        walk(sub);
    });
    walk(cls);
    return out;
}

const reverseOf = type => (text, el) => {
    const owners = reverseOwners(text, type, el.id);
    return owners.length === 1 ? { id: owners[0], why: `${owners[0]} already carries <Association Type="${type}" ItemID="${el.id}"/>, so only this side is missing.` } : null;
};
const MISSING_REFERENCE_FIXES = {
    ActuatingElectricalLocation: { assoc: "is located in", reverse: "is the location of", find: reverseOf("is the location of"), target: "ActuatingElectricalLocation" },
    SensingLocation: { assoc: "is located in", reverse: "is the location of", find: reverseOf("is the location of"), target: "piping item / equipment it senses" },
    Systems: { assoc: "is fulfilled by", reverse: "fulfills", find: reverseOf("fulfills"), target: "ActuatingSystem" },
    Source: { assoc: "has logical start", reverse: "is logical start of", find: reverseOf("is logical start of"), target: "source object" },
    Target: { assoc: "has logical end", reverse: "is logical end of", find: reverseOf("is logical end of"), target: "target object" },
};

function fixMissingReference(text, issue, el) {
    const prop = (/has no (\w+) reference/.exec(issue.message || "") || [])[1];
    const lines = splitLines(el.raw);
    const ind = childIndent(el.raw, lines[0]);
    if (prop === "SourceItem" || prop === "TargetItem") {
        const conn = lines.find(l => /<Connection\b/.test(l));
        const side = prop === "SourceItem" ? "From" : "To";
        const rows = [ctx(lines[0]), ctx(`${ind}...`)];
        if (conn) {
            rows.push(del(conn), add(withAttr(withAttr(conn, `${side}ID`, `{${side === "From" ? "start" : "end"} item ID}`), `${side}Node`, "{node no.}")));
        } else {
            rows.push(add(`${ind}<Connection FromID="{start item ID}" FromNode="{node no.}" ToID="{end item ID}" ToNode="{node no.}"/>`));
        }
        rows.push(ctx(lines[lines.length - 1]));
        return {
            heading: "Expected syntax",
            rows,
            notes: [
                `${side}ID: the object at the ${side === "From" ? "start" : "end"} of the segment - a Nozzle, PipingComponent or PipeOffPageConnector whose node coincides with the ${side === "From" ? "first" : "last"} CenterLine coordinate, or another PipingNetworkSegment that continues the pipe.`,
                `${side}Node: position of that node in the object's <ConnectionPoints>, counting the first (Default/Origin) node as 0. Leave it out when ${side}ID is a segment.`,
                "<Connection> is the last child of the PipingNetworkSegment.",
                ...(segmentEndHints(el, prop)),
            ],
        };
    }
    const rule = MISSING_REFERENCE_FIXES[prop];
    if (!rule) return null;
    const target = rule.find(text, { ...el, id: issue.objectId });
    const assoc = `<Association Type="${rule.assoc}" ItemID="${target ? target.id : `{ID of the ${rule.target}}`}"/>`;
    const rows = [ctx(lines[0]), ...(lines.length > 2 ? [ctx(`${ind}...`)] : []), add(`${ind}${assoc}`), ctx(lines.length > 1 ? lines[lines.length - 1] : "")].filter(r => r.text !== "");
    const notes = [];
    const targetEl = target && findElement(text, target.id);
    if (target) {
        if (targetEl && !associations(targetEl.raw).some(a => a.type === rule.reverse && a.itemId === issue.objectId)) {
            notes.push(`Also add <Association Type="${rule.reverse}" ItemID="${issue.objectId}"/> as a direct child of ${target.id} (line ${targetEl.line}).`);
        }
        notes.push(`Why ${target.id}: ${target.why}`);
        return { heading: "Suggested fix", rows, notes };
    }
    notes.push(`Add the reverse <Association Type="${rule.reverse}" ItemID="${issue.objectId}"/> to the ${rule.target} as well.`);
    if (prop === "Systems") notes.push("The ActuatingSystem holds the ControlledActuator (ActuatingSystemComponent) and an OperatedValveReference that \"refers to\" the valve.");
    return { heading: "Expected syntax", rows, notes };
}

// First/last CenterLine coordinate of a segment, for the Connection hints.
function segmentEndHints(el, prop) {
    const seg = parseXml(el.raw);
    if (!seg) return [];
    const lines = kids(seg, "CenterLine");
    if (!lines.length) return [];
    const cl = prop === "SourceItem" ? lines[0] : lines[lines.length - 1];
    const coords = kids(cl, "Coordinate");
    const p = readPt(prop === "SourceItem" ? coords[0] : coords[coords.length - 1]);
    if (!p) return [];
    const at = [];
    kids(seg).forEach(c => {
        const id = c.getAttribute("ID");
        if (!id || c.tagName === "CenterLine") return;
        nodePoints(c).forEach((q, i) => { if (q && i > 0 && near(p, q)) at.push(`${c.tagName} ${id} node ${i}`); });
    });
    return [`The ${prop === "SourceItem" ? "first" : "last"} CenterLine coordinate is ${pt(p)}${at.length ? `; in this segment ${at.join(", ")} sits there` : "; nothing in this segment sits there - look for a Nozzle, a component of another segment, or add a PipeOffPageConnector if the pipe continues on another drawing"}.`];
}

function fixSegmentContinuity(issue, el) {
    const seg = parseXml(el.raw);
    if (!seg || seg.tagName !== "PipingNetworkSegment") return null;
    const ids = strayIds(issue.message || "");
    if (!ids.length) return null;
    const items = [];
    kids(seg).forEach(c => {
        if (c.tagName === "CenterLine") {
            const cs = kids(c, "Coordinate").map(readPt);
            if (cs.length >= 2) items.push({ el: c, id: c.getAttribute("ID") || "CenterLine", pts: [cs[0], cs[cs.length - 1]], coords: cs });
        } else if (c.getAttribute("ID")) {
            const ps = nodePoints(c).filter(Boolean);
            if (ps.length) items.push({ el: c, id: c.getAttribute("ID"), pts: ps });
        }
    });
    const stray = items.filter(i => ids.includes(i.id));
    const main = items.filter(i => !ids.includes(i.id));
    if (!stray.length || !main.length) return null;
    const ind = childIndent(el.raw, splitLines(el.raw)[0]);
    // 1. A stray item sitting on the middle of a CenterLine: split that line.
    for (const s of stray) {
        for (const m of main) {
            if (!m.coords) continue;
            const ps = s.pts.length > 1 ? s.pts.slice(1) : s.pts;
            for (let k = 0; k < m.coords.length - 1; k++) {
                const a = m.coords[k], b = m.coords[k + 1];
                const onIt = ps.filter(p => {
                    const L = dist(a, b); if (!L) return false;
                    const cross = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / L;
                    return cross <= TOL && Math.min(a.x, b.x) - TOL <= p.x && p.x <= Math.max(a.x, b.x) + TOL && Math.min(a.y, b.y) - TOL <= p.y && p.y <= Math.max(a.y, b.y) + TOL && !near(p, m.coords[0]) && !near(p, m.coords[m.coords.length - 1]);
                });
                if (!onIt.length) continue;
                onIt.sort((p, q) => dist(a, p) - dist(a, q));
                const p1 = onIt[0], p2 = onIt[onIt.length - 1];
                const coordLine = p => `${ind}  <Coordinate X="${fmt(p.x)}" Y="${fmt(p.y)}" Z="0"/>`;
                const first = [...m.coords.slice(0, k + 1), p1], second = [p2, ...m.coords.slice(k + 1)];
                return {
                    heading: "Suggested fix",
                    rows: [
                        ...m.coords.map(c => del(coordLine(c))),
                        add(`${ind}<CenterLine NumPoints="${first.length}">`), ...first.map(c => add(coordLine(c))), add(`${ind}</CenterLine>`),
                        ctx(`${ind}<${s.el.tagName} ID="${s.id}" ...>   (node${p1 === p2 ? "" : "s"} at ${p1 === p2 ? pt(p1) : `${pt(p1)} / ${pt(p2)}`})`),
                        add(`${ind}<CenterLine NumPoints="${second.length}">`), ...second.map(c => add(coordLine(c))), add(`${ind}</CenterLine>`),
                    ],
                    notes: [`${s.id} sits on the middle of CenterLine ${m.id}. A segment's items only join where a CenterLine END meets a node, so split ${m.id} at ${s.id}'s node${p1 === p2 ? "" : "s"} (keep the Presentation of the original CenterLine on both parts).`],
                };
            }
        }
    }
    // 2. A small straight gap between a stray point and the main run: bridge it.
    let best = null;
    for (const s of stray) for (const p of s.pts) for (const m of main) for (const q of m.pts) {
        const d = dist(p, q);
        if (d > TOL && (!best || d < best.d)) best = { d, p, q, s, m };
    }
    if (best && best.d <= SNAP_GAP && (Math.abs(best.p.x - best.q.x) <= TOL || Math.abs(best.p.y - best.q.y) <= TOL)) {
        return {
            heading: "Suggested fix",
            rows: [
                ctx(`${ind}<... ID="${best.m.id}">   (point ${pt(best.q)})`),
                add(`${ind}<CenterLine NumPoints="2">`),
                add(`${ind}  <Coordinate X="${fmt(best.q.x)}" Y="${fmt(best.q.y)}" Z="0"/>`),
                add(`${ind}  <Coordinate X="${fmt(best.p.x)}" Y="${fmt(best.p.y)}" Z="0"/>`),
                add(`${ind}</CenterLine>`),
                ctx(`${ind}<... ID="${best.s.id}">   (point ${pt(best.p)})`),
            ],
            notes: [`${best.s.id} is ${fmt(best.d)} mm from ${best.m.id}. Close the gap with a CenterLine (or move the end coordinate) so the two points coincide.`],
        };
    }
    const where = best ? ` The nearest point of ${best.s.id} is ${fmt(best.d)} mm from ${best.m.id}.` : "";
    return {
        heading: "Expected syntax",
        rows: [
            ctx(`${ind}<CenterLine NumPoints="2">`),
            ctx(`${ind}  <Coordinate X="{x of the previous item's node}" Y="{y}" Z="0"/>`),
            ctx(`${ind}  <Coordinate X="{x of the next item's node}" Y="{y}" Z="0"/>`),
            ctx(`${ind}</CenterLine>`),
        ],
        notes: [
            `Every item of a PipingNetworkSegment must join the next one: a CenterLine end coordinate must equal a node of the component it meets.${where}`,
            `If ${ids.join(", ")} belong${ids.length === 1 ? "s" : ""} to another pipe, move ${ids.length === 1 ? "it" : "them"} to that PipingNetworkSegment; if it is a separate branch, give it its own PipingNetworkSegment.`,
        ],
    };
}

// The segment of the parent system whose CenterLines pass closest to the element's position/nodes.
function nearestSegment(text, parent, el) {
    const pStart = lineStarts(text)[parent.line - 1];
    const tagAt = text.indexOf(`<${parent.tag}`, pStart);
    if (tagAt < 0) return null;
    const sys = parseXml(elementFrom(text, tagAt, parent.tag).raw);
    const item = parseXml(el.raw);
    if (!sys || !item) return null;
    const pos = kids(item, "Position")[0];
    const pts = [...nodePoints(item).filter(Boolean), ...(pos ? [readPt(kids(pos, "Location")[0])] : [])].filter(Boolean);
    let best = null;
    kids(sys, "PipingNetworkSegment").forEach(seg => kids(seg, "CenterLine").forEach(cl => {
        const cs = kids(cl, "Coordinate").map(readPt);
        for (let k = 0; k < cs.length - 1; k++) pts.forEach(p => {
            const a = cs[k], b = cs[k + 1], L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
            const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
            const d = dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
            if (!best || d < best.d) best = { id: seg.getAttribute("ID"), d };
        });
    }));
    return best && best.id ? best : null;
}

// The ProcessInstrumentationFunction holding the signal line that starts or ends at a connector.
function owningInstrument(text, el) {
    const id = (/\bID="([^"]*)"/.exec(splitLines(el.raw)[0]) || [])[1];
    if (!id) return null;
    for (const type of ["has logical start", "has logical end"]) {
        const re = new RegExp(`<Association\\b[^>]*?\\bType="${esc(type)}"[^>]*?\\bItemID="${esc(id)}"`);
        const m = re.exec(text);
        if (!m) continue;
        const anc = ancestorsAt(text, m.index);
        const flow = anc[anc.length - 1];
        const pif = [...anc].reverse().find(a => a.tag === "ProcessInstrumentationFunction");
        if (pif) return { id: pif.id, why: `${pif.id} holds signal line ${flow ? flow.id : ""}, which ${type === "has logical start" ? "starts" : "ends"} at ${id}.` };
    }
    return null;
}

function fixNotExpected(text, issue) {
    if (issue.line == null) return null;
    const el = elementForXsd(text, issue);
    const parent = el && parentStartLine(text, el.offset);
    if (!el || !parent) return null;
    const start = splitLines(el.raw)[0];
    const expected = (/Expected is one of \(([^)]*)\)/.exec(issue.message || "") || [])[1];
    const pInd = indentOf(parent.text);
    if (el.tag === "PipeFlowArrow" && parent.tag === "InformationFlow") {
        return {
            heading: "Suggested fix",
            rows: [ctx(parent.text), del(start), add(start.replace("<PipeFlowArrow", "<Symbol")), del(`${indentOf(start)}</PipeFlowArrow>`), add(`${indentOf(start)}</Symbol>`)],
            notes: ["A signal line (InformationFlow) cannot hold a PipeFlowArrow. <Symbol> has the same content, so rename the element and keep everything inside it."],
        };
    }
    const home = REQUIRED_PARENT[el.tag];
    if (home) {
        const target = home.split(" or ")[0];
        const nearest = target === "PipingNetworkSegment" && parent.tag === "PipingNetworkSystem" ? nearestSegment(text, parent, el)
            : el.tag === "SignalOffPageConnector" ? owningInstrument(text, el) : null;
        return {
            heading: "Expected syntax",
            rows: [
                ctx(parent.text),
                del(start),
                ctx(`${pInd}  <${target} ID="${nearest ? nearest.id : `{ID of the ${target} it belongs to}`}" ...>`),
                ctx(`${pInd}    ...`),
                add(`${pInd}    ${start.trim()}`),
                add(`${pInd}      ...   (unchanged content)`),
                add(`${pInd}    </${el.tag}>`),
                ctx(`${pInd}  </${target}>`),
            ],
            notes: [
                `<${el.tag}> may not be a direct child of <${parent.tag}> (line ${parent.line}); it belongs inside a ${home}.`,
                ...(nearest ? [nearest.why || `${nearest.id} is the segment of this system whose CenterLine passes closest (${fmt(nearest.d)} mm).`] : []),
                el.tag === "PropertyBreak" || el.tag === "PipeSlopeSymbol"
                    ? "Use the segment whose CenterLine passes through the symbol's position. If its nodes sit on the middle of a CenterLine, split that CenterLine at the nodes."
                    : el.tag === "SignalOffPageConnector" ? "Use the ProcessInstrumentationFunction that holds the signal line (InformationFlow) starting or ending at the connector." : "Use the segment whose geometry it touches.",
                ...(expected ? [`At this position the schema expects one of: ${expected}.`] : []),
            ],
        };
    }
    return expected ? { heading: "Expected syntax", rows: [ctx(parent.text), del(start)], notes: [`<${el.tag}> is not allowed here. At this position the schema expects one of: ${expected}.`] } : null;
}

// ---- COMOS Orphan containers (OrphanPipingNetworkSystem, OrphanPipingNetworkSegment, OrphanInformationFlowCollectorDummy) ---------------------------------------------

// Every node / CenterLine end of the normal (non-orphan) piping segments: [{ seg, item, p }].
let portCache = { text: null, ports: [] };
function segmentPorts(text) {
    if (portCache.text === text) return portCache.ports;
    const ports = [];
    for (const m of text.matchAll(/<PipingNetworkSegment\b[^>]*>/g)) {
        if (/ComponentClass="Orphan/.test(m[0])) continue;
        const seg = parseXml(elementFrom(text, m.index, "PipingNetworkSegment").raw);
        if (!seg) continue;
        const segId = seg.getAttribute("ID");
        kids(seg).forEach(c => {
            if (c.tagName === "CenterLine") {
                const cs = kids(c, "Coordinate");
                [cs[0], cs[cs.length - 1]].forEach(k => k && ports.push({ seg: segId, item: null, p: readPt(k) }));
            } else if (c.getAttribute("ID")) {
                nodePoints(c).forEach((q, i) => q && i > 0 && ports.push({ seg: segId, item: c.getAttribute("ID"), node: i, p: q }));
            }
        });
    }
    portCache = { text, ports };
    return ports;
}

function fixOrphanContainer(text, el) {
    const lines = splitLines(el.raw);
    const id = (/\bID="([^"]+)"/.exec(lines[0]) || [])[1];
    const ind = indentOf(lines[0]);
    const refs = id => (text.match(new RegExp(`<Association\\b[^>]*\\bItemID="${esc(id)}"`, "g")) || []).length;
    const removeRows = ids => ids.map(x => { const n = refs(x); return `${x} (${n ? `${n} Association${n === 1 ? "" : "s"} point at it` : "nothing points at it"})`; }).join(", ");

    if (el.tag === "ProcessInstrumentationFunction") {
        const flows = [...el.raw.matchAll(/<InformationFlow\b[^>]*\bID="([^"]+)"[^>]*>/g)];
        return {
            heading: "Suggested fix",
            rows: [
                del(lines[0]),
                ...flows.slice(0, 6).map(f => ctx(`${ind}  ${f[0]}   <- move up to PlantModel`)),
                ...(flows.length > 6 ? [ctx(`${ind}  ... ${flows.length - 6} more`)] : []),
                del(lines[lines.length - 1]),
            ],
            notes: [
                `${el.cls} is a COMOS helper that collects signal lines without an instrument. It is not a DEXPI class, so it gets no ComponentClassURI (and is not in the DISC profile, PRF-SCP-01).`,
                `Move its ${flows.length} InformationFlow(s) out to PlantModel (or into the instrument that sends the signal), then delete the container and every Association pointing at it: ${removeRows([id])}.`,
            ],
        };
    }

    const root = parseXml(el.raw);
    if (!root) return null;
    const segs = el.tag === "PipingNetworkSegment" ? [root] : kids(root, "PipingNetworkSegment");
    const items = [];
    segs.forEach(sg => kids(sg).forEach(c => {
        if (c.tagName !== "CenterLine" && c.getAttribute("ID")) items.push({ el: c, id: c.getAttribute("ID"), pts: nodePoints(c).filter((q, i) => q && i > 0) });
    }));
    const ports = segmentPorts(text);
    const placed = new Map();
    // Items touching a normal segment, then items touching an item already placed.
    for (let pass = 0, more = true; more && pass < items.length + 1; pass++) {
        more = false;
        items.forEach(it => {
            if (placed.has(it.id)) return;
            let hit = null;
            for (const q of it.pts) {
                hit = ports.find(pp => near(pp.p, q)) || null;
                if (!hit) {
                    const other = items.find(o => o !== it && placed.has(o.id) && o.pts.some(r => near(r, q)));
                    if (other) hit = { seg: placed.get(other.id).seg, item: other.id };
                }
                if (hit) break;
            }
            if (hit) { placed.set(it.id, hit); more = true; }
        });
    }
    const rows = [del(lines[0])];
    const segIds = segs.map(sg => sg.getAttribute("ID")).filter(Boolean);
    if (el.tag !== "PipingNetworkSegment") segs.forEach(sg => rows.push(del(`${ind}  <PipingNetworkSegment ID="${sg.getAttribute("ID")}" ComponentClass="${sg.getAttribute("ComponentClass") || ""}">`)));
    const startTag = it => (new RegExp(`<${it.el.tagName}\\b[^>]*\\bID="${esc(it.id)}"[^>]*>`).exec(el.raw) || [`<${it.el.tagName} ID="${it.id}" ...>`])[0];
    const shown = items.slice(0, 8);
    const bySeg = new Map();
    shown.forEach(it => {
        rows.push(del(`${ind}${el.tag === "PipingNetworkSegment" ? "  " : "    "}${startTag(it)} ... </${it.el.tagName}>`));
        const h = placed.get(it.id);
        if (h) { if (!bySeg.has(h.seg)) bySeg.set(h.seg, []); bySeg.get(h.seg).push({ it, h }); }
    });
    if (items.length > shown.length) rows.push(ctx(`${ind}${el.tag === "PipingNetworkSegment" ? "  " : "    "}... ${items.length - shown.length} more`));
    rows.push(del(lines[lines.length - 1]));
    bySeg.forEach((list, segId) => {
        const target = findElement(text, segId);
        const tl = target ? splitLines(target.raw) : [`<PipingNetworkSegment ID="${segId}" ...>`, "</PipingNetworkSegment>"];
        const ci = target ? childIndent(target.raw, tl[0]) : "  ";
        rows.push(ctx(""), ctx(tl[0]), ctx(`${ci}...`));
        list.forEach(({ it, h }) => {
            if (h.item) rows.push(ctx(`${ci}<... ID="${h.item}" ...>   <- after this item`));
            rows.push(add(`${ci}${startTag(it)} ... </${it.el.tagName}>   (content unchanged)`));
        });
        rows.push(ctx(tl[tl.length - 1]));
    });
    const loose = items.filter(it => !placed.has(it.id)).map(it => it.id);
    return {
        heading: placed.size ? "Suggested fix" : "What to change",
        rows,
        notes: [
            `${el.cls} is a COMOS helper container for piping items that are not on a pipe run. It is not a DEXPI class, so it gets no ComponentClassURI (and is not in the DISC profile, PRF-SCP-01). Do not give it a class or URI - empty it and remove it.`,
            ...(placed.size ? [`Move each item into the PipingNetworkSegment its node touches (green, found by matching node coordinates): ${[...placed].map(([i, h]) => `${i} -> ${h.seg}`).join(", ")}.`] : []),
            ...(loose.length ? [`${loose.join(", ")} touch${loose.length === 1 ? "es" : ""} no pipe: fix its node coordinates so it sits on the pipe it belongs to, or delete it if it is a leftover from the drawing.`] : []),
            `Then delete the empty container(s) and every Association pointing at them: ${removeRows([id, ...(el.tag === "PipingNetworkSegment" ? [] : segIds)])}.`,
            ...(el.tag === "PipingNetworkSegment" ? ["If the Orphan PipingNetworkSystem around it is then empty, delete it as well."] : []),
        ],
    };
}

// A piping item without nodes: ConnectionPoints with the Default node and one node per
// connection, placed on the node / CenterLine end of what it connects to.
function fixMissingNodes(text, el) {
    const lines = splitLines(el.raw);
    const id = (/\bID="([^"]+)"/.exec(lines[0]) || [])[1];
    if (!id) return null;
    const item = parseXml(el.raw);
    const loc = item && kids(item, "Position")[0] && readPt(kids(kids(item, "Position")[0], "Location")[0]);
    // Node numbers other objects already use for this item.
    const used = new Set();
    for (const m of text.matchAll(new RegExp(`<Connection\\b[^>]*>`, "g"))) {
        for (const side of ["From", "To"]) {
            if (new RegExp(`\\b${side}ID="${esc(id)}"`).test(m[0])) {
                const n = (new RegExp(`\\b${side}Node="(\\d+)"`).exec(m[0]) || [])[1];
                used.add(n ? +n : 1);
            }
        }
    }
    const count = Math.max(1, ...used);
    // What it touches: another item's node or a CenterLine end at (or nearest to) its position.
    let hit = null;
    if (loc) segmentPorts(text).forEach(pp => {
        if (pp.item === id) return;
        const d = dist(pp.p, loc);
        if (!hit || d < hit.d) hit = { ...pp, d };
    });
    if (hit && hit.d > SNAP_GAP) hit = null;
    const p = hit ? hit.p : loc;
    const x = p ? fmt(p.x) : "{X}", y = p ? fmt(p.y) : "{Y}";
    const pos = ind => [`${ind}<Position>`, `${ind}  <Location X="${x}" Y="${y}" Z="0"/>`, `${ind}  <Axis X="0" Y="0" Z="1"/>`, `${ind}  <Reference X="1" Y="0" Z="0"/>`, `${ind}</Position>`];
    const ci = childIndent(el.raw, lines[0]);
    const after = Math.max(lines.findIndex(l => /<\/Position>/.test(l)), lines.findIndex(l => /<Scale\b/.test(l)));
    const firstN = +nextId(text, "PipingNode").split("-").pop();
    const nodes = [];
    for (let k = 1; k <= count; k++) nodes.push(
        `${ci}  <Node Type="process" ID="PipingNode-${firstN + k - 1}">`,
        ...(k === 1 ? pos(`${ci}    `) : [`${ci}    <Position><Location X="{X}" Y="{Y}" Z="0"/><Axis X="0" Y="0" Z="1"/><Reference X="1" Y="0" Z="0"/></Position>`]),
        `${ci}  </Node>`);
    return {
        heading: hit ? "Suggested fix" : "Expected syntax",
        rows: [
            ctx(lines[0]),
            ...(after > 0 ? [ctx(`${ci}...`), ctx(lines[after])] : []),
            add(`${ci}<ConnectionPoints FlowIn="1" NumPoints="${count + 1}">`),
            add(`${ci}  <Node ID="${id}-DefaultNode"/>`),
            ...nodes.map(add),
            add(`${ci}</ConnectionPoints>`),
            ...(lines.length > after + 2 ? [ctx(`${ci}...`)] : []),
            ctx(lines[lines.length - 1]),
        ],
        notes: [
            `A piping item needs <ConnectionPoints>: the first <Node> is the Default/Origin node (node 0), then one Node per connection (node 1, 2 ...). NumPoints counts all of them.`,
            hit
                ? `Node 1 is placed at ${pt(hit.p)}, ${hit.item ? `where node ${hit.node} of ${hit.item} (segment ${hit.seg}) sits` : `the CenterLine end of segment ${hit.seg}`}${hit.d > TOL ? ` - ${fmt(hit.d)} mm from the item's Position, so check the symbol position too` : ""}. The X,Y of a node must match the X,Y of the object it connects to.`
                : `Nothing connects at the item's position${loc ? ` ${pt(loc)}` : ""}: set node 1 to the X,Y of the node or CenterLine end it connects to.`,
            ...(used.size ? [`Connections in the file already use node${used.size > 1 ? "s" : ""} ${[...used].sort().join(", ")} of ${id}, so ${count} connection node${count > 1 ? "s are" : " is"} needed.`] : []),
        ],
    };
}

function fixStartTag(el, issue) {
    const lines = splitLines(el.raw);
    const start = lines[0];
    const msg = issue.message || "";
    const code = issue.code;
    if (code === "MDL-CLS-05") {
        // Only the element's own attributes - not those of nested components with their own ID.
        const nested = nestedLines(lines);
        const own = lines.filter((l, i) => !nested.has(i)).join("\n");
        const expected = (/expected "([^"]+)"/.exec(msg) || [])[1]
            || (/<GenericAttribute\b[^>]*Name="ComponentClass"[^>]*Value="([^"]+)"/.exec(own) || [])[1]
            || el.cls;
        const uri = (/<GenericAttribute\b[^>]*Name="RDL - URI"[^>]*Value="([^"]+)"/.exec(own) || [])[1] || (expected && rdlUris.classes?.[expected]);
        let fixed = start;
        if (!/\bComponentClass="/.test(fixed)) fixed = withAttr(fixed, "ComponentClass", expected || "{DEXPI class}");
        if (!/\bComponentClassURI="/.test(fixed)) fixed = fixed.replace(/(\bComponentClass="[^"]*")/, `$1 ComponentClassURI="${uri || "{RDL URI of the class}"}"`);
        return {
            heading: expected && uri ? "Suggested fix" : "Expected syntax", rows: [del(start), add(fixed)],
            notes: [
                ...(/<GenericAttributes\b[^>]*Set="XMpLant"/.test(own) && uri ? ["Taken from the element's XMpLant GenericAttributes (ComponentClass, RDL - URI)."] : []),
                ...(el.tag === "Equipment" && !expected ? ["A COMOS note or data-sheet table exported as <Equipment>: a numbered note becomes a <Note> (LocalNoteIdentifier + NoteText); other text belongs in the drawing graphics, not the model."] : []),
            ],
        };
    }
    if (code === "MDL-CLS-02") {
        const cls = (/ComponentClass "([^"]+)"/.exec(msg) || [])[1] || el.cls;
        const leaves = [...concreteLeaves(cls)].slice(0, 6);
        return {
            heading: "Expected syntax",
            rows: [del(start), ...leaves.map(l => add(withAttr(withAttr(start, "ComponentClass", l), "ComponentClassURI", rdlUris.classes?.[l] || "{RDL URI}")))],
            notes: [`${cls} is abstract - use one of its concrete classes${cls && cls.includes("OffPageConnector") ? " (FlowIn... when a line starts at it, FlowOut... when a line ends at it)" : ""}.`],
        };
    }
    if (code === "PRF-EXT-04") {
        const uriClass = (/is the rdl_uri of DEXPI [\d.]+ class "([^"]+)"/.exec(msg) || [])[1];
        const cls = el.cls;
        const rows = [del(start)];
        if (uriClass) rows.push(add(withAttr(start, "ComponentClass", uriClass)));
        if (cls && rdlUris.classes?.[cls]) rows.push(add(withAttr(start, "ComponentClassURI", rdlUris.classes[cls])));
        return {
            heading: "Suggested fix (pick one)", rows,
            notes: [
                "ComponentClass and ComponentClassURI must name the same class: either change the class to match the URI, or the URI to match the class.",
                ...(cls === "BlindFlange" && uriClass === "Flange" ? ["COMOS uses this for a flange closed with a plug: Flange + a separate CustomPipeFitting plug (TypeName PLUG)."] : []),
            ],
        };
    }
    if (code === "SER-FMT-04") {
        return { heading: "Suggested fix", rows: [del(start), add(withAttr(start, "ApplicationVersion", "1.4"))], notes: ["The file uses DEXPI 1.4 classes, so declare ApplicationVersion=\"1.4\"."] };
    }
    if (code === "PRF-TRN-05") {
        const pos = lines.findIndex(l => /<\/Position>/.test(l));
        const ind = pos >= 0 ? indentOf(lines[pos]) : childIndent(el.raw, start);
        return {
            heading: "Suggested fix",
            rows: [ctx(start), ...(pos >= 0 ? [ctx(`${ind}<Position>...`), ctx(lines[pos])] : []), add(`${ind}<Scale X="1" Y="1" Z="1"/>`), ctx(`${ind}...`)],
            notes: ["A placed symbol needs an explicit <Scale> right after its <Position>."],
        };
    }
    return null;
}

function fixLines(el, issue, marked) {
    const code = issue.code;
    const lines = splitLines(el.raw);
    const bad = [...marked].map(i => lines[i]).filter(Boolean);
    if (!bad.length) return null;
    if (code === "GEO-GRD-01" || code === "GEO-GRD-02") {
        const round = l => l.replace(/\b([XY])="(-?[\d.]+)"/g, (m, a, v) => `${a}="${Math.round(parseFloat(v))}"`);
        const rows = []; bad.forEach(l => { if (round(l) !== l) rows.push(del(l), add(round(l))); });
        return rows.length ? {
            heading: "Suggested fix", rows,
            notes: ["Move the position/node to the 1-unit grid. Round every coordinate that has to coincide with it (connected CenterLine ends, signal line ends) the same way, or the connection breaks."],
        } : null;
    }
    if (code === "MDL-PRP-05" || code === "PRF-SCP-02") {
        const ga = bad.filter(l => /<GenericAttribute\b/.test(l));
        if (!ga.length) return null;
        const reg = ga.map(l => (/Name="SymbolRegistrationNumberAssignmentClass"[^>]*Value="([^"]*)"|Value="([^"]*)"[^>]*Name="SymbolRegistrationNumberAssignmentClass"/.exec(l) || [])).find(m => m.length);
        const value = reg && (reg[1] || reg[2]);
        if (value) {
            const start = lines[0];
            const tag = (/<([\w.:-]+)/.exec(start) || [])[1];
            return {
                heading: "Suggested fix",
                rows: [del(start), add(withAttr(start, "ComponentName", `${value}_SHAPE`)), ...ga.map(del),
                    ctx(""), ctx("<ShapeCatalogue>"), add(`  <${tag} ID="${tag}Shape-{n}" ComponentName="${value}_SHAPE">`),
                    add("    <GenericAttributes Set=\"DexpiAttributes\" Number=\"1\">"),
                    add(`      <GenericAttribute Name="SymbolRegistrationNumberAssignmentClass" AttributeURI="http://sandbox.dexpi.org/rdl/SymbolRegistrationNumberAssignmentClass" Format="string" Value="${value}"/>`),
                    add("    </GenericAttributes>"), add(`  </${tag}>`), ctx("</ShapeCatalogue>")],
                notes: ["The symbol registration number describes the symbol, not the object: keep it on the ShapeCatalogue entry and point the object at it through ComponentName. Lower GenericAttributes/@Number (or drop the block when it becomes empty)."],
            };
        }
        return { heading: "Suggested fix", rows: ga.map(del), notes: ["This property is not allowed for the object's class: remove it (and lower GenericAttributes/@Number), or use the class that declares it."] };
    }
    if (code === "SER-IDN-03" || code === "GEO-MDL-01") {
        const conn = bad.find(l => /<Connection\b/.test(l)) || lines.find(l => /<Connection\b/.test(l));
        if (!conn) return null;
        const side = /\bTo(ID|Node)\b|Target/.test(issue.message) ? "To" : "From";
        return {
            heading: "Expected syntax",
            rows: [del(conn), add(withAttr(withAttr(conn, `${side}ID`, code === "GEO-MDL-01" ? "{ID of the ControlledActuator}" : "{ID of the object (not of its Node)}"), `${side}Node`, "{node no.}"))],
            notes: [
                `${side}ID is the ID of the object the line is drawn to; ${side}Node is the position of its <Node> in <ConnectionPoints>, counting the first (Default/Origin) node as 0 (positive values only).`,
                ...(code === "GEO-MDL-01" ? ["A signal ending in an ActuatingFunction is drawn to the ControlledActuator (ActuatingSystemComponent) of the ActuatingSystem; if the line really ends at another instrument, make that ProcessInstrumentationFunction the logical end instead."] : []),
            ],
        };
    }
    if (code === "PRF-LBL-02") {
        const t = bad.find(l => /<Text\b/.test(l)) || lines.find(l => /<Text\b/.test(l));
        if (!t) return null;
        const ind = indentOf(t);
        return {
            heading: "Expected syntax",
            rows: [ctx(t), ctx(`${ind}  <Position>...</Position>`), add(`${ind}  <TextStringFormatSpecification>`),
                add(`${ind}    <ObjectAttributesReference DependantAttribute="{Attribute}" DependantAttributeContents="Value" ItemID="{ID of the object}"/>`),
                add(`${ind}  </TextStringFormatSpecification>`), ctx(`${ind}</Text>`)],
            notes: ["With the DISC profile a label text must come from the object's attributes. Literal text (e.g. \"NOTE \") is an ObjectAttributesReference with DependantAttribute only. Free drawing text (off-page reference boxes, notes) should become the model object instead (PipeOffPageConnector, Note)."],
        };
    }
    return null;
}

function isA(cls, base) {
    const seen = new Set();
    const walk = c => c === base || (!!c && !seen.has(c) && (seen.add(c), (rdl.classes[c]?.superTypes || []).some(walk)));
    return walk(cls);
}
const SANDBOX = "http://sandbox.dexpi.org/rdl/";
const fnTag = (cls, id) => `<${cls} ID="${id}" ComponentClass="${cls}" ComponentClassURI="${SANDBOX}${cls}">`;
// Next free "<prefix>-n" ID in the file.
function nextId(text, prefix) {
    let n = 0;
    for (const m of text.matchAll(new RegExp(`\\bID="${esc(prefix)}-(\\d+)"`, "g"))) n = Math.max(n, +m[1]);
    return `${prefix}-${n + 1}`;
}
const NOZZLE_NOTE = "The line is drawn straight to the equipment, which is not allowed: add a Nozzle owned by the equipment at the line's end point (shown above); it needs no graphics. The line's <Connection> then goes to the Nozzle (node 1).";
// End of the signal line that touches the equipment (the end nearest the equipment's position).
function lineEndAt(el, objEl) {
    const line = parseXml(el.raw);
    if (!line) return null;
    const coords = Array.from(line.getElementsByTagName("Coordinate")).filter(c => /^(Line|PolyLine)$/.test(c.parentNode.tagName));
    if (!coords.length) return null;
    const ends = [readPt(coords[0]), readPt(coords[coords.length - 1])];
    const m = objEl && /<Location\b[^>]*\/>/.exec(objEl.raw);
    const o = m ? { x: parseFloat((/\bX="([^"]*)"/.exec(m[0]) || [])[1]), y: parseFloat((/\bY="([^"]*)"/.exec(m[0]) || [])[1]) } : null;
    return o && !isNaN(o.x) ? (dist(ends[0], o) <= dist(ends[1], o) ? ends[0] : ends[1]) : ends[0];
}
// A Nozzle (no graphics) owned by the equipment, at the point where the line meets it.
function nozzleRows(id, p, assoc) {
    const x = p ? fmt(p.x) : "{X}", y = p ? fmt(p.y) : "{Y}";
    const pos = ind => [
        `${ind}<Position>`,
        `${ind}  <Location X="${x}" Y="${y}" Z="0"/>`,
        `${ind}  <Axis X="0" Y="0" Z="1"/>`,
        `${ind}  <Reference X="1" Y="0" Z="0"/>`,
        `${ind}</Position>`,
    ];
    return [
        `<Nozzle ID="${id}" ComponentClass="Nozzle" ComponentClassURI="http://data.posccaesar.org/rdl/RDS415214">`,
        ...pos("  "),
        `  <ConnectionPoints NumPoints="2">`,
        `    <Node/>`,
        `    <Node>`,
        ...pos("      "),
        `    </Node>`,
        `  </ConnectionPoints>`,
        `  ${assoc}`,
        `</Nozzle>`,
    ].map(add);
}
// Start line / "..." / extra rows (indented as children) / end line of an element in the file.
function wrapRows(elx, extra, placeholder) {
    const indented = ci => extra.map(r => ({ ...r, text: ci + r.text }));
    if (!elx) return [ctx(placeholder), ...indented("  "), ctx(`</${/<(\w+)/.exec(placeholder)[1]}>`)];
    const ls = splitLines(elx.raw);
    const ci = childIndent(elx.raw, ls[0]);
    return [ctx(ls[0]), ...(ls.length > 2 ? [ctx(`${ci}...`)] : []), ...indented(ci), ctx(ls[ls.length - 1])];
}
// The ProcessInstrumentationFunction that owns the line: its parent, else the PIF at the other end.
function linePif(text, el, otherEnd) {
    const parent = ancestorsAt(text, el.offset).pop();
    const isPif = x => x && x.tag === "ProcessInstrumentationFunction" && !/^Orphan/.test(x.cls || "");
    const p = parent && parent.tag === "ProcessInstrumentationFunction" ? findElement(text, parent.id) : null;
    if (isPif(p)) return p;
    const a = associations(el.raw).find(x => x.type === otherEnd);
    const pif = a && findElement(text, a.itemId);
    return isPif(pif) ? pif : null;
}
// ActuatingSystem whose OperatedValveReference "refers to" the valve.
function actuatingSystemOf(text, valveId) {
    const re = new RegExp(`<Association\\b[^>]*?\\bType="refers to"[^>]*?\\bItemID="${esc(valveId)}"`, "g");
    for (const m of text.matchAll(re)) {
        const as = ancestorsAt(text, m.index).filter(x => x.tag === "ActuatingSystem").pop();
        if (as) return findElement(text, as.id);
    }
    return null;
}

function fixSignalEnd(text, issue, el) {
    const m = /^(Source|Target) object "([^"]+)" has ComponentClass "([^"]+)"/.exec(issue.message || "");
    if (!m) return null;
    const [, role, objId, objCls] = m;
    const lines = splitLines(el.raw);
    const ind = childIndent(el.raw, lines[0]);
    const assoc = lines.find(l => l.includes(`ItemID="${objId}"`) && /has logical (start|end)/.test(l));
    const objEl = findElement(text, objId);
    const objTag = objEl ? objEl.tag : "";
    const lineId = issue.objectId;
    const swap = (newId, head) => [
        ...head,
        ...(lines.length > 2 ? [ctx(`${ind}...`)] : []),
        ...(assoc ? [del(assoc)] : []),
        add(`${assoc ? indentOf(assoc) : ind}<Association Type="has logical ${role === "Source" ? "start" : "end"}" ItemID="${newId}"/>`),
        ctx(lines[lines.length - 1]),
    ];
    const pifPlaceholder = who => `<ProcessInstrumentationFunction ID="{${who}}" ...>`;

    if (objCls === "SignalOffPageConnector" && objEl) {
        const cls = role === "Source" ? "FlowInSignalOffPageConnector" : "FlowOutSignalOffPageConnector";
        const ol = splitLines(objEl.raw);
        return {
            heading: "Suggested fix",
            rows: [del(ol[0]), add(ol[0].replace(/ComponentClass="[^"]*"/, `ComponentClass="${cls}"`).replace(/ComponentClassURI="[^"]*"/, `ComponentClassURI="${SANDBOX}${cls}"`))],
            notes: [
                `SignalOffPageConnector is abstract. A line that ${role === "Source" ? "comes in from another drawing starts at a FlowInSignalOffPageConnector" : "continues on another drawing ends at a FlowOutSignalOffPageConnector"}.`,
                "The connector holds a SignalOffPageConnectorReferenceByNumber with ReferencedConnectorNumber / ReferencedDrawingNumber.",
            ],
        };
    }

    if (role === "Source") {
        const psgf = nextId(text, "ProcessSignalGeneratingFunction");
        const pif = linePif(text, el, "has logical end");
        const onEquipment = objTag === "Equipment" || isA(objCls, "Equipment");
        const nozzle = onEquipment ? nextId(text, "Nozzle") : null;
        const location = nozzle || objId;
        const head = el.cls === "MeasuringLineFunction"
            ? [ctx(lines[0])]
            : [del(lines[0]), add(withAttr(withAttr(lines[0], "ComponentClass", "MeasuringLineFunction"), "ComponentClassURI", `${SANDBOX}MeasuringLineFunction`))];
                const rows = [
            ...swap(psgf, head),
            ctx(""),
            ...wrapRows(pif, [
                add(`${fnTag("ProcessSignalGeneratingFunction", psgf)}`),
                add(`  <Association Type="is logical start of" ItemID="${lineId}"/>`),
                add(`  <Association Type="is located in" ItemID="${location}"/>`),
                add(`</ProcessSignalGeneratingFunction>`),
            ], pifPlaceholder("the instrument at the other end of the line")),
            ctx(""),
        ];
        const reverse = `<Association Type="is the location of" ItemID="${psgf}"/>`;
        if (nozzle) {
            rows.push(...wrapRows(objEl, nozzleRows(nozzle, lineEndAt(el, objEl), reverse), `<Equipment ID="${objId}" ...>`));
        } else {
            rows.push(...wrapRows(objEl, [add(`${reverse}`)], `<${objTag || "PipingComponent"} ID="${objId}" ...>`));
        }
        return {
            heading: "Expected syntax",
            rows,
            notes: [
                `A measuring line cannot start at ${objId} (${objCls}). DISC requirement: a MeasuringLineFunction has a ProcessSignalGeneratingFunction as Source; the PSGF is a child of the instrument (ProcessInstrumentationFunction) and its SensingLocation ("is located in") is the Nozzle, PipingComponent or PipingNetworkSegment it measures.`,
                onEquipment
                    ? `${objId} is equipment. ${NOZZLE_NOTE}`
                    : "For an off-line instrument drawn straight to a pipe, use the PipingNetworkSegment as SensingLocation instead.",
                pif ? `${pif.cls || "ProcessInstrumentationFunction"} ${(/\bID="([^"]+)"/.exec(pif.raw) || [])[1]} (line ${pif.line}) is the instrument this line belongs to.` : "The line has no Target instrument: add <Association Type=\"has logical end\" ItemID=\"{PIF ID}\"/> and the reverse \"is logical end of\" on that instrument as well.",
                "The line's <Connection> / graphics stay as they are.",
            ],
        };
    }

    const isValve = isA(objCls, "OperatedValve") || isA(objCls, "PipingComponent") || objTag === "PipingComponent";
    const pif = linePif(text, el, "has logical start");
    const pifRows = extra => wrapRows(pif, extra, pifPlaceholder("the sending instrument (Source of the line)"));
    if (isValve) {
        const as = actuatingSystemOf(text, objId);
        const asId = as && (/\bID="([^"]+)"/.exec(as.raw) || [])[1];
        const af = as && associations(as.raw).find(a => a.type === "fulfills");
        if (af) {
            return {
                heading: "Suggested fix",
                rows: swap(af.itemId, [ctx(lines[0])]),
                notes: [
                    `${objId} is operated by ActuatingSystem ${asId} (line ${as.line}), which fulfils ${af.itemId}: end the signal line at that ActuatingFunction.`,
                    `Also add <Association Type="is logical end of" ItemID="${lineId}"/> to ${af.itemId}.`,
                ],
            };
        }
        const afId = nextId(text, "ActuatingFunction");
        const newAs = asId || nextId(text, "ActuatingSystem");
        const rows = [...swap(afId, [ctx(lines[0])]), ctx(""), ...pifRows([
            add(`${fnTag("ActuatingFunction", afId)}`),
            add(`  <Association Type="is logical end of" ItemID="${lineId}"/>`),
            add(`  <Association Type="is fulfilled by" ItemID="${newAs}"/>`),
            add("</ActuatingFunction>"),
        ]), ctx("")];
        if (as) rows.push(...wrapRows(as, [add(`<Association Type="fulfills" ItemID="${afId}"/>`)]));
        else rows.push(
            add(`  ${fnTag("ActuatingSystem", newAs)}`),
            add(`    <ActuatingSystemComponent ID="${nextId(text, "ControlledActuator")}" ComponentClass="ControlledActuator" ComponentClassURI="${SANDBOX}ControlledActuator">`),
            add("      <!-- symbol, Position, ConnectionPoints; TypeCodeAssignmentClass (noaka) and FailActionSpecialization -->"),
            add("    </ActuatingSystemComponent>"),
            add(`    <ActuatingSystemComponent ID="${nextId(text, "OperatedValveReference")}" ComponentClass="OperatedValveReference" ComponentClassURI="${SANDBOX}OperatedValveReference">`),
            add(`      <Association Type="refers to" ItemID="${objId}"/>`),
            add("    </ActuatingSystemComponent>"),
            add(`    <Association Type="fulfills" ItemID="${afId}"/>`),
            add("  </ActuatingSystem>"),
        );
        return {
            heading: "Expected syntax",
            rows,
            notes: [
                `A signal line cannot end at the valve ${objId}. DISC model for an actuated valve: instrument (ProcessInstrumentationFunction) -> ActuatingFunction (Target of the line) -> "is fulfilled by" ActuatingSystem { ControlledActuator, OperatedValveReference "refers to" the valve }.`,
                as ? `${objId} already has ActuatingSystem ${asId} (line ${as.line}); only the ActuatingFunction is missing.` : "The ActuatingSystem is a direct child of PlantModel.",
            ],
        };
    }
    const aef = nextId(text, "ActuatingElectricalFunction");
    const nozzle = nextId(text, "Nozzle");
    return {
        heading: "Expected syntax",
        rows: [...swap(aef, [ctx(lines[0])]), ctx(""), ...pifRows([
            add(`${fnTag("ActuatingElectricalFunction", aef)}`),
            add(`  <Association Type="is logical end of" ItemID="${lineId}"/>`),
            add(`  <Association Type="is located in" ItemID="${nozzle}"/>`),
            add("</ActuatingElectricalFunction>"),
        ]), ctx(""), ...wrapRows(objEl, nozzleRows(nozzle, lineEndAt(el, objEl), `<Association Type="is the location of" ItemID="${aef}"/>`), `<Equipment ID="${objId}" ...>`)],
        notes: [
            `A signal line cannot end at ${objId} (${objCls}). For electrically powered equipment (motor, heater) the Target is an ActuatingElectricalFunction whose ActuatingElectricalLocation ("is located in") is a Nozzle on the equipment.`,
            NOZZLE_NOTE,
        ],
    };
}

const NOTE_ONLY = {
    "MDL-MUL-03": ["The property allows only one value but several are linked (red lines). Keep the one that is right and remove the other(s), together with the reverse Association on the removed object."],
    "MDL-REF-05": ["Every ProcessInstrumentationFunction should be the Source or Target of at least one signal line: an InformationFlow with <Association Type=\"has logical start\"/\"has logical end\" ItemID=\"{this ID}\"/>, and the reverse \"is logical start of\"/\"is logical end of\" on this object."],
    "GEO-NCT-01": ["The object is not connected to any pipe or signal line: one of its ConnectionPoints nodes must have the same X/Y as a CenterLine end (or a node) of the line it sits on. For a PropertyBreak on the middle of a pipe, split the CenterLine at the break's node(s)."],
    "MDL-CMP-03": ["Add the missing sub-element. For a piping component that is <ConnectionPoints NumPoints=\"n\"> with a Default/Origin <Node/> first, then one <Node> with <Position><Location X Y Z/></Position> per connection."],
    "PRF-SYM-01": ["ComponentName must point at a ShapeCatalogue entry that carries SymbolRegistrationNumberAssignmentClass (e.g. ComponentName=\"ND0006_SHAPE\" and a catalogue element with Value=\"ND0006\"), and the profile must declare that symbol."],
    "PRF-SYM-02": ["The drawn symbol belongs to another class: either change ComponentClass to the class the symbol is meant for, or use a Custom... class whose TypeURIAssignmentClass names that class, or pick the symbol registered for this class."],
    "MDL-CLS-01": ["Use a class of the DEXPI 1.4 model or of the DiscProfile.xml. A vendor class becomes Custom<BaseClass> (e.g. CustomOperatedValve) with TypeNameAssignmentClass / TypeURIAssignmentClass saying what it really is."],
    "PRF-SCP-01": ["The class is not in the DISC profile's AllowedClasses: change ComponentClass (and ComponentClassURI) to a class the profile allows - the DEXPI class it really is, or a Custom<BaseClass> with TypeName/TypeURI saying what it is."],
    "SER-VAL-04": ["Use one of the values of the profile list named in the message, or an empty string."],
};

// ---- GenericAttributes sets --------------------------------------------------

// Name of the unconverted export the file was made from ("Raw_<name>"), for the notes.
function rawFileName(fileName) {
    if (!fileName) return "the Raw_ export of this file";
    const base = fileName.split(/[\\/]/).pop().replace(/^(Fixed_)+/i, "");
    return /^Raw_/i.test(base) ? null : `Raw_${base}`;
}
const attrCount = raw => (raw.match(/<GenericAttribute\b/g) || []).length;
// Other attribute sets on an element: "ComosProperties (11), TechnicalData (4)".
function otherSets(raw, skipSet) {
    const out = [];
    for (const m of raw.matchAll(/<GenericAttributes\b([^>]*?)(\/?)>/g)) {
        const set = (/\bSet="([^"]*)"/.exec(m[1]) || [])[1] || "(no Set)";
        if (set === skipSet) continue;
        const body = m[2] ? "" : raw.slice(m.index, raw.indexOf("</GenericAttributes>", m.index));
        out.push(`${set} (${attrCount(body)})`);
    }
    return out;
}
// Data properties of a class (own and inherited) as <GenericAttribute> template lines.
function dataPropertyRows(cls, max) {
    const out = [], seen = new Set();
    const walk = c => {
        if (!rdl.classes[c] || seen.has(c)) return;
        seen.add(c);
        (rdl.classes[c].ownedProperties || []).forEach(full => {
            if ((rdl.properties[full] || {}).kind !== "Data") return;
            const name = full.slice(full.indexOf(".") + 1);
            const uri = rdlUris.properties?.[full] || `${SANDBOX}${name}AssignmentClass`;
            out.push(`<GenericAttribute Name="${uri.slice(uri.lastIndexOf("/") + 1)}" AttributeURI="${uri}" Format="string" Value="{value}"/>`);
        });
        (rdl.classes[c].superTypes || []).forEach(walk);
    };
    walk(cls);
    return { rows: out.slice(0, max), more: Math.max(0, out.length - max) };
}

function fixEmptyAttributes(text, el, fileName) {
    const line = splitLines(el.raw)[0];
    const set = (/\bSet="([^"]*)"/.exec(line) || [])[1] || "";
    const parent = parentStartLine(text, el.offset);
    const parentId = parent && (/\bID="([^"]+)"/.exec(parent.text) || [])[1];
    const parentCls = parent && (/\bComponentClass="([^"]+)"/.exec(parent.text) || [])[1];
    const owner = parentId ? findElement(text, parentId) : null;
    const ind = indentOf(line);
    const tmpl = set === "DexpiAttributes" && parentCls ? dataPropertyRows(parentCls, 6) : { rows: [], more: 0 };
    const raw = rawFileName(fileName);
    const others = owner ? otherSets(owner.raw, set) : [];
    const rows = [
        ...(parent ? [ctx(parent.text), ctx(`${ind}...`)] : []),
        del(line),
        ctx(""),
        ctx(`${ind}<!-- or keep the set and fill it: -->`),
        add(`${ind}<GenericAttributes Set="${set || "DexpiAttributes"}" Number="{count}">`),
        ...(tmpl.rows.length ? tmpl.rows : [`<GenericAttribute Name="{Property}AssignmentClass" AttributeURI="{attribute URI}" Format="string" Value="{value}"/>`]).map(r => add(`${ind}  ${r}`)),
        ...(tmpl.more ? [ctx(`${ind}  <!-- ${tmpl.more} more ${parentCls} propert${tmpl.more === 1 ? "y" : "ies"} -->`)] : []),
        add(`${ind}</GenericAttributes>`),
    ];
    return {
        heading: "Expected syntax",
        rows,
        notes: [
            "An empty <GenericAttributes/> is not allowed: it must hold at least one <GenericAttribute>. Either delete the empty set (red), or fill it with the attributes it should carry (green) and set Number to how many there are.",
            raw ? `To see what belongs in it, open ${raw} and find ${parentId ? `ID="${parentId}"` : "the same element"}: copy the <GenericAttribute> rows of its Set="${set}" group, or take the values from its other attribute sets (e.g. ComosProperties).` : `This is the raw export: the values are not in this set, see the other attribute sets on ${parentId || "the element"}.`,
            ...(others.length ? [`Other attribute sets on ${parentId}${parentCls ? ` (${parentCls})` : ""}: ${others.join(", ")}.`] : []),
            ...(tmpl.rows.length ? [`The green rows are the ${parentCls} data properties of the DEXPI 1.4 model; keep only those that have a value.`] : []),
        ],
    };
}

function fixAttributeCount(text, issue, el, fileName) {
    const m = /Set="([^"]*)" declares Number="(\d+)" but actually contains (\d+)/.exec(issue.message || "");
    if (!m) return null;
    const [, set, declared, actual] = m;
    const lines = splitLines(el.raw);
    const groupEnd = k => /\/>\s*$/.test(lines[k]) ? k : lines.findIndex((x, j) => j > k && /<\/GenericAttributes>/.test(x));
    const starts = lines.map((l, k) => /<GenericAttributes\b/.test(l) && l.includes(`Set="${set}"`) && l.includes(`Number="${declared}"`) ? k : -1).filter(k => k >= 0);
    const at = starts.find(k => attrCount(lines.slice(k + 1, groupEnd(k)).join("\n")) === +actual) ?? (starts.length ? starts[0] : -1);
    if (at < 0) return null;
    const raw = rawFileName(fileName);
    const names = [];
    for (let k = at + 1; !/\/>\s*$/.test(lines[at]) && k < lines.length && !/<\/GenericAttributes>/.test(lines[k]); k++) {
        const n = (/<GenericAttribute\b[^>]*\bName="([^"]+)"/.exec(lines[k]) || [])[1];
        if (n) names.push(n);
    }
    const rows = +actual === 0
        ? [del(lines[at]), ...(/\/>\s*$/.test(lines[at]) ? [] : [del(lines[at + 1] || "")])]
        : [del(lines[at]), add(withAttr(lines[at], "Number", actual))];
    return {
        heading: "Suggested fix",
        rows,
        notes: [
            +actual === 0
                ? `The set is empty: delete it (an empty <GenericAttributes> is also a schema error), or fill it from ${raw || "the export sets"}.`
                : `Number must equal the number of <GenericAttribute> rows: change Number="${declared}" to Number="${actual}" (red/green).`,
            +actual < +declared
                ? `Or ${+declared - +actual} attribute${+declared - +actual === 1 ? " was" : "s were"} lost: ${raw ? `open ${raw}, find ID="${issue.objectId}" and compare its Set="${set}" group` : `compare with the other attribute sets on ${issue.objectId}`} with the rows here${names.length ? ` (${names.join(", ")})` : ""}, copy the missing ones and keep Number="${declared}".`
                : `There are more rows than declared: check for duplicates${names.length ? ` (${names.join(", ")})` : ""}, then set Number to the final count.`,
        ],
    };
}

function buildFix(text, issue, el, marked, fileName) {
    const f = buildFixRows(text, issue, el, marked, fileName);
    if (f) return f;
    const notes = NOTE_ONLY[issue.code];
    return notes ? { heading: "What to change", rows: [], notes } : null;
}

function buildFixRows(text, issue, el, marked, fileName) {
    const code = issue.code || "";
    if (code === "SER-STR-01") return fixNotExpected(text, issue);
    if (!el) return null;
    if (code === "MDL-REF-07" && /has no \w+ reference/.test(issue.message || "")) return fixMissingReference(text, issue, el);
    if (code === "GEO-ALN-01") return fixSegmentContinuity(issue, el);
    if (code === "MDL-REF-03") return fixSignalEnd(text, issue, el);
    if (code === "SER-REQ-02" && el.tag === "GenericAttributes" && !/<GenericAttribute\b/.test(el.raw)) return fixEmptyAttributes(text, el, fileName);
    if (code === "SER-CNT-01") return fixAttributeCount(text, issue, el, fileName);
    if (code === "MDL-CMP-03" && /no ConnectionPoints\/Node/.test(issue.message || "")) return fixMissingNodes(text, el);
    if (/^Orphan/.test(el.cls || "") && ["MDL-CLS-05", "MDL-CLS-01", "PRF-SCP-01"].includes(code)) return fixOrphanContainer(text, el);
    return fixStartTag(el, issue) || fixLines(el, issue, marked);
}

// ---- Model summary ----------------------------------------------------------

function classSummary(className) {
    const info = rdl.classes[className];
    if (!info) return null;
    const props = [];
    const seen = new Set();
    const visited = new Set();
    const walk = cls => {
        const c = rdl.classes[cls];
        if (!c || visited.has(cls)) return;
        visited.add(cls);
        (c.ownedProperties || []).forEach(full => {
            const name = full.slice(full.indexOf(".") + 1);
            if (seen.has(name)) return;
            seen.add(name);
            const p = rdl.properties[full] || {};
            const upper = p.upper == null || p.upper === -1 ? "*" : p.upper;
            const range = p.lower != null ? ` [${p.lower}..${upper}]` : "";
            props.push(`- ${name}: ${p.valueType || p.kind || "?"}${range}${cls !== className ? ` (from ${cls})` : ""}`);
        });
        (c.superTypes || []).forEach(walk);
    };
    walk(className);
    const more = props.length - MAX_PROPS;
    return [
        `DEXPI 1.4 model for ${className} (${info.kind || "class"}; supertypes: ${(info.superTypes || []).join(", ") || "none"}):`,
        ...(props.length ? props.slice(0, MAX_PROPS) : ["- no properties"]),
        ...(more > 0 ? [`- ... ${more} more`] : []),
    ].join("\n");
}

/**
 * @param {{issue: object, xmlText?: string, fileName?: string}} args
 * @returns {{ text: string,
 *             current: { first: number, rows: Array<{n?: number, text?: string, bad?: boolean, fold?: number}> } | null,
 *             fix: { heading: string, rows: Array<{op: string, text: string}>, notes: string[] } | null,
 *             script: string | null }}
 */
export function buildSuggestion({ issue, xmlText, fileName }) {
    const meta = ISSUE_CODES[issue.code] || {};
    const text = xmlText || "";
    let el = text && issue.objectId ? findElement(text, issue.objectId) : null;
    if (!el && text && issue.line != null) el = /^Schemas|Element '/.test(issue.message || "") ? elementForXsd(text, issue) : elementAtLine(text, issue.line);

    let current = null, marked = new Set();
    if (el) {
        const lines = splitLines(el.raw);
        marked = markLines(lines, issue, el.line);
        current = { first: el.line, rows: focusRows(lines, el.line, marked) };
    } else if (text && issue.line != null) {
        const sn = lineSnippet(text, issue.line);
        const lines = splitLines(sn.body);
        current = { first: sn.first, rows: lines.map((t, i) => ({ n: sn.first + i, text: t, bad: sn.first + i === issue.line })) };
    }
    const componentClass = el ? el.cls : null;
    const model = componentClass ? classSummary(componentClass) : null;
    let fix = null;
    try { fix = text ? buildFix(text, issue, el, marked, fileName) : null; } catch { fix = null; }
    const script = FIX_SCRIPTS[issue.code] || null;
    const severity = { error: "Error", warning: "Warning", info: "Info" }[issue.severity] || issue.severity || "";

    const out = [
        "I am checking a DEXPI P&ID exchange file (Proteus XML 4.1.1 schema, DEXPI 1.4 information model, DISC profile) with the AKSO DEXPI Viewer. "
        + (fix && fix.heading.startsWith("Suggested")
            ? "Explain the finding below in plain terms and check that the suggested fix is correct."
            : "Explain the finding below in plain terms and show how the XML should look to fix it. "
              + "Stay within the Proteus 4.1.1 schema and the DEXPI 1.4 model. If the fix needs information that is not given here, say what is missing instead of guessing."),
        "",
        "Finding",
        `- Code: ${issue.code || "none"}${meta.title ? ` - ${meta.title}` : ""}`,
        ...(meta.category ? [`- Category: ${meta.category}`] : []),
        ...(severity ? [`- Type: ${severity}`] : []),
        `- Message: ${issue.message || ""}`,
        ...(issue.objectId ? [`- Object: ${issue.objectId}${componentClass ? ` (ComponentClass ${componentClass})` : ""}`] : []),
        ...(fileName || issue.line != null ? [`- File: ${fileName || "(not named)"}${issue.line != null ? `, line ${issue.line}` : ""}`] : []),
    ];
    if (current) {
        const marks = current.rows.filter(r => r.bad).map(r => r.n);
        out.push("", `XML in the file${marks.length ? ` (lines marked ">>" relate to the finding: ${marks.join(", ")})` : ""}:`, "```xml",
            ...current.rows.map(r => r.fold ? `   <!-- ${r.fold} line(s) not shown -->` : `${r.bad ? ">>" : "  "} ${r.text}`), "```");
    }
    if (fix) {
        out.push("", `${fix.heading}${fix.rows.length ? ` ("-" remove, "+" add)` : ""}:`, ...(fix.rows.length ? ["```diff", ...fix.rows.map(r => `${r.op}${r.text}`), "```"] : []), ...fix.notes.map(n => `- ${n}`));
    }
    if (model) out.push("", model);
    out.push(
        "",
        "Proteus conventions used in these files: data properties are <GenericAttribute Name=\"<Property>AssignmentClass\"> inside <GenericAttributes Set=\"DexpiAttributes\"> "
        + "(or Set=\"DexpiCustomAttributes\"), linked by AttributeURI; object references are <Association Type=\"...\" ItemID=\"...\"/> "
        + "(for example \"is located in\" for a location, \"is fulfilled by\" for Systems, \"has logical start\"/\"has logical end\" for a signal Source/Target); "
        + "piping segment ends are <Connection FromID/FromNode ToID/ToNode/>; sub-components are nested <Component>/<PipingComponent> elements.",
        "",
        "Reference sources:",
        ...REFERENCE_SOURCES.map(s => `- ${s}`),
    );
    return { text: out.join("\n"), current, fix, script };
}

/** The Copilot text only (kept for callers that need just the text). */
export function buildSuggestPrompt(args) {
    return buildSuggestion(args).text;
}
