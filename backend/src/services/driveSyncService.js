const db = require("../db/database");
const { buildDriveClient, getDriveConfig } = require("./driveClient");

const XLSX = require("xlsx");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let syncInFlight = null;

function nowIso() {
  return new Date().toISOString();
}

function getState(key) {
  const row = db.prepare("SELECT value FROM drive_sync_state WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  db.prepare(`
    INSERT INTO drive_sync_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, String(value ?? ""));
}

function clearState(key) {
  db.prepare("DELETE FROM drive_sync_state WHERE key = ?").run(key);
}

function toRecord(file) {
  return {
    file_id: String(file.id),
    name: String(file.name || ""),
    mime_type: String(file.mimeType || ""),
    parents: JSON.stringify(Array.isArray(file.parents) ? file.parents : []),
    modified_time: file.modifiedTime || null,
    size: file.size != null ? String(file.size) : null,
    md5_checksum: file.md5Checksum || null,
    trashed: file.trashed ? 1 : 0,
  };
}

function upsertIndex(file) {
  const r = toRecord(file);
  db.prepare(`
    INSERT INTO drive_index (
      file_id, name, mime_type, parents, modified_time, size, md5_checksum, trashed, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET
      name=excluded.name,
      mime_type=excluded.mime_type,
      parents=excluded.parents,
      modified_time=excluded.modified_time,
      size=excluded.size,
      md5_checksum=excluded.md5_checksum,
      trashed=excluded.trashed,
      last_seen_at=datetime('now'),
      updated_at=datetime('now')
  `).run(
    r.file_id,
    r.name,
    r.mime_type,
    r.parents,
    r.modified_time,
    r.size,
    r.md5_checksum,
    r.trashed
  );
}

function markTrashed(fileId) {
  db.prepare(`
    INSERT INTO drive_index (file_id, name, mime_type, parents, trashed, last_seen_at, updated_at)
    VALUES (?, '', '', '[]', 1, datetime('now'), datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET
      trashed=1,
      last_seen_at=datetime('now'),
      updated_at=datetime('now')
  `).run(String(fileId));
}

function getCounts() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN trashed = 0 THEN 1 ELSE 0 END) AS active_files,
      SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed_files,
      COUNT(*) AS total_files
    FROM drive_index
  `).get();
  return {
    active_files: Number(row?.active_files || 0),
    trashed_files: Number(row?.trashed_files || 0),
    total_files: Number(row?.total_files || 0),
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

function workbookToLines(workbook) {
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

function upsertDriveFileRow(file) {
  const driveUrl = `https://drive.google.com/file/d/${file.id}/view`;
  const fileDate = file.modifiedTime ? String(file.modifiedTime).slice(0, 10) : null;

  db.prepare(`
    INSERT INTO files (title, drive_url, cabinet, file_date, status, drive_file_id, source)
    VALUES (?, ?, NULL, ?, 'ACTIVE', ?, 'DRIVE')
    ON CONFLICT(drive_file_id) DO UPDATE SET
      title=excluded.title,
      drive_url=excluded.drive_url,
      file_date=excluded.file_date,
      status='ACTIVE',
      source='DRIVE'
  `).run(String(file.name || "(sin nombre)"), driveUrl, fileDate, String(file.id));

  const row = db.prepare("SELECT id FROM files WHERE drive_file_id = ?").get(String(file.id));
  return Number(row.id);
}

function clearDriveEntriesByDriveFileId(driveFileId) {
  const row = db.prepare("SELECT id FROM files WHERE drive_file_id = ?").get(String(driveFileId));
  if (!row) return;
  db.prepare("DELETE FROM entries WHERE file_id = ? AND source = 'DRIVE'").run(Number(row.id));
}

function markDriveFileInactive(driveFileId) {
  db.prepare("UPDATE files SET status='INACTIVE' WHERE drive_file_id = ?").run(String(driveFileId));
  clearDriveEntriesByDriveFileId(driveFileId);
}

function indexLinesIntoEntries(fileId, lines, refDate) {
  const unique = [...new Set(lines)].filter((line) => line.length >= 3);
  const maxRowsPerFile = Number(process.env.DRIVE_INDEX_MAX_ROWS_PER_FILE || 4000);
  const selected = unique.slice(0, maxRowsPerFile);

  const del = db.prepare("DELETE FROM entries WHERE file_id = ? AND source = 'DRIVE'");
  const ins = db.prepare(`
    INSERT INTO entries (file_id, description, keywords, location, ref_date, source, created_by)
    VALUES (?, ?, ?, ?, ?, 'DRIVE', NULL)
  `);

  const tx = db.transaction(() => {
    del.run(fileId);
    for (const line of selected) {
      ins.run(
        fileId,
        line.slice(0, 700),
        line.slice(0, 4000),
        extractSectorFromLine(line),
        refDate
      );
    }
  });
  tx();

  return selected.length;
}

