const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { google } = require("googleapis");
const {
  loadTokenData,
  saveTokenData,
  setLastSyncAt,
} = require("./driveTokenStore");

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function makeError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseAllowedEmails() {
  return String(process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function getRequiredOauthPort() {
  const raw = String(process.env.DRIVE_OAUTH_REQUIRED_PORT || "3786").trim();
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : 3786;
}

function getCurrentServerPort() {
  const raw = String(process.env.PORT || "").trim();
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function buildOAuthClient() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw makeError(500, "Configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getDriveFolderId() {
  const folderId = String(process.env.DRIVE_FOLDER_ID || "").trim();
  if (!folderId) throw makeError(500, "Configura DRIVE_FOLDER_ID");
  return folderId;
}

function getDriveLocalDir() {
  const configured = String(process.env.DRIVE_LOCAL_DIR || "").trim();
  const localDir = configured
    ? path.resolve(configured)
    : path.join(__dirname, "..", "..", "data", "drive_cache");
  fs.mkdirSync(localDir, { recursive: true });
  return localDir;
}

function getStatePath(localDir) {
  return path.join(localDir, ".drive_sync_state.json");
}

function loadSyncState(localDir) {
  const statePath = getStatePath(localDir);
  if (!fs.existsSync(statePath)) return { files: {}, lastSyncAt: null };
  try {
    const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      files: data?.files && typeof data.files === "object" ? data.files : {},
      lastSyncAt: data?.lastSyncAt || null,
    };
  } catch {
    return { files: {}, lastSyncAt: null };
  }
}

function saveSyncState(localDir, state) {
  const statePath = getStatePath(localDir);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeFileName(name) {
  return String(name || "archivo")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "archivo";
}

function extensionByMime(mimeType) {
  if (mimeType === "application/vnd.google-apps.spreadsheet") return ".xlsx";
  if (mimeType === "application/vnd.google-apps.document") return ".txt";
  if (mimeType === "application/vnd.google-apps.presentation") return ".pdf";
  return "";
}

function exportMimeByType(mimeType) {
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (mimeType === "application/vnd.google-apps.document") return "text/plain";
  if (mimeType === "application/vnd.google-apps.presentation") return "application/pdf";
  return null;
}

async function listDriveFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
      pageSize: 1000,
      pageToken: pageToken || undefined,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,trashed)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function downloadDriveFile(drive, file, localPath) {
  const exportMime = exportMimeByType(file.mimeType);
  if (file.mimeType && file.mimeType.startsWith("application/vnd.google-apps.") && !exportMime) {
    return false;
  }

  if (exportMime) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: exportMime },
      { responseType: "arraybuffer" }
    );
    fs.writeFileSync(localPath, Buffer.from(res.data));
    return true;
  }

  const res = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  await pipeline(res.data, fs.createWriteStream(localPath));
  return true;
}

function getConnectedStatus() {
  const data = loadTokenData();
  const requiredOauthPort = getRequiredOauthPort();
  const currentPort = getCurrentServerPort();
  const oauthPortReady = currentPort === requiredOauthPort;
  if (!data || !data.tokens?.refresh_token) {
    return {
      connected: false,
      oauthPortReady,
      currentPort,
      requiredOauthPort,
    };
  }
  return {
    connected: true,
    email: data.email || null,
    lastSyncAt: data.lastSyncAt || null,
    oauthPortReady,
    currentPort,
    requiredOauthPort,
  };
}

function startConnect() {
  const requiredOauthPort = getRequiredOauthPort();
  const currentPort = getCurrentServerPort();
  if (currentPort !== requiredOauthPort) {
    throw makeError(409, `Para conectar Drive, libera el puerto ${requiredOauthPort} y vuelve a intentar.`);
  }

  const oauth2 = buildOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
  });
  return { url };
}

async function finishConnect(code) {
  const oauth2 = buildOAuthClient();
  const authCode = String(code || "").trim();
  if (!authCode) throw makeError(400, "Codigo OAuth requerido");

  const tokenRes = await oauth2.getToken(authCode);
  const tokens = tokenRes.tokens || {};
  oauth2.setCredentials(tokens);

  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
  const profile = await oauth2Api.userinfo.get();
  const email = String(profile?.data?.email || "").trim().toLowerCase();
  if (!email) throw makeError(500, "No se pudo obtener correo de Google");

  const allowed = parseAllowedEmails();
  if (allowed.length && !allowed.includes(email)) {
    throw makeError(403, "Correo no permitido para esta aplicacion");
  }
  if (!tokens.refresh_token) {
    throw makeError(500, "Google no devolvio refresh_token. Repite la conexion con consentimiento");
  }

  saveTokenData({
    email,
    tokens: {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token || null,
      expiry_date: tokens.expiry_date || null,
    },
    connectedAt: new Date().toISOString(),
    lastSyncAt: null,
  });

  return { connected: true, email };
}

async function syncNow() {
  const tokenData = loadTokenData();
  if (!tokenData || !tokenData.tokens?.refresh_token) {
    throw makeError(409, "Drive no conectado");
  }

  const startedAt = Date.now();
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({
    refresh_token: tokenData.tokens.refresh_token,
    access_token: tokenData.tokens.access_token || undefined,
    expiry_date: tokenData.tokens.expiry_date || undefined,
  });

  const drive = google.drive({ version: "v3", auth: oauth2 });
  const folderId = getDriveFolderId();
  const localDir = getDriveLocalDir();
  const state = loadSyncState(localDir);
  const nextFiles = {};
  const currentIds = new Set();
  let downloaded = 0;
  let updated = 0;
  let skipped = 0;

  const driveFiles = await listDriveFiles(drive, folderId);
  for (const file of driveFiles) {
    if (!file?.id || !file?.name || file.trashed) {
      skipped += 1;
      continue;
    }

    const ext = extensionByMime(file.mimeType);
    const localName = `${file.id}__${normalizeFileName(file.name)}${ext}`;
    const localPath = path.join(localDir, localName);
    const prev = state.files[file.id];
    const changed = !prev || prev.modifiedTime !== file.modifiedTime || prev.md5Checksum !== (file.md5Checksum || null);
    const exists = fs.existsSync(localPath);

    if (!exists || changed) {
      const saved = await downloadDriveFile(drive, file, localPath);
      if (!saved) {
        skipped += 1;
        continue;
      }
      if (!prev || !exists) downloaded += 1;
      else updated += 1;
    } else {
      skipped += 1;
    }

    currentIds.add(file.id);
    nextFiles[file.id] = {
      id: file.id,
      name: file.name,
      localPath,
      modifiedTime: file.modifiedTime || null,
      md5Checksum: file.md5Checksum || null,
      mimeType: file.mimeType || null,
      deleted: false,
      deletedAt: null,
    };
  }

  let deleted = 0;
  for (const oldId of Object.keys(state.files || {})) {
    if (!currentIds.has(oldId)) {
      deleted += 1;
      const old = state.files[oldId] || {};
      nextFiles[oldId] = { ...old, deleted: true, deletedAt: new Date().toISOString() };
    }
  }

  const finishedAt = new Date().toISOString();
  saveSyncState(localDir, {
    files: nextFiles,
    lastSyncAt: finishedAt,
  });
  setLastSyncAt(finishedAt);

  return {
    downloaded,
    updated,
    deleted,
    skipped,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  getConnectedStatus,
  startConnect,
  finishConnect,
  syncNow,
};
