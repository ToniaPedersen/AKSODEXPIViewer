import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
global.DOMParser = dom.window.DOMParser;
import fs from "node:fs";
import { parseProteusPackage } from "/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/src/proteusParser.js";
import { boundsFromElements } from "/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/src/dexpiParser.js";
import { png_readChunks } from "/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/src/pngPlacement.js";

const strip = s => s.replace(/^﻿/, "");
const mainXml = strip(fs.readFileSync("/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/AKSO/FPQ-AKSO-P-XB-20130-01.XML", "utf-8"));
const discXml = strip(fs.readFileSync("/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/DEXPI 2.0/DiscProfile.xml", "utf-8"));

const parsed = parseProteusPackage(mainXml, discXml);
const b = boundsFromElements(parsed.graphics);
console.log("fullBounds:", b);
const boundsW = Math.max(1, b.maxX - b.minX);
const boundsH = Math.max(1, b.maxY - b.minY);
console.log("boundsW:", boundsW, "boundsH:", boundsH);

// Get the PNG's natural pixel dimensions from its IHDR chunk (bytes 0-7 of chunk data: width, height, big-endian uint32 each).
const pngBytes = new Uint8Array(fs.readFileSync("/sessions/dazzling-zen-fermi/mnt/uploads/FPQ-AKSO-P-XB-20130-01-1-placement.png"));
const chunks = png_readChunks(pngBytes);
const ihdr = chunks.find(c => c.type === "IHDR");
const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
const naturalWidth = dv.getUint32(0);
const naturalHeight = dv.getUint32(4);
console.log("naturalWidth/Height:", naturalWidth, naturalHeight);

// ---- exact bgPlacement math from App.jsx ----
const bgImage = { scale: 0.97, offsetX: 5.202, offsetY: 20.032, naturalWidth, naturalHeight };
let baseW = boundsW, baseH = boundsH, baseX = b.minX, baseY = b.minY;
if (bgImage.naturalWidth && bgImage.naturalHeight) {
  const imgAspect = bgImage.naturalWidth / bgImage.naturalHeight;
  const boundsAspect = boundsW / boundsH;
  if (imgAspect > boundsAspect) { baseW = boundsW; baseH = boundsW / imgAspect; }
  else { baseH = boundsH; baseW = boundsH * imgAspect; }
  baseX = b.minX + (boundsW - baseW) / 2;
  baseY = b.minY + (boundsH - baseH) / 2;
}
const placed = {
  x: baseX + bgImage.offsetX,
  y: baseY + bgImage.offsetY,
  width: baseW * bgImage.scale,
  height: baseH * bgImage.scale,
};
console.log("auto-fit baseline (scale=1,offset=0):", { x: baseX, y: baseY, width: baseW, height: baseH });
console.log("placed with saved default:", placed);
console.log("delta x,y,w,h:", placed.x - baseX, placed.y - baseY, placed.width - baseW, placed.height - baseH);
console.log("delta as % of boundsW/boundsH:", ((placed.x-baseX)/boundsW*100).toFixed(4)+"%", ((placed.y-baseY)/boundsH*100).toFixed(4)+"%");