async function indexDriveSheetContent(client, file) {
  const mime = String(file.mimeType || "");
  if (mime !== GOOGLE_SHEET_MIME && mime !== XLSX_MIME) {
    clearDriveEntriesByDriveFileId(file.id);
    return 0;
  }

  const fileId = upsertDriveFileRow(file);
  const buf = mime === GOOGLE_SHEET_MIME
    ? await client.exportSheetAsXlsx(String(file.id))
    : await client.downloadFileAsBuffer(String(file.id));
  const wb = XLSX.read(buf, { type: "buffer" });
  const lines = workbookToLines(wb);
  const refDate = file.modifiedTime ? String(file.modifiedTime).slice(0, 10) : null;
  return indexLinesIntoEntries(fileId, lines, refDate);
}

async function isFileInScope(file, client, cfg, cache, visited = new Set()) {
  if (!cfg.folderId) return true;

  const id = String(file?.id || "");
  if (id && id === cfg.folderId) return true;

  const parents = Array.isArray(file?.parents) ? file.parents : [];
  if (parents.includes(cfg.folderId)) return true;

  for (const parentId of parents) {
    if (visited.has(parentId)) continue;
    visited.add(parentId);

    if (cache.has(parentId)) {
      if (cache.get(parentId)) return true;
      continue;
    }

    try {
      const parent = await client.getFile(parentId);
      const inScope = await isFileInScope(parent, client, cfg, cache, visited);
      cache.set(parentId, inScope);
      if (inScope) return true;
    } catch (err) {
      cache.set(parentId, false);
      console.warn(`[driveSync] No se pudo resolver ancestro ${parentId}: ${err.message}`);
    }
  }

  return false;
}

