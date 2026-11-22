import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

import { WhatsAppRuntime } from "./runtime.mjs";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require(
  "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel"
);

const accountId = process.argv[2] ?? "personal";
const outputDir = process.argv[3];

if (!outputDir) {
  throw new Error("Usage: node whatsapp-auth-svg.mjs <account> <output-dir>");
}

const qrFile = path.join(outputDir, "relink-qr.svg");
const qrPngFile = path.join(outputDir, "relink-qr.png");
const statusFile = path.join(outputDir, "relink-status.json");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function renderQrPng(qr, quiet = 4, scale = 8) {
  const modules = qr.getModuleCount();
  const width = (modules + quiet * 2) * scale;
  const raw = Buffer.alloc((width + 1) * width, 255);

  for (let y = 0; y < width; y += 1) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0;
    const moduleRow = Math.floor(y / scale) - quiet;
    for (let x = 0; x < width; x += 1) {
      const moduleCol = Math.floor(x / scale) - quiet;
      const dark =
        moduleRow >= 0 &&
        moduleRow < modules &&
        moduleCol >= 0 &&
        moduleCol < modules &&
        qr.modules[moduleRow][moduleCol];
      raw[rowStart + 1 + x] = dark ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function writeStatus(status, extra = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    statusFile,
    JSON.stringify(
      { account: accountId, status, updatedAt: new Date().toISOString(), ...extra },
      null,
      2
    )
  );
}

async function writeQrSvg(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();

  const quiet = 4;
  const modules = qr.getModuleCount();
  const size = modules + quiet * 2;
  const rects = [];

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.modules[row][col]) {
        rects.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
      }
    }
  }

  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<g fill="#000">${rects.join("")}</g>`,
    `</svg>`
  ].join("");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(qrFile, svg);
  await fs.writeFile(qrPngFile, renderQrPng(qr));
  await writeStatus("awaiting_qr_scan", { qrFile, qrPngFile });
  process.stdout.write(`qr_updated: ${qrPngFile}\n`);
}

const runtime = new WhatsAppRuntime({ accountId, logLevel: "error" });
runtime.on("connection.update", (update) => {
  if (update.qr) {
    void writeQrSvg(update.qr);
  }
  if (update.connection === "open") {
    void writeStatus("connected", { user: runtime.socket?.user?.id ?? null });
  }
});

await writeStatus("starting");
await runtime.start({ printQrToTerminal: false, force: true });

try {
  const socket = await runtime.waitForConnection(5 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await runtime.waitForCredentialSave();
  await writeStatus("connected", { user: socket.user?.id ?? null });
  process.stdout.write(`connected: ${socket.user?.id ?? "unknown"}\n`);
  await runtime.stop();
  process.exitCode = 0;
} catch (error) {
  await writeStatus("failed", { error: error.message });
  process.stderr.write(`failed: ${error.message}\n`);
  await runtime.stop().catch(() => {});
  process.exitCode = 1;
}
