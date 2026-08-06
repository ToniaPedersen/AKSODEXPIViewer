import fs from "node:fs";
import { png_readChunks } from "/sessions/dazzling-zen-fermi/mnt/AKSODEXPIViewer/src/pngPlacement.js";

// Sheet Extent straight from the Proteus XML: <Min X="0" Y="0"/> <Max X="841" Y="594"/>
const boundsW = 841, boundsH = 594, minX = 0, minY = 0;

const pngBytes = new Uint8Array(fs.readFileSync("/sessions/dazzling-zen-fermi/mnt/uploads/FPQ-AKSO-P-XB-20130-01-1-placement.png"));
const chunks = png_readChunks(pngBytes);
const ihdr = chunks.find(c => c.type === "IHDR");
const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
const naturalWidth = dv.getUint32(0), naturalHeight = dv.getUint32(4);
console.log("PNG pixel size:", naturalWidth, "x", naturalHeight);

const bgImage = { scale: 0.97, offsetX: 5.202, offsetY: 20.032, naturalWidth, naturalHeight };
let baseW = boundsW, baseH = boundsH, baseX = minX, baseY = minY;
const imgAspect = naturalWidth / naturalHeight;
const boundsAspect = boundsW / boundsH;
if (imgAspect > boundsAspect) { baseW = boundsW; baseH = boundsW / imgAspect; } else { baseH = boundsH; baseW = boundsH * imgAspect; }
baseX = minX + (boundsW - baseW) / 2;
baseY = minY + (boundsH - baseH) / 2;

const placed = { x: baseX + bgImage.offsetX, y: baseY + bgImage.offsetY, width: baseW * bgImage.scale, height: baseH * bgImage.scale };
console.log("auto-fit baseline:", { x: baseX, y: baseY, width: baseW, height: baseH });
console.log("placed w/ saved default:", placed);
console.log("shift as % of sheet:", ((placed.x-baseX)/boundsW*100).toFixed(2)+"% width,", ((placed.y-baseY)/boundsH*100).toFixed(2)+"% height, scale delta", ((0.97-1)*100).toFixed(1)+"%");