async function bootstrapFromFolder(client, cfg) {
  if (!cfg.folderId) {
    throw new Error("Configura DRIVE_FOLDER_ID para bootstrap inicial desde carpeta");
  }

  const queue = [cfg.folderId];
  const seenFolders = new Set([cfg.folderId]);
  let filesUpserted = 0;
  let driveRowsIndexed = 0;

  try {
    const root = await client.getFile(cfg.folderId);
    upsertIndex(root);
    filesUpserted += 1;
  } catch (err) {
    console.warn(`[driveSync] No se pudo leer carpeta ra�z ${cfg.folderId}: ${err.message}`);
  }

  while (queue.length) {
    const folderId = queue.shift();
    let pageToken = null;

    do {
      const page = await client.listChildren(folderId, pageToken);
      for (const file of page.files) {
        upsertIndex(file);
        filesUpserted += 1;

        if (!file.trashed && file.mimeType === FOLDER_MIME && !seenFolders.has(file.id)) {
          seenFolders.add(file.id);
          queue.push(file.id);
        }

        if (!file.trashed) {
          try {
            driveRowsIndexed += await indexDriveSheetContent(client, file);
          } catch (err) {
            console.warn(`[driveSync] No se pudo indexar contenido de ${file.id}: ${err.message}`);
          }
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  return { filesUpserted, driveRowsIndexed };
}

async function syncInternal(trigger = "manual") {
  const client = await buildDriveClient();
  const cfg = getDriveConfig();

  let pageToken = getState("drive.page_token");

  if (!pageToken) {
    const boot = await bootstrapFromFolder(client, cfg);
    const startToken = await client.getStartPageToken();
    setState("drive.page_token", startToken);
    setState("drive.last_sync_at", nowIso());
    setState("drive.last_changes_applied", String(boot.filesUpserted));
    setState("drive.last_drive_rows_indexed", String(boot.driveRowsIndexed));
    setState("drive.last_trigger", trigger);
    return {
      mode: "bootstrap",
      trigger,
      changesApplied: boot.filesUpserted,
      driveRowsIndexed: boot.driveRowsIndexed,
      indexed: getCounts(),
      startPageToken: startToken,
    };
  }

  let changesApplied = 0;
  let readChanges = 0;
  let nextToken = pageToken;
  let newStartToken = null;
  let driveRowsIndexed = 0;
  const parentScopeCache = new Map();

  while (nextToken) {
    const page = await client.listChanges(nextToken);
    for (const change of page.changes) {
      readChanges += 1;
      const fid = change.fileId || change.file?.id;

      if (change.removed || !change.file || change.file.trashed) {
        markTrashed(fid);
        markDriveFileInactive(fid);
        changesApplied += 1;
        continue;
      }

      const inScope = await isFileInScope(change.file, client, cfg, parentScopeCache);
      if (!inScope) {
        markTrashed(change.file.id);
        markDriveFileInactive(change.file.id);
        changesApplied += 1;
        continue;
      }

      upsertIndex(change.file);
      try {
        driveRowsIndexed += await indexDriveSheetContent(client, change.file);
      } catch (err) {
        console.warn(`[driveSync] No se pudo indexar contenido incremental ${change.file.id}: ${err.message}`);
      }
      changesApplied += 1;
    }

    if (page.newStartPageToken) newStartToken = page.newStartPageToken;
    nextToken = page.nextPageToken;
  }

  if (newStartToken) setState("drive.page_token", newStartToken);
  setState("drive.last_sync_at", nowIso());
  setState("drive.last_changes_applied", String(changesApplied));
  setState("drive.last_drive_rows_indexed", String(driveRowsIndexed));
  setState("drive.last_trigger", trigger);

  return {
    mode: "incremental",
    trigger,
    readChanges,
    changesApplied,
    driveRowsIndexed,
    indexed: getCounts(),
    startPageToken: getState("drive.page_token"),
  };
}

function runSync(trigger = "manual") {
  if (!syncInFlight) {
    syncInFlight = (async () => {
      try {
        return await syncInternal(trigger);
      } finally {
        syncInFlight = null;
      }
    })();
  }
  return syncInFlight;
}

async function runFullSync(trigger = "manual-full") {
  clearState("drive.page_token");
  return runSync(trigger);
}

async function ensureWatch() {
  const client = await buildDriveClient();
  const webhookAddress = String(process.env.DRIVE_WEBHOOK_URL || "").trim();
  const webhookToken = String(process.env.DRIVE_WEBHOOK_TOKEN || "").trim();

  if (!webhookAddress || !webhookToken) {
    throw new Error("Configura DRIVE_WEBHOOK_URL y DRIVE_WEBHOOK_TOKEN");
  }

  let pageToken = getState("drive.page_token");
  if (!pageToken) {
    const out = await runSync("watch-bootstrap");
    pageToken = out.startPageToken;
  }

  const currentChannelId = getState("drive.watch_channel_id");
  const currentResourceId = getState("drive.watch_resource_id");
  if (currentChannelId && currentResourceId) {
    try {
      await client.stopChannel(currentChannelId, currentResourceId);
    } catch (err) {
      console.warn(`[driveSync] No se pudo detener canal previo: ${err.message}`);
    }
  }

  const expirationMs = Number(process.env.DRIVE_WATCH_EXPIRATION_MS || 60 * 60 * 1000 * 24);
  const channelId = require("crypto").randomUUID();
  const watch = await client.watchChanges(pageToken, {
    address: webhookAddress,
    token: webhookToken,
    channelId,
    expirationMs,
  });

  setState("drive.watch_channel_id", watch.id || channelId);
  setState("drive.watch_resource_id", watch.resourceId || "");
  setState("drive.watch_expiration", watch.expiration || "");

  return {
    channelId: watch.id || channelId,
    resourceId: watch.resourceId || null,
    expiration: watch.expiration || null,
  };
}

async function stopWatch() {
  const channelId = getState("drive.watch_channel_id");
  const resourceId = getState("drive.watch_resource_id");
  if (!channelId || !resourceId) return { stopped: false };

  const client = await buildDriveClient();
  await client.stopChannel(channelId, resourceId);

  clearState("drive.watch_channel_id");
  clearState("drive.watch_resource_id");
  clearState("drive.watch_expiration");

  return { stopped: true };
}

function getStatus() {
  return {
    config: {
      folderId: getDriveConfig().folderId || null,
      driveId: getDriveConfig().driveId || null,
      useSharedDrive: getDriveConfig().useSharedDrive,
    },
    lastSyncAt: getState("drive.last_sync_at"),
    lastChangesApplied: Number(getState("drive.last_changes_applied") || 0),
    lastDriveRowsIndexed: Number(getState("drive.last_drive_rows_indexed") || 0),
    lastTrigger: getState("drive.last_trigger"),
    startPageToken: getState("drive.page_token"),
    watch: {
      channelId: getState("drive.watch_channel_id"),
      resourceId: getState("drive.watch_resource_id"),
      expiration: getState("drive.watch_expiration"),
    },
    indexed: getCounts(),
    inProgress: Boolean(syncInFlight),
  };
}

module.exports = {
  runSync,
  runFullSync,
  getStatus,
  ensureWatch,
  stopWatch,
};


