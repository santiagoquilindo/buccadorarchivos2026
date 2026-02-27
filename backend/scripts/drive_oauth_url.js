const { google } = require("googleapis");
const { getEnv } = require("./env_loader");

function required(name) {
  const v = getEnv(name);
  if (!v) {
    console.error(`[oauth:url] Falta variable ${name}`);
    process.exit(1);
  }
  return v;
}

const clientId = required("GOOGLE_CLIENT_ID");
const clientSecret = required("GOOGLE_CLIENT_SECRET");
const redirectUri = getEnv("GOOGLE_REDIRECT_URI", "http://localhost:3000/oauth2/callback");

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive.readonly"],
});

console.log("Abre esta URL y autoriza la app:\n");
console.log(url);
console.log("\nDespues copia el parametro code del redirect y ejecuta:\n");
console.log("npm run oauth:token -- --code=TU_CODE");
