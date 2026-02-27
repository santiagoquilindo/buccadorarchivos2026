const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const driveSyncService = require("../services/driveSyncService");

const router = express.Router();

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
    res.json(driveSyncService.getStatus());
  } catch (err) {
    res.status(500).json({ message: `Error consultando estado: ${err.message}` });
  }
});

router.post("/sync", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const out = await driveSyncService.runSync("manual");
    res.json(out);
  } catch (err) {
    console.error("[drive.sync]", err);
    res.status(500).json({ message: `Error sincronizando: ${err.message}` });
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
