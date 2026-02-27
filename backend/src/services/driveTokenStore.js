const fs = require("fs");
const path = require("path");

function getTokenPath() {
  const configured = String(process.env.DRIVE_TOKEN_PATH || "").trim();
  if (configured) return path.resolve(configured);
  return path.join(__dirname, "..", "..", "data", "drive_tokens.json");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sanitizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return {};
  return {
    refresh_token: tokens.refresh_token || null,
    access_token: tokens.access_token || null,
    expiry_date: tokens.expiry_date || null,
  };
}

function loadTokenData() {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    if (!data || typeof data !== "object") return null;
    return {
      email: String(data.email || "").trim().toLowerCase() || null,
      tokens: sanitizeTokens(data.tokens),
      connectedAt: data.connectedAt || null,
      lastSyncAt: data.lastSyncAt || null,
    };
  } catch {
    return null;
  }
}

function saveTokenData(input) {
  const tokenPath = getTokenPath();
  ensureParentDir(tokenPath);
  const payload = {
    email: String(input.email || "").trim().toLowerCase() || null,
    tokens: sanitizeTokens(input.tokens),
    connectedAt: input.connectedAt || new Date().toISOString(),
    lastSyncAt: input.lastSyncAt || null,
  };
  fs.writeFileSync(tokenPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function setLastSyncAt(iso) {
  const current = loadTokenData();
  if (!current) return null;
  return saveTokenData({
    ...current,
    lastSyncAt: iso || new Date().toISOString(),
  });
}

module.exports = {
  getTokenPath,
  loadTokenData,
  saveTokenData,
  setLastSyncAt,
};
