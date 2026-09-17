// Line numbers for findings, resolved against the raw file text.
//
// The browser's DOMParser does not record source positions, so a finding's
// line is recovered from the text itself: the line the object's ID attribute
// sits on, refined to the line of whatever the message quotes when that text
// appears inside the object. Findings with no object fall back to the first
// line carrying the quoted text.

const ID_ATTR = /\b(?:ID|id)\s*=\s*"([^"]*)"/g;
const QUOTED = /"([^"]{2,120})"/g;

// How far past the object's own line to look for quoted text before giving up
// and reporting the object's line.
const WINDOW = 200;

/**
 * @param {string} text - the raw XML
 * @returns {(finding:{objectId?:string,message?:string}) => number|null}
 */
export function buildLineResolver(text) {
    if (!text) return () => null;

    const lines = text.split(/\r\n|\r|\n/);

    // Offset of each line start, so a match index maps to a line in log time.
    const starts = new Array(lines.length);
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
        starts[i] = at;
        at += lines[i].length + 1;
    }
    const lineAt = (offset) => {
        let lo = 0, hi = lines.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };

    const idLine = new Map();
    ID_ATTR.lastIndex = 0;
    for (let m = ID_ATTR.exec(text); m; m = ID_ATTR.exec(text)) {
        if (!idLine.has(m[1])) idLine.set(m[1], lineAt(m.index));
    }

    const quotedIn = (message) => {
        const out = [];
        QUOTED.lastIndex = 0;
        for (let m = QUOTED.exec(String(message || "")); m; m = QUOTED.exec(String(message || ""))) out.push(m[1]);
        return out;
    };

    return (finding) => {
        const quoted = quotedIn(finding?.message);
        const base = finding?.objectId ? idLine.get(finding.objectId) : undefined;

        if (base) {
            const last = Math.min(lines.length, base + WINDOW);
            for (const q of quoted) {
                for (let ln = base; ln <= last; ln++) if (lines[ln - 1].includes(q)) return ln;
            }
            return base;
        }

        for (const q of quoted) {
            for (let ln = 1; ln <= lines.length; ln++) if (lines[ln - 1].includes(q)) return ln;
        }
        return null;
    };
}
