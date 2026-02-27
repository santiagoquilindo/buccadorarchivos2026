const express = require("express");
const path = require("path");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function getExcelTools() {
  let multer;
  let AdmZip;
  let XLSX;
  try {
    multer = require("multer");
    AdmZip = require("adm-zip");
    XLSX = require("xlsx");
  } catch {
    return null;
  }
  return { multer, AdmZip, XLSX };
}

function parseFileMetaFromName(name) {
  const clean = String(name || "").replace(/\.[^.]+$/, "");
  const dateMatch = clean.match(/\b(20\d{2}[-_/]?\d{2}[-_/]?\d{2})\b/);
  const gabMatch = clean.match(/\b(gabinete|gab)\s*([a-z0-9-]+)/i);
  return {
    title: clean,
    file_date: dateMatch ? dateMatch[1].replaceAll("_", "-").replaceAll("/", "-") : null,
    cabinet: gabMatch ? `Gabinete ${gabMatch[2]}` : null,
  };
}

function extractSectorFromLine(line) {
  const text = String(line || "");
  const patterns = [
    /\b(ESTANTE\s+[A-Z0-9.\- ]+(?:SUPERIOR|INFERIOR)?)\b/i,
    /\b(GABINETE\s+[A-Z0-9.\- ]+)\b/i,
    /\b(SECTOR\s+[A-Z0-9.\- ]+)\b/i,
    /\b(CAJA\s+\d+[A-Z0-9.\- ]*)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function workbookToLines(XLSX, workbook) {
  const chunks = [];
  for (const sheetName of workbook.SheetNames || []) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const line = row.map((c) => String(c || "").trim()).filter(Boolean).join(" ");
      if (line) chunks.push(line.replace(/\s+/g, " ").trim());
    }
  }
  return chunks;
}

function doImport({ fileBuffer, replace }) {
  const tools = getExcelTools();
  if (!tools) {
    return { error: "Faltan dependencias: instala multer adm-zip xlsx en backend" };
  }

  const { AdmZip, XLSX } = tools;
  const zip = new AdmZip(fileBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.(xlsx|xlsm)$/i.test(e.entryName));

  if (!entries.length) return { files_indexed: 0, entries_inserted: 0 };

  const doc = db.prepare("SELECT url_drive FROM documents WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get();
  const defaultDrive = doc?.url_drive || "https://drive.google.com";

  const insertFile = db.prepare(`
    INSERT INTO files (title, drive_url, cabinet, file_date, status)
    VALUES (?, ?, ?, ?, 'ACTIVE')
  `);
  const insertEntry = db.prepare(`
    INSERT INTO entries (file_id, description, keywords, location, ref_date, created_by)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);

  let filesIndexed = 0;
  let entriesInserted = 0;

  const tx = db.transaction(() => {
    if (replace) {
      db.prepare("DELETE FROM entries").run();
      db.prepare("DELETE FROM files").run();
    }

    for (const zEntry of entries) {
      const fileName = path.basename(zEntry.entryName);
      const meta = parseFileMetaFromName(fileName);
      const wb = XLSX.read(zEntry.getData(), { type: "buffer" });
      const lines = workbookToLines(XLSX, wb);

      const fileInfo = insertFile.run(meta.title, defaultDrive, meta.cabinet, meta.file_date);
      filesIndexed += 1;

      const unique = [...new Set(lines)].filter((line) => line.length >= 8);
      const maxRowsPerFile = 2500;
      const selected = unique.slice(0, maxRowsPerFile);
      for (const line of selected) {
        const location = extractSectorFromLine(line) || meta.cabinet || null;
        insertEntry.run(
          fileInfo.lastInsertRowid,
          line.slice(0, 700),
          line.slice(0, 4000),
          location,
          meta.file_date
        );
        entriesInserted += 1;
      }
    }
  });

  tx();
  return { files_indexed: filesIndexed, entries_inserted: entriesInserted };
}

router.post("/zip", requireAuth, requireRole("ADMIN"), (req, res) => {
  const tools = getExcelTools();
  if (!tools) return res.status(500).json({ message: "Instala dependencias: npm i multer adm-zip xlsx" });

  const upload = tools.multer({ storage: tools.multer.memoryStorage() }).single("file");
  upload(req, res, () => {
    if (!req.file?.buffer) return res.status(400).json({ message: "No se recibio archivo ZIP" });
    try {
      const out = doImport({ fileBuffer: req.file.buffer, replace: false });
      if (out.error) return res.status(500).json({ message: out.error });
      res.json(out);
    } catch (e) {
      res.status(500).json({ message: `Error importando ZIP: ${e.message}` });
    }
  });
});

router.post("/reindex-zip", requireAuth, requireRole("ADMIN"), (req, res) => {
  const tools = getExcelTools();
  if (!tools) return res.status(500).json({ message: "Instala dependencias: npm i multer adm-zip xlsx" });

  const upload = tools.multer({ storage: tools.multer.memoryStorage() }).single("file");
  upload(req, res, () => {
    if (!req.file?.buffer) return res.status(400).json({ message: "No se recibio archivo ZIP" });
    try {
      const out = doImport({ fileBuffer: req.file.buffer, replace: true });
      if (out.error) return res.status(500).json({ message: out.error });
      res.json(out);
    } catch (e) {
      res.status(500).json({ message: `Error reindexando ZIP: ${e.message}` });
    }
  });
});

module.exports = router;
