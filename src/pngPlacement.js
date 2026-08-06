// Dependency-free PNG chunk reader/writer used to embed a BG-image "default
// placement" (Scale / X offset / Y offset) directly into a PNG file's own
// metadata - see SendToBack-FunctionalRequirements-v2.md, Part B.
//
// The placement is stored as a single standard `tEXt` ancillary chunk
// (keyword "dexpi:bgPlacement", text a small JSON object), inserted
// immediately before the `IEND` chunk. Any prior chunk with the same
// keyword is stripped before a new one is written, so a file never carries
// more than one. All chunk framing (4-byte length, 4-byte type, data,
// 4-byte CRC-32 over type+data) follows the PNG spec exactly, so a file
// with an embedded default remains a fully valid, conformant PNG.

export const PNG_PLACEMENT_KEYWORD = "dexpi:bgPlacement";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True if `bytes` (Uint8Array) starts with the 8-byte PNG file signature. */
export function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
}

function bytesToLatin1(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

function latin1ToBytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
}

let crcTableCache = null;
function crcTable() {
    if (crcTableCache) return crcTableCache;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    crcTableCache = table;
    return table;
}

/** Standard PNG CRC-32 (over the concatenation of a chunk's type + data). */
export function png_crc32(bytes) {
    const table = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parse a PNG byte stream into its chunk list: [{ type, data, start, end }],
 * in file order. `start`/`end` are byte offsets of the *whole* chunk
 * (length + type + data + CRC) within `bytes`, so callers can splice chunks
 * in/out by byte range. Throws if the stream isn't a well-formed PNG chunk
 * stream (bad signature, truncated chunk header/data).
 */
export function png_readChunks(bytes) {
    if (!isPngBytes(bytes)) throw new Error("Not a PNG file (bad signature).");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let offset = 8;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) throw new Error("Truncated PNG chunk header.");
        const length = view.getUint32(offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) throw new Error("Truncated PNG chunk data.");
        const data = bytes.slice(dataStart, dataEnd);
        const end = dataEnd + 4; // past the CRC
        chunks.push({ type, data, start: offset, end });
        offset = end;
        if (type === "IEND") break;
    }
    return chunks;
}

/** Decode a `tEXt` chunk's `keyword\0text` payload (both Latin-1). */
export function png_decodeTextChunk(data) {
    let nul = -1;
    for (let i = 0; i < data.length; i++) { if (data[i] === 0) { nul = i; break; } }
    if (nul === -1) return null;
    return { keyword: bytesToLatin1(data.subarray(0, nul)), text: bytesToLatin1(data.subarray(nul + 1)) };
}

/** Build a complete, CRC-valid `tEXt` chunk (length+type+data+crc) as bytes. */
export function png_buildTextChunk(keyword, text) {
    const kwBytes = latin1ToBytes(keyword);
    const txBytes = latin1ToBytes(text);
    const data = new Uint8Array(kwBytes.length + 1 + txBytes.length);
    data.set(kwBytes, 0);
    data[kwBytes.length] = 0;
    data.set(txBytes, kwBytes.length + 1);

    const typeBytes = latin1ToBytes("tEXt");
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, typeBytes.length);
    const crc = png_crc32(crcInput);

    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc);
    return chunk;
}

/**
 * Return a copy of `bytes` with every `tEXt` chunk keyed
 * `dexpi:bgPlacement` removed (never appends a duplicate on repeated
 * saves). All other chunks, including pixel data, are copied through
 * unchanged, byte-for-byte.
 */
export function png_stripPlacementChunk(bytes) {
    const chunks = png_readChunks(bytes);
    const toRemove = chunks.filter(c => {
        if (c.type !== "tEXt") return false;
        const decoded = png_decodeTextChunk(c.data);
        return decoded && decoded.keyword === PNG_PLACEMENT_KEYWORD;
    });
    if (toRemove.length === 0) return bytes.slice();
    const parts = [];
    let cursor = 0;
    for (const c of toRemove) {
        parts.push(bytes.subarray(cursor, c.start));
        cursor = c.end;
    }
    parts.push(bytes.subarray(cursor));
    const totalLen = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(totalLen);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Embed `{ scale, offsetX, offsetY }` into `bytes` as a `dexpi:bgPlacement`
 * `tEXt` chunk immediately before `IEND`, replacing any previous one.
 * Returns a new Uint8Array; `bytes` is left unmodified.
 */
export function writePngEmbeddedPlacement(bytes, placement) {
    const stripped = png_stripPlacementChunk(bytes);
    const chunks = png_readChunks(stripped);
    const iend = chunks.find(c => c.type === "IEND");
    if (!iend) throw new Error("PNG has no IEND chunk.");
    const text = JSON.stringify({ scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY });
    const textChunk = png_buildTextChunk(PNG_PLACEMENT_KEYWORD, text);
    const out = new Uint8Array(stripped.length + textChunk.length);
    out.set(stripped.subarray(0, iend.start), 0);
    out.set(textChunk, iend.start);
    out.set(stripped.subarray(iend.start), iend.start + textChunk.length);
    return out;
}

/**
 * Read the embedded `{ scale, offsetX, offsetY }` default from a PNG's
 * bytes, or `null` if the file isn't a well-formed PNG, carries no
 * `dexpi:bgPlacement` chunk, or that chunk's text isn't valid JSON with the
 * expected numeric fields (falls back to auto-fit rather than throwing -
 * a foreign/corrupted chunk under the same keyword should never break
 * loading the image).
 */
export function readPngEmbeddedPlacement(bytes) {
    try {
        if (!isPngBytes(bytes)) return null;
        const chunks = png_readChunks(bytes);
        for (const c of chunks) {
            if (c.type !== "tEXt") continue;
            const decoded = png_decodeTextChunk(c.data);
            if (!decoded || decoded.keyword !== PNG_PLACEMENT_KEYWORD) continue;
            const obj = JSON.parse(decoded.text);
            if (obj && typeof obj.scale === "number" && typeof obj.offsetX === "number" && typeof obj.offsetY === "number") {
                return { scale: obj.scale, offsetX: obj.offsetX, offsetY: obj.offsetY };
            }
            return null;
        }
        return null;
    } catch (e) {
        return null;
    }
}
