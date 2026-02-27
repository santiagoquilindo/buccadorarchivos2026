const path = require("path");
const { loadEnvFromFile } = require("./env_loader");
const { runSync } = require("../src/services/driveSyncService");

const fileEnv = loadEnvFromFile(path.join(__dirname, "..", ".env"));
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] == null || String(process.env[k]).trim() === "") {
    process.env[k] = String(v);
  }
}

(async () => {
  const out = await runSync("cli");
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error("[drive:sync] Error:", err.message);
  process.exit(1);
});
