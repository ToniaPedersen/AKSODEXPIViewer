// Builds the "Suggest..." text: a self-contained question about one finding,
// for the user to paste into Copilot or another assistant. Where the fix can
// be worked out from the file (MDL-REF-07), a corrected snippet is included.

import rdl from "./dexpi14Rdl.json";
import { ISSUE_CODES } from "./issueCodes.js";

const MAX_LINES = 60;
const CONTEXT_LINES = 5;
const MAX_PROPS = 40;

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)\b([^>]*?)(\/?)>/g;
const ASSOC_RE = /<Association\b[^>]*?\bType="([^"]*)"[^>]*?\bItemID="([^"]*)"[^>]*?\/>/g;

function lineNumberAt(text, offset) {
    let n = 1;
    for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
    return n;
}

function capLines(lines, first) {
    const shown = lines.slice(0, MAX_LINES);
    const more = lines.length - shown.length;
    return {
        first,
        last: first + shown.length - 1,
        body: shown.join("\n") + (more > 0 ? `\n<!-- ... ${more} more lines -->` : ""),
    };
}

// The element carrying ID="id": raw text from the start of its line to its end tag.
function findElement(text, id) {
    const open = new RegExp(`<([A-Za-z_][\\w.:-]*)\\b[^>]*?\\bID="${esc(id)}"`).exec(text);
    if (!open) return null;
    const tag = open[1];
    const tagRe = new RegExp(`<(/?)${esc(tag)}\\b[^>]*?(/?)>`, "g");
    tagRe.lastIndex = open.index;
    let depth = 0, end = text.length;
    for (let t = tagRe.exec(text); t; t = tagRe.exec(text)) {
        if (t[1]) depth--;
        else if (!t[2]) depth++;
        if (depth === 0) { end = tagRe.lastIndex; break; }
    }
    const lineStart = text.lastIndexOf("\n", open.index) + 1;
    const raw = text.slice(lineStart, end);
    return { tag, offset: open.index, line: lineNumberAt(text, open.index), raw, cls: (/\bComponentClass="([^"]+)"/.exec(raw) || [])[1] || null };
}

function lineSnippet(text, line) {
    const all = text.split(/\r\n|\r|\n/);
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

// Inserts `line` as the last child of the element, indented like its children.
function withChildAdded(raw, line) {
    const lines = raw.split(/\r\n|\r|\n/);
    const baseIndent = (/^\s*/.exec(lines[0]) || [""])[0];
    if (lines.length === 1 && /\/>\s*$/.test(lines[0])) {
        return [lines[0].replace(/\s*\/>\s*$/, ">"), `${baseIndent}  ${line}`, `${baseIndent}</${(/<([\w.:-]+)/.exec(lines[0]) || [])[1]}>`].join("\n");
    }
    const childIndent = lines.length > 2 ? (/^\s*/.exec(lines[lines.length - 2]) || [""])[0] : `${baseIndent}  `;
    lines.splice(lines.length - 1, 0, `${childIndent}${line}`);
    return lines.join("\n");
}

// ---- MDL-REF-07 fixes -------------------------------------------------------
//
// prop -> { assoc, reverse, find(text, el) -> { id, why } | null }

function actuatingLocation(text, el) {
    const systems = associations(el.raw).filter(a => a.type === "is fulfilled by").map(a => a.itemId);
    if (!systems.length) systems.push(...reverseOwners(text, "fulfills", el.id));
    for (const sysId of systems) {
        const sys = findElement(text, sysId);
        if (!sys) continue;
        for (const ref of associations(sys.raw).filter(a => a.type === "refers to")) {
            const valve = findElement(text, ref.itemId);
            if (!valve) continue;
            const seg = ancestorsAt(text, valve.offset).filter(a => a.tag === "PipingNetworkSegment").pop();
            if (seg) {
                return { id: seg.id, why: `${el.id} is fulfilled by ${sysId}, which refers to ${ref.itemId}; ${ref.itemId} sits in ${seg.id}.` };
            }
        }
    }
    return null;
}

const reverseOf = type => (text, el) => {
    const owners = reverseOwners(text, type, el.id);
    return owners.length === 1 ? { id: owners[0], why: `${owners[0]} already carries <Association Type="${type}" ItemID="${el.id}"/>, so only this side is missing.` } : null;
};

const MISSING_REFERENCE_FIXES = {
    ActuatingLocation: { assoc: "is located in", reverse: "is the location of", find: actuatingLocation },
    ActuatingElectricalLocation: { assoc: "is located in", reverse: "is the location of", find: reverseOf("is the location of") },
    SensingLocation: { assoc: "is located in", reverse: "is the location of", find: reverseOf("is the location of") },
    Systems: { assoc: "is fulfilled by", reverse: "fulfills", find: reverseOf("fulfills") },
    Source: { assoc: "has logical start", reverse: "is logical start of", find: reverseOf("is logical start of") },
    Target: { assoc: "has logical end", reverse: "is logical end of", find: reverseOf("is logical end of") },
};

function missingReferenceFix(text, issue, el) {
    const m = /has no (\w+) reference/.exec(issue.message || "");
    const rule = m && MISSING_REFERENCE_FIXES[m[1]];
    if (!rule) return null;
    const target = rule.find(text, { ...el, id: issue.objectId });
    if (!target) return null;
    const out = [
        `1. Add the reference to ${issue.objectId} (line ${el.line}):`,
        "```xml",
        capLines(withChildAdded(el.raw, `<Association Type="${rule.assoc}" ItemID="${target.id}"/>`).split("\n"), el.line).body,
        "```",
    ];
    const targetEl = findElement(text, target.id);
    const hasReverse = targetEl && associations(targetEl.raw).some(a => a.type === rule.reverse && a.itemId === issue.objectId);
    if (targetEl && !hasReverse) {
        out.push(
            `2. Add the matching reference as a direct child of ${target.id} (line ${targetEl.line}):`,
            "```xml",
            `<Association Type="${rule.reverse}" ItemID="${issue.objectId}"/>`,
            "```",
        );
    }
    out.push(`Why ${target.id}: ${target.why}`);
    return out.join("\n");
}

function suggestedFix(text, issue) {
    if (!text || !issue.objectId || issue.code !== "MDL-REF-07") return null;
    const el = findElement(text, issue.objectId);
    if (!el) return null;
    return missingReferenceFix(text, issue, el);
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
 * @returns {string}
 */
export function buildSuggestPrompt({ issue, xmlText, fileName }) {
    const meta = ISSUE_CODES[issue.code] || {};
    const text = xmlText || "";
    const el = text && issue.objectId ? findElement(text, issue.objectId) : null;
    const snippet = el
        ? capLines(el.raw.split(/\r\n|\r|\n/), el.line)
        : text && issue.line != null ? lineSnippet(text, issue.line) : null;
    const componentClass = el ? el.cls : snippet ? (/\bComponentClass="([^"]+)"/.exec(snippet.body) || [])[1] : null;
    const model = componentClass ? classSummary(componentClass) : null;
    const fix = suggestedFix(text, issue);
    const severity = { error: "Error", warning: "Warning", info: "Info" }[issue.severity] || issue.severity || "";

    const out = [
        fix
            ? "I am checking a DEXPI P&ID exchange file (Proteus XML 4.1.1 schema, DEXPI 1.4 information model, DISC profile) with the AKSO DEXPI Viewer. "
              + "Explain the finding below in plain terms and check that the suggested fix is correct."
            : "I am checking a DEXPI P&ID exchange file (Proteus XML 4.1.1 schema, DEXPI 1.4 information model, DISC profile) with the AKSO DEXPI Viewer. "
              + "Explain the finding below in plain terms and show how the XML should look to fix it. "
              + "Stay within the Proteus 4.1.1 schema and the DEXPI 1.4 model. If the fix needs information that is not given here, say what is missing instead of guessing.",
        "",
        "Finding",
        `- Code: ${issue.code || "none"}${meta.title ? ` - ${meta.title}` : ""}`,
        ...(meta.category ? [`- Category: ${meta.category}`] : []),
        ...(severity ? [`- Type: ${severity}`] : []),
        `- Message: ${issue.message || ""}`,
        ...(issue.objectId ? [`- Object: ${issue.objectId}${componentClass ? ` (ComponentClass ${componentClass})` : ""}`] : []),
        ...(fileName || issue.line != null ? [`- File: ${fileName || "(not named)"}${issue.line != null ? `, line ${issue.line}` : ""}`] : []),
    ];
    if (fix) {
        out.push("", "Suggested fix", fix);
    } else if (snippet) {
        out.push("", `XML (lines ${snippet.first}-${snippet.last}):`, "```xml", snippet.body, "```");
    }
    if (model) out.push("", model);
    out.push(
        "",
        "Proteus conventions used in these files: data properties are <GenericAttribute Name=\"<Property>AssignmentClass\"> inside <GenericAttributes Set=\"DexpiAttributes\"> "
        + "(or Set=\"DexpiCustomAttributes\"), linked by AttributeURI; object references are <Association Type=\"...\" ItemID=\"...\"/> "
        + "(for example \"is located in\" for a location, \"is fulfilled by\" for Systems, \"has logical start\"/\"has logical end\" for a signal Source/Target); "
        + "piping segment ends are <Connection FromID/FromNode ToID/ToNode/>; sub-components are nested <Component>/<PipingComponent> elements.",
    );
    return out.join("\n");
}
