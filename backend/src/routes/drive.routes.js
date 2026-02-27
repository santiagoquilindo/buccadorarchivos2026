const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const driveSyncService = require("../services/driveSyncService");
const driveManualSyncService = require("../services/driveManualSyncService");

const router = express.Router();

function renderOAuthResultPage(title, message) {
  const safeTitle = String(title || "Drive");
  const safeMessage = String(message || "");
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; color: #222; background: #f7f7f7; }
    .card { max-width: 680px; margin: 24px auto; background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 14px rgba(0,0,0,.08); }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0; font-size: 16px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`;
}

function safeEquals(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i += 1) out |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return out === 0;
}

router.get("/status", requireAuth, async (req, res) => {
  try {
    res.json(driveManualSyncService.getConnectedStatus());
  } catch (err) {
    res.status(500).json({ message: `Error consultando estado: ${err.message}` });
  }
});

router.post("/connect/start", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    res.json(driveManualSyncService.startConnect());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || "Error iniciando conexion de Drive" });
  }
});

router.post("/connect/finish", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { code } = req.body || {};
    const out = await driveManualSyncService.finishConnect(code);
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || "Error finalizando conexion de Drive" });
  }
});

router.get("/oauth2/callback", async (req, res) => {
  const code = String(req.query?.code || "").trim();
  if (!code) {
    return res
      .status(400)
      .type("html")
      .send(renderOAuthResultPage("Drive no conectado", "No se recibio codigo OAuth en el callback."));
  }

  try {
    await driveManualSyncService.finishConnect(code);
    return res
      .status(200)
      .type("html")
      .send(renderOAuthResultPage("Drive conectado", "Ya puedes cerrar esta ventana y volver a la app."));
  } catch (err) {
    const status = err.status || 500;
    const message = status === 403
      ? "Correo no autorizado para esta aplicacion."
      : `No se pudo completar la conexion de Drive: ${err.message || "error desconocido"}`;
    return res.status(status).type("html").send(renderOAuthResultPage("Error conectando Drive", message));
  }
});

router.post("/sync", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const out = await driveManualSyncService.syncNow();
    res.json(out);
  } catch (err) {
    console.error("[drive.sync]", err);
    res.status(err.status || 500).json({ message: err.message || "Error sincronizando" });
  }
});

router.post("/watch/start", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const out = await driveSyncService.ensureWatch();
    res.json(out);
  } catch (err) {
    console.error("[drive.watch.start]", err);
    res.status(500).json({ message: `Error creando watch: ${err.message}` });
  }
});

router.post("/watch/stop", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const out = await driveSyncService.stopWatch();
    res.json(out);
  } catch (err) {
    console.error("[drive.watch.stop]", err);
    res.status(500).json({ message: `Error deteniendo watch: ${err.message}` });
  }
});

router.post("/webhook", async (req, res) => {
  const tokenHeader = req.get("X-Goog-Channel-Token");
  const expected = process.env.DRIVE_WEBHOOK_TOKEN;
  if (expected && !safeEquals(tokenHeader, expected)) {
    return res.status(401).json({ message: "Token de webhook invalido" });
  }

  const state = String(req.get("X-Goog-Resource-State") || "").toLowerCase();
  const channelId = req.get("X-Goog-Channel-Id");
  const resourceId = req.get("X-Goog-Resource-Id");

  console.log(`[drive.webhook] state=${state || "n/a"} channel=${channelId || "n/a"} resource=${resourceId || "n/a"}`);

  res.status(200).json({ ok: true });

  if (state === "sync" || state === "update" || state === "change" || state === "exists") {
    driveSyncService.runSync("webhook").catch((err) => {
      console.error("[drive.webhook.sync]", err);
    });
  }
});

module.exports = router;
