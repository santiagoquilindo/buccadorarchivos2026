function getGoogleSdk() {
  try {
    return require("googleapis").google;
  } catch {
    throw new Error("Falta dependencia googleapis. Ejecuta: npm --prefix backend install");
  }
}
const fs = require("fs");
const { loadTokenData } = require("./driveTokenStore");

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const status = Number(err?.response?.status || err?.code || 0);
  return status === 429 || status >= 500;
}

async function withRetry(fn, label) {
  const maxAttempts = Number(process.env.DRIVE_API_MAX_RETRIES || 5);
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(2000 * 2 ** (attempt - 1), 15000) + Math.floor(Math.random() * 300);
      console.warn(`[driveClient] ${label} intento ${attempt} fallo (${err.message}). Reintentando en ${delay}ms`);
      await sleep(delay);
    }
  }
}

function getDriveConfig() {
  return {
    authMode: (process.env.DRIVE_AUTH_MODE || "oauth").trim().toLowerCase(),
    folderId: String(process.env.DRIVE_FOLDER_ID || "").trim(),
    driveId: String(process.env.DRIVE_ID || "").trim() || null,
    useSharedDrive: parseBool(process.env.DRIVE_USE_SHARED_DRIVE, false),
  };
}

function getSharedDriveParams(cfg) {
  if (!cfg.useSharedDrive) {
    return {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };
  }

  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: cfg.driveId || undefined,
  };
}

function loadServiceAccountCredentials() {
  const raw = process.env.DRIVE_SERVICE_ACCOUNT_JSON || "";
  const file = process.env.DRIVE_SERVICE_ACCOUNT_JSON_FILE || "";

  if (raw.trim()) return JSON.parse(raw);
  if (file.trim()) return JSON.parse(fs.readFileSync(file.trim(), "utf8"));

  throw new Error("Configura DRIVE_SERVICE_ACCOUNT_JSON o DRIVE_SERVICE_ACCOUNT_JSON_FILE para auth service_account");
}

async function createAuthClient(cfg) {
  const google = getGoogleSdk();
  if (cfg.authMode === "service_account") {
    const credentials = loadServiceAccountCredentials();
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: DRIVE_SCOPES,
    });
    return auth.getClient();
  }

  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  const tokenData = loadTokenData();
  const refreshToken = String(
    process.env.GOOGLE_REFRESH_TOKEN
    || tokenData?.tokens?.refresh_token
    || ""
  ).trim();

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error("Configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI y GOOGLE_REFRESH_TOKEN");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials({
    refresh_token: refreshToken,
    access_token: tokenData?.tokens?.access_token || undefined,
    expiry_date: tokenData?.tokens?.expiry_date || undefined,
  });
  return oauth2;
}

async function buildDriveClient() {
  const cfg = getDriveConfig();
  const google = getGoogleSdk();
  const auth = await createAuthClient(cfg);
  const drive = google.drive({ version: "v3", auth });

  return {
    config: cfg,

    async getStartPageToken() {
      const params = getSharedDriveParams(cfg);
      const res = await withRetry(
        () => drive.changes.getStartPageToken(params),
        "changes.getStartPageToken"
      );
      return res.data.startPageToken;
    },

    async listChanges(pageToken) {
      const params = {
        pageToken,
        pageSize: 500,
        includeRemoved: true,
        restrictToMyDrive: false,
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,modifiedTime,size,md5Checksum,trashed))",
        ...getSharedDriveParams(cfg),
      };

      const res = await withRetry(
        () => drive.changes.list(params),
        "changes.list"
      );

      return {
        changes: res.data.changes || [],
        nextPageToken: res.data.nextPageToken || null,
        newStartPageToken: res.data.newStartPageToken || null,
      };
    },

    async listChildren(folderId, pageToken = null) {
      const params = {
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        pageSize: 500,
        pageToken: pageToken || undefined,
        fields: "nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,md5Checksum,trashed)",
        ...getSharedDriveParams(cfg),
      };

      const res = await withRetry(
        () => drive.files.list(params),
        "files.list"
      );

      return {
        files: res.data.files || [],
        nextPageToken: res.data.nextPageToken || null,
      };
    },

    async getFile(fileId) {
      const res = await withRetry(
        () => drive.files.get({
          fileId,
          fields: "id,name,mimeType,parents,modifiedTime,size,md5Checksum,trashed",
          supportsAllDrives: true,
        }),
        "files.get"
      );

      return res.data;
    },

    async watchChanges(pageToken, { address, token, channelId, expirationMs }) {
      const body = {
        id: channelId,
        type: "web_hook",
        address,
        token,
      };
      if (expirationMs) body.expiration = String(Date.now() + expirationMs);

      const res = await withRetry(
        () => drive.changes.watch({
          pageToken,
          requestBody: body,
          ...getSharedDriveParams(cfg),
        }),
        "changes.watch"
      );
      return res.data;
    },
    async exportSheetAsXlsx(fileId) {
      const res = await withRetry(
        () => drive.files.export(
          {
            fileId,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            supportsAllDrives: true,
          },
          { responseType: "arraybuffer" }
        ),
        "files.export"
      );

      return Buffer.from(res.data);
    },
    async downloadFileAsBuffer(fileId) {
      const res = await withRetry(
        () => drive.files.get(
          {
            fileId,
            alt: "media",
            supportsAllDrives: true,
          },
          { responseType: "arraybuffer" }
        ),
        "files.get(media)"
      );
      return Buffer.from(res.data);
    },
    async stopChannel(channelId, resourceId) {
      await withRetry(
        () => drive.channels.stop({ requestBody: { id: channelId, resourceId } }),
        "channels.stop"
      );
    },
  };
}

module.exports = {
  buildDriveClient,
  getDriveConfig,
};



