const { google } = require("googleapis");
const { getEnv } = require("./env_loader");

function parseArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function required(name) {
  const v = getEnv(name);
  if (!v) {
    console.error(`[oauth:token] Falta variable ${name}`);
    process.exit(1);
  }
  return v;
}

(async () => {
  const clientId = required("GOOGLE_CLIENT_ID");
  const clientSecret = required("GOOGLE_CLIENT_SECRET");
  const redirectUri = getEnv("GOOGLE_REDIRECT_URI", "http://localhost:3000/oauth2/callback");

  const code = parseArg("code") || getEnv("GOOGLE_AUTH_CODE");
  if (!code) {
    console.error("[oauth:token] Debes pasar --code=... o definir GOOGLE_AUTH_CODE");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    console.error("[oauth:token] Google no devolvio refresh_token. Repite autorizacion con prompt=consent.");
    process.exit(1);
  }

  console.log("GOOGLE_REFRESH_TOKEN=[REDACTED]
  console.log("\nGuarda ese valor en backend/.env y no lo compartas.");
})().catch((err) => {
  console.error("[oauth:token] Error:", err.message);
  process.exit(1);
});
