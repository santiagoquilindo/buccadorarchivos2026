const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db/database");
const { JWT_SECRET, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  const loginId = String(username || "").trim();

  const user = db.prepare(`
    SELECT *
    FROM users
    WHERE lower(username)=lower(?) OR lower(COALESCE(email, ''))=lower(?)
    LIMIT 1
  `).get(loginId, loginId);

  if (!user || user.status !== "ACTIVE") return res.status(401).json({ message: "Credenciales invalidas" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Credenciales invalidas" });

  const token = jwt.sign(
    { id: user.id, role: user.role, username: user.username, email: user.email || null },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  db.prepare("INSERT INTO access_logs (user_id, action) VALUES (?, ?)").run(user.id, "LOGIN");

  res.cookie("token", token, { httpOnly: true, sameSite: "lax" });
  res.json({ role: user.role });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
