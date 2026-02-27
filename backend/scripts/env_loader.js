const fs = require("fs");
const path = require("path");

function parseEnvContent(content) {
  const out = {};
  for (const lineRaw of String(content || "").split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFromFile(filePath) {
  const full = filePath || path.join(__dirname, "..", ".env");
  if (!fs.existsSync(full)) return {};
  const content = fs.readFileSync(full, "utf8");
  return parseEnvContent(content);
}

function getEnv(name, fallback = "") {
  if (process.env[name] != null && String(process.env[name]).trim() !== "") {
    return String(process.env[name]).trim();
  }
  const fromFile = loadEnvFromFile()[name];
  return fromFile != null ? String(fromFile).trim() : fallback;
}

module.exports = {
  loadEnvFromFile,
  getEnv,
};
