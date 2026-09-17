// Drill-down over a folder run's findings: Layer -> Category -> Code, then the
// documents a code was raised in and the lines it was raised on. Reads a line's
// source text straight from the picked File, so nothing is re-validated here.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ISSUE_CODES, LAYER_LABELS } from "./issueCodes.js";

const SEV_COLORS = { error: "#cf222e", warning: "#b45309", info: "#0969da" };
const SEV_LABELS = { error: "Error", warning: "Warning", info: "Info" };
const SEV_ORDER = ["error", "warning", "info"];

const LAYER_DESC = {
    SER: "Is the file itself valid? XML well-formedness, schema conformance, declared version, ids and references - checks that need nothing but the document.",
    MDL: "Is the information model coherent once the file is read? Class usage, composition, multiplicity, properties and reference endpoints.",
    PRF: "Conformance to the DISC profile rather than to DEXPI at large. Symbol scope and usage, transforms, variant selection and label templates.",
    GEO: "Where things sit on the drawing. Node positions, grid alignment, connection alignment, approach direction and node counts.",
};

const fmt = n => n.toLocaleString("en-US");
const shortPath = p => String(p).split("/").pop();

const X = {
    scrim: { position: "fixed", inset: 0, background: "rgba(13,17,23,0.38)", zIndex: 60, display: "flex", justifyContent: "center", padding: 24, boxSizing: "border-box" },
    shell: { width: "75%", maxWidth: "100%", minWidth: 0, background: "#fff", border: "1px solid #d0d7de", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontFamily: "Arial, sans-serif", color: "#111" },
    head: { padding: "10px 14px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexShrink: 0 },
    bar: { padding: "6px 14px", borderBottom: "1px solid #eef2f6", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 0 },
    body: { flex: 1, display: "grid", gridTemplateColumns: "1fr 320px", minHeight: 0 },
    main: { overflow: "auto", padding: "10px 14px", minWidth: 0 },
    side: { overflow: "auto", borderLeft: "1px solid #d0d7de", background: "#fafbfc", padding: "12px 14px", minWidth: 0 },
    btn: { padding: "3px 7px", border: "1px solid #c7ced6", background: "white", borderRadius: 4, cursor: "pointer", fontSize: 12 },
    chip: (on) => ({ padding: "3px 8px", border: `1px solid ${on ? "#0969da" : "#c7ced6"}`, background: on ? "#0969da" : "white", color: on ? "white" : "#111", borderRadius: 4, cursor: "pointer", fontSize: 12 }),
    badge: (color) => ({ display: "inline-block", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: color || "#eef2f6", color: color ? "white" : "#444" }),
    row: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "5px 6px", border: "none", borderBottom: "1px solid #f0f3f6", background: "none", cursor: "pointer", textAlign: "left", font: "inherit" },
    track: { flex: 1, minWidth: 60, height: 16, background: "#f0f3f6", borderRadius: 3, overflow: "hidden", display: "flex" },
    mono: { fontFamily: "monospace", fontSize: 11 },
    dt: { color: "#57606a" },
};

function mkNode(key, label, kind) {
    return { key, label, kind, children: [], map: new Map(), n: 0, docs: new Set(), sev: { error: 0, warning: 0, info: 0 }, issues: [] };
}

function tally(node, issue) {
    node.n++;
    node.docs.add(issue.path);
    node.sev[issue.severity] = (node.sev[issue.severity] || 0) + 1;
}

function child(parent, key, label, kind) {
    let c = parent.map.get(key);
    if (!c) { c = mkNode(key, label, kind); c.parent = parent; parent.map.set(key, c); parent.children.push(c); }
    return c;
}

/** Layer -> Category -> Code, rolled up from the folder run's findings. */
function buildTree(issues) {
    const root = mkNode("", "All layers", "root");
    for (const issue of issues) {
        const meta = ISSUE_CODES[issue.code] || {};
        const layer = meta.layer || String(issue.code || "").slice(0, 3) || "UNK";
        const cat = meta.category || "Unclassified";
        const L = child(root, layer, LAYER_LABELS[layer] || layer, "layer");
        const C = child(L, `${layer}|${cat}`, cat, "cat");
        const K = child(C, issue.code, meta.title || issue.codeLabel || issue.code, "code");
        tally(root, issue); tally(L, issue); tally(C, issue); tally(K, issue);
        K.issues.push(issue);
    }
    return root;
}

