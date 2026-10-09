import React, { useEffect, useRef, useState } from "react";

const COPILOT_URL = "https://m365.cloud.microsoft/chat";

const D = {
    scrim: { position: "fixed", inset: 0, background: "rgba(13,17,23,0.38)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box" },
    shell: { width: "min(1100px, 100%)", maxHeight: "100%", background: "#fff", border: "1px solid #d0d7de", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontFamily: "Arial, sans-serif", color: "#111" },
    head: { padding: "10px 14px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", gap: 10 },
    body: { flex: 1, overflow: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: "#24292f", marginBottom: 4, display: "flex", gap: 8, alignItems: "baseline" },
    legend: { fontSize: 11, fontWeight: 400, color: "#57606a" },
    code: { border: "1px solid #d0d7de", borderRadius: 6, overflow: "auto", fontFamily: "Consolas, monospace", fontSize: 12, lineHeight: 1.45, maxHeight: 340 },
    row: { display: "flex", whiteSpace: "pre", minWidth: "fit-content" },
    gutter: { width: 58, flexShrink: 0, textAlign: "right", padding: "0 8px", color: "#8c959f", userSelect: "none", borderRight: "1px solid #eaeef2" },
    sign: { width: 16, flexShrink: 0, textAlign: "center", userSelect: "none", fontWeight: 700 },
    cell: { padding: "0 8px", flex: 1 },
    fold: { padding: "0 8px 0 82px", color: "#8c959f", fontStyle: "italic", background: "#f6f8fa" },
    notes: { margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "#24292f", lineHeight: 1.45 },
    area: { width: "100%", boxSizing: "border-box", minHeight: 220, marginTop: 6, padding: 10, border: "1px solid #d0d7de", borderRadius: 6, fontFamily: "Consolas, monospace", fontSize: 12, lineHeight: 1.45, resize: "vertical", color: "#24292f" },
    foot: { padding: "10px 14px", borderTop: "1px solid #d0d7de", display: "flex", alignItems: "center", gap: 8 },
    btn: { padding: "6px 10px", border: "1px solid #c7ced6", background: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    btnPrimary: { padding: "6px 10px", border: "1px solid #0969da", background: "#0969da", color: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};

// Red = the lines the finding is about / lines to remove; green = lines to add.
const BAD = { background: "#ffebe9", boxShadow: "inset 3px 0 0 #cf222e" };
const ADD = { background: "#dafbe1", boxShadow: "inset 3px 0 0 #1a7f37" };
const OP_STYLE = { "-": { row: BAD, color: "#cf222e" }, "+": { row: ADD, color: "#1a7f37" }, " ": { row: {}, color: "#8c959f" } };

async function copyText(text, area) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        if (!area) return false;
        area.select();
        return document.execCommand("copy");
    }
}

function CurrentXml({ current }) {
    return (
        <div style={D.code}>
            {current.rows.map((r, i) => r.fold
                ? <div key={i} style={D.fold}>⋯ {r.fold} line{r.fold === 1 ? "" : "s"}</div>
                : (
                    <div key={i} style={{ ...D.row, ...(r.bad ? BAD : {}) }}>
                        <span style={D.gutter}>{r.n}</span>
                        <span style={{ ...D.sign, color: "#cf222e" }}>{r.bad ? "!" : ""}</span>
                        <span style={D.cell}>{r.text}</span>
                    </div>
                ))}
        </div>
    );
}

function FixRows({ fix }) {
    return (
        <>
            {fix.rows.length > 0 && <div style={D.code}>
                {fix.rows.map((r, i) => (
                    <div key={i} style={{ ...D.row, ...OP_STYLE[r.op].row }}>
                        <span style={{ ...D.sign, color: OP_STYLE[r.op].color, width: 24 }}>{r.op === " " ? "" : r.op}</span>
                        <span style={D.cell}>{r.text}</span>
                    </div>
                ))}
            </div>}
            {fix.notes?.length > 0 && <ul style={D.notes}>{fix.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </>
    );
}

export default function SuggestDialog({ title, suggestion, onClose }) {
    const { text = "", current = null, fix = null, script = null } = suggestion || {};
    const [value, setValue] = useState(text);
    const [status, setStatus] = useState("");
    const [showText, setShowText] = useState(!current && !fix);
    const areaRef = useRef(null);

    useEffect(() => { setValue(text); setStatus(""); }, [text]);
    useEffect(() => {
        const onKey = e => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const copy = async openCopilot => {
        const ok = await copyText(value, areaRef.current);
        setStatus(ok ? "Copied to the clipboard." : "Copy failed - open the question below, select the text and copy it by hand.");
        if (openCopilot) window.open(COPILOT_URL, "_blank", "noopener");
    };

    return (
        <div style={D.scrim} onClick={onClose}>
            <div style={D.shell} onClick={e => e.stopPropagation()}>
                <div style={D.head}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Suggest a fix</div>
                    <div style={{ fontSize: 12, color: "#57606a", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
                    <button style={D.btn} onClick={onClose} title="Close (Esc)">✕</button>
                </div>
                <div style={D.body}>
                    {current && (
                        <div>
                            <div style={D.sectionTitle}>In the file <span style={D.legend}>red = lines this finding is about</span></div>
                            <CurrentXml current={current} />
                        </div>
                    )}
                    {fix && (
                        <div>
                            <div style={D.sectionTitle}>{fix.heading} {fix.rows.length > 0 && <span style={D.legend}>red “−” = remove / replace, green “+” = add; {"{…}"} = fill in</span>}</div>
                            <FixRows fix={fix} />
                        </div>
                    )}
                    {!fix && (
                        <div style={{ fontSize: 12, color: "#57606a" }}>No suggestion can be worked out for this finding - use the question for Copilot below.</div>
                    )}
                    {script && (
                        <div style={{ fontSize: 12, color: "#24292f" }}><b>PowerShell fix script:</b> <span style={{ fontFamily: "Consolas, monospace" }}>{script}</span></div>
                    )}
                    <div>
                        <div style={{ ...D.sectionTitle, cursor: "pointer" }} onClick={() => setShowText(v => !v)}>
                            <span style={{ width: 12, display: "inline-block", color: "#888", fontWeight: 400 }}>{showText ? "▾" : "▸"}</span>
                            Question for Copilot <span style={D.legend}>editable - the copy buttons copy this text</span>
                        </div>
                        {showText && <textarea ref={areaRef} style={D.area} value={value} onChange={e => setValue(e.target.value)} spellCheck={false} />}
                    </div>
                </div>
                <div style={D.foot}>
                    <button style={D.btnPrimary} onClick={() => copy(true)} title={`Copy the question and open ${COPILOT_URL}`}>Copy &amp; open Copilot</button>
                    <button style={D.btn} onClick={() => copy(false)}>Copy</button>
                    <span style={{ fontSize: 12, color: "#57606a", flex: 1 }}>{status}</span>
                    <button style={D.btn} onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
