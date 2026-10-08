import React, { useEffect, useRef, useState } from "react";

const COPILOT_URL = "https://m365.cloud.microsoft/chat";

const D = {
    scrim: { position: "fixed", inset: 0, background: "rgba(13,17,23,0.38)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box" },
    shell: { width: "min(900px, 100%)", maxHeight: "100%", background: "#fff", border: "1px solid #d0d7de", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontFamily: "Arial, sans-serif", color: "#111" },
    head: { padding: "10px 14px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", gap: 10 },
    area: { flex: 1, minHeight: 360, margin: 14, padding: 10, border: "1px solid #d0d7de", borderRadius: 6, fontFamily: "Consolas, monospace", fontSize: 12, lineHeight: 1.45, resize: "none", color: "#24292f" },
    foot: { padding: "10px 14px", borderTop: "1px solid #d0d7de", display: "flex", alignItems: "center", gap: 8 },
    btn: { padding: "6px 10px", border: "1px solid #c7ced6", background: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    btnPrimary: { padding: "6px 10px", border: "1px solid #0969da", background: "#0969da", color: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};

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

export default function SuggestDialog({ title, text, onClose }) {
    const [value, setValue] = useState(text);
    const [status, setStatus] = useState("");
    const areaRef = useRef(null);

    useEffect(() => { setValue(text); setStatus(""); }, [text]);
    useEffect(() => {
        const onKey = e => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const copy = async openCopilot => {
        const ok = await copyText(value, areaRef.current);
        setStatus(ok ? "Copied to the clipboard." : "Copy failed - select the text and copy it by hand.");
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
                <div style={{ padding: "8px 14px 0", fontSize: 12, color: "#57606a" }}>
                    Paste this into Copilot or another assistant. You can edit it first. Check the answer before changing the file.
                </div>
                <textarea ref={areaRef} style={D.area} value={value} onChange={e => setValue(e.target.value)} spellCheck={false} />
                <div style={D.foot}>
                    <button style={D.btnPrimary} onClick={() => copy(true)} title={`Copy the text and open ${COPILOT_URL}`}>Copy &amp; open Copilot</button>
                    <button style={D.btn} onClick={() => copy(false)}>Copy</button>
                    <span style={{ fontSize: 12, color: "#57606a", flex: 1 }}>{status}</span>
                    <button style={D.btn} onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
