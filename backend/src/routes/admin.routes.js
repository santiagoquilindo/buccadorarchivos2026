const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function normalizeEmailsInput(input) {
  const rawItems = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  return [...new Set(
    rawItems
      .flatMap((item) => {
        const s = String(item || "").trim();
        if (!s) return [];
        // Supports malformed stored values like ["a@x.com","b@y.com"].
        if (s.startsWith("[") && s.endsWith("]")) {
          try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed.map((p) => String(p || "").trim());
          } catch {}
        }
        return [s];
      })
      .map((e) => e.toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  )];
}

router.get("/editor-emails", requireAuth, requireRole("ADMIN"), (req, res) => {
  const rows = db.prepare("SELECT email FROM editor_emails WHERE status='ACTIVE' ORDER BY email ASC").all();
  const cleaned = normalizeEmailsInput(rows.map((r) => r.email));
  res.json({ editor_emails: cleaned });
});

router.post("/users", requireAuth, requireRole("ADMIN"), (req, res) => {
  const { name, username, email, password, role } = req.body;

  if (!name || !username || !password || !role) return res.status(400).json({ message: "Faltan datos" });
  if (!["ADMIN", "USER"].includes(role)) return res.status(400).json({ message: "Rol inválido" });

  const exists = db.prepare("SELECT id FROM users WHERE username=?").get(username);
  if (exists) return res.status(409).json({ message: "Usuario ya existe" });
  if (email) {
    const emailExists = db.prepare("SELECT id FROM users WHERE email=?").get(String(email).trim().toLowerCase());
    if (emailExists) return res.status(409).json({ message: "El correo ya estÃ¡ en uso" });
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`
    INSERT INTO users (name, username, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE')
  `).run(name, username, email ? String(email).trim().toLowerCase() : null, hash, role);

  res.json({ message: "Usuario creado" });
});

router.post("/editor-emails", requireAuth, requireRole("ADMIN"), (req, res) => {
  const { emails } = req.body || {};
  const cleaned = normalizeEmailsInput(emails);

  if (!cleaned.length) return res.status(400).json({ message: "No hay correos validos" });

  const insert = db.prepare("INSERT OR IGNORE INTO editor_emails (email, status) VALUES (?, 'ACTIVE')");
  const tx = db.transaction((items) => {
    for (const email of items) insert.run(email);
  });
  tx(cleaned);

  const rows = db.prepare("SELECT email FROM editor_emails WHERE status='ACTIVE' ORDER BY email ASC").all();
  res.json({ editor_emails: rows.map((r) => r.email) });
});

module.exports = router;