function dominantSev(node) {
    return SEV_ORDER.slice().sort((a, b) => node.sev[b] - node.sev[a])[0];
}

function nodeAt(root, path) {
    let n = root;
    for (const key of path) {
        const next = n.map.get(key);
        if (!next) break;
        n = next;
    }
    return n;
}

function chainOf(node) {
    const chain = [];
    for (let c = node; c; c = c.parent) chain.unshift(c);
    return chain;
}

function pathOf(node) {
    return chainOf(node).slice(1).map(n => n.key);
}

export default function ErrorExplorer({ issues, files, folderName, fileCount, onOpenFile, onClose }) {
    const [sevFilter, setSevFilter] = useState("All");
    const [metric, setMetric] = useState("n"); // n | docs
    const [path, setPath] = useState([]);
    const [openDocs, setOpenDocs] = useState(new Set());
    const [lineText, setLineText] = useState({}); // path -> { [line]: source text } | "loading" | "error"
    const readOnce = useRef(new Set());

    useEffect(() => {
        const onKey = e => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const shown = useMemo(
        () => (sevFilter === "All" ? issues : issues.filter(i => SEV_LABELS[i.severity] === sevFilter)),
        [issues, sevFilter]);

    const tree = useMemo(() => buildTree(shown), [shown]);
    const focus = nodeAt(tree, path);
    const value = node => (metric === "docs" ? node.docs.size : node.n);

    const kids = useMemo(
        () => focus.children.slice().sort((a, b) => value(b) - value(a) || a.key.localeCompare(b.key)),
        [focus, metric]);

    // Documents this code was raised in, most hits first.
    const docRows = useMemo(() => {
        if (focus.kind !== "code") return [];
        const byDoc = new Map();
        for (const issue of focus.issues) {
            if (!byDoc.has(issue.path)) byDoc.set(issue.path, []);
            byDoc.get(issue.path).push(issue);
        }
        return [...byDoc.entries()]
            .map(([p, list]) => ({
                path: p,
                items: list.slice().sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity)),
            }))
            .sort((a, b) => b.items.length - a.items.length || a.path.localeCompare(b.path));
    }, [focus]);

    // Source text for the lines a document was flagged on, read once per document.
    async function loadLines(docPath, items) {
        if (readOnce.current.has(docPath)) return;
        readOnce.current.add(docPath);
        const file = files?.get(docPath);
        if (!file) { setLineText(prev => ({ ...prev, [docPath]: "error" })); return; }
        setLineText(prev => ({ ...prev, [docPath]: "loading" }));
        try {
            const lines = (await file.text()).split(/\r\n|\r|\n/);
            const wanted = {};
            for (const it of items) if (it.line != null && lines[it.line - 1] != null) wanted[it.line] = lines[it.line - 1].trim();
            setLineText(prev => ({ ...prev, [docPath]: wanted }));
        } catch {
            setLineText(prev => ({ ...prev, [docPath]: "error" }));
        }
    }

    function toggleDoc(docPath, items) {
        setOpenDocs(prev => {
            const next = new Set(prev);
            if (next.has(docPath)) next.delete(docPath);
            else { next.add(docPath); loadLines(docPath, items); }
            return next;
        });
    }

    function drill(node) {
        setPath(pathOf(node));
        setOpenDocs(new Set());
    }

    const max = Math.max(1, ...kids.map(value));
    const chain = chainOf(focus);
    const meta = focus.kind === "code" ? (ISSUE_CODES[focus.key] || {}) : null;

    return (
        <div style={X.scrim} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div style={X.shell}>
                <div style={X.head}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>Error explorer</span>
                    <span style={{ fontSize: 11, color: "#57606a" }}>
                        {folderName ? `${folderName} · ` : ""}{fileCount} file{fileCount === 1 ? "" : "s"} · {fmt(issues.length)} finding{issues.length === 1 ? "" : "s"}
                    </span>
                    <button style={{ ...X.btn, marginLeft: "auto" }} onClick={onClose}>Close</button>
                </div>

                <div style={X.bar}>
                    <span style={{ fontSize: 11, color: "#57606a", textTransform: "uppercase", letterSpacing: "0.05em" }}>Size by</span>
                    <button style={X.chip(metric === "n")} onClick={() => setMetric("n")}>Occurrences</button>
                    <button style={X.chip(metric === "docs")} onClick={() => setMetric("docs")}>Documents hit</button>
                    <span style={{ width: 12 }} />
                    {["All", "Error", "Warning", "Info"].map(f => {
                        const count = f === "All" ? issues.length : issues.filter(i => SEV_LABELS[i.severity] === f).length;
                        return <button key={f} style={X.chip(sevFilter === f)} onClick={() => { setSevFilter(f); setPath([]); setOpenDocs(new Set()); }}>{f} ({fmt(count)})</button>;
                    })}
                </div>

                <div style={{ ...X.bar, gap: 4 }}>
                    {chain.map((nd, i) => (
                        <React.Fragment key={nd.key || "root"}>
                            {i === chain.length - 1
                                ? <span style={{ fontSize: 13, fontWeight: 600 }}>{nd.kind === "code" ? nd.key : nd.label}</span>
                                : <button style={{ ...X.btn, border: "none", color: "#0969da", padding: "2px 4px" }} onClick={() => drill(nd)}>{nd.kind === "code" ? nd.key : nd.label}</button>}
                            {i < chain.length - 1 && <span style={{ color: "#8b949e" }}>›</span>}
                        </React.Fragment>
                    ))}
                </div>

                <div style={X.body}>
                    <div style={X.main}>
                        {focus.kind !== "code" && kids.length === 0 && (
                            <div style={{ color: "#888", fontSize: 13, padding: 10 }}>Nothing at this level.</div>
                        )}

                        {focus.kind !== "code" && kids.map(nd => {
                            const w = (value(nd) / max) * 100;
                            return (
                                <button key={nd.key} style={X.row} onClick={() => drill(nd)} title={nd.kind === "code" ? `${nd.key} · ${nd.label}` : nd.label}>
                                    <span style={{ width: "38%", minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: nd.kind === "code" ? 400 : 600 }}>
                                        {nd.kind === "code" ? `${nd.key} · ${nd.label}` : nd.label}
                                    </span>
                                    <span style={X.track}>
                                        <span style={{ width: `${w}%`, display: "flex", borderRadius: 3, overflow: "hidden" }}>
                                            {metric === "n"
                                                ? SEV_ORDER.map(s => nd.sev[s] ? <i key={s} style={{ width: `${(nd.sev[s] / nd.n) * 100}%`, background: SEV_COLORS[s] }} /> : null)
                                                : <i style={{ width: "100%", background: SEV_COLORS[dominantSev(nd)] }} />}
                                        </span>
                                    </span>
                                    <span style={{ width: 120, textAlign: "right", fontSize: 12, color: "#57606a", fontVariantNumeric: "tabular-nums" }}>
                                        {metric === "docs" ? `${nd.docs.size} doc${nd.docs.size === 1 ? "" : "s"}` : fmt(nd.n)}
                                    </span>
                                </button>
                            );
                        })}

                        {focus.kind === "code" && docRows.map(doc => {
                            const isOpen = openDocs.has(doc.path);
                            const cache = lineText[doc.path];
                            return (
                                <div key={doc.path} style={{ borderBottom: "1px solid #eef2f6" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 6px", background: isOpen ? "#f6f8fa" : "transparent" }}>
                                        <button style={{ ...X.row, borderBottom: "none", padding: 0, flex: 1 }} onClick={() => toggleDoc(doc.path, doc.items)}>
                                            <span style={{ width: 12, color: "#888", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
                                            <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={doc.path}>{doc.path}</span>
                                            <span style={X.badge(SEV_COLORS[doc.items[0].severity])}>{doc.items.length}</span>
                                        </button>
                                        <button style={X.btn} onClick={() => onOpenFile(doc.path)} title="Load this file into the viewer">Open</button>
                                    </div>
                                    {isOpen && doc.items.map(issue => (
                                        <div key={issue.key} style={{ padding: "6px 6px 8px 30px", borderTop: "1px solid #f6f8fa" }}>
                                            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                                                <span style={X.badge(SEV_COLORS[issue.severity])}>{SEV_LABELS[issue.severity]}</span>
                                                <span style={{ ...X.mono, color: "#0969da", fontWeight: 700 }}>{issue.line != null ? `line ${issue.line}` : "line n/a"}</span>
                                                {issue.location && <span style={{ ...X.mono, color: "#57606a" }}>{issue.location}</span>}
                                                {issue.objectId && <span style={{ ...X.mono, color: "#8b949e" }}>{issue.objectId}</span>}
                                            </div>
                                            <div style={{ fontSize: 12, color: "#333" }}>{issue.message}</div>
                                            {issue.line != null && (
                                                <div style={{ ...X.mono, marginTop: 3, padding: "4px 6px", background: "#f6f8fa", border: "1px solid #eef2f6", borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#24292f" }}>
                                                    {cache === "loading" ? "reading source line…"
                                                        : cache === "error" ? "source line unavailable - the folder pick is no longer readable"
                                                            : (cache && cache[issue.line]) || "source line unavailable"}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>

                    <div style={X.side}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{focus.kind === "code" ? focus.label : focus.label}</div>
                        <div style={{ ...X.mono, color: "#57606a", marginBottom: 8 }}>
                            {focus.kind === "root" ? "whole folder run" : focus.kind === "cat" ? focus.key.split("|")[1] : focus.key}
                        </div>
                        {focus.kind === "layer" && LAYER_DESC[focus.key] && (
                            <div style={{ fontSize: 12, color: "#57606a", lineHeight: 1.5, marginBottom: 10 }}>{LAYER_DESC[focus.key]}</div>
                        )}
                        <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "#eef2f6", marginBottom: 10 }}>
                            {SEV_ORDER.map(s => focus.sev[s] ? <i key={s} style={{ width: `${(focus.sev[s] / focus.n) * 100}%`, background: SEV_COLORS[s] }} /> : null)}
                        </div>
                        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", margin: 0, fontSize: 12.5 }}>
                            <dt style={X.dt}>Occurrences</dt><dd style={{ margin: 0 }}>{fmt(focus.n)}</dd>
                            <dt style={X.dt}>Documents</dt><dd style={{ margin: 0 }}>{focus.docs.size} of {fileCount}</dd>
                            {SEV_ORDER.filter(s => focus.sev[s]).map(s => (
                                <React.Fragment key={s}>
                                    <dt style={X.dt}>{SEV_LABELS[s]}</dt><dd style={{ margin: 0 }}>{fmt(focus.sev[s])}</dd>
                                </React.Fragment>
                            ))}
                            {meta && <>
                                <dt style={X.dt}>Severity</dt><dd style={{ margin: 0 }}>{meta.severity || "-"}</dd>
                                <dt style={X.dt}>Needs</dt><dd style={{ margin: 0 }}>{meta.needs || "-"}</dd>
                                <dt style={X.dt}>Scope</dt><dd style={{ margin: 0 }}>{meta.scope === "disc" ? "DISC files only" : "all files"}</dd>
                            </>}
                        </dl>
                        {focus.kind !== "code" && focus.children.length > 0 && (
                            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 12 }}>Click a bar to drill in.</div>
                        )}
                        {focus.kind === "code" && (
                            <div style={{ marginTop: 12 }}>
                                <div style={{ fontSize: 11, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Top documents</div>
                                {docRows.slice(0, 8).map(d => (
                                    <div key={d.path} style={{ display: "flex", gap: 6, fontSize: 12, padding: "2px 0" }}>
                                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.path}>{shortPath(d.path)}</span>
                                        <span style={{ color: "#57606a", fontVariantNumeric: "tabular-nums" }}>{fmt(d.items.length)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
