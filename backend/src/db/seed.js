const db = require("./database");
const bcrypt = require("bcryptjs");

const ADMIN_USER = "admin";
const ADMIN_PASS = "Admin123*";
const USER_USER = "user1";
const USER_PASS = "User123*";

const DRIVE_URL = "https://drive.google.com/drive/folders/1AVWtreQK7XZ5ccShIBKksAHObwZjAKia?usp=drive_link";

function upsertUser({ name, username, email, password, role }) {
  const hash = bcrypt.hashSync(password, 12);
  const existing = db.prepare("SELECT id FROM users WHERE username=?").get(username);

  if (!existing) {
    db.prepare(`
      INSERT INTO users (name, username, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE')
    `).run(name, username, email || null, hash, role);
    console.log("Usuario creado:", username);
  } else {
    db.prepare(`
      UPDATE users
      SET email=?, password_hash=?, role=?, status='ACTIVE'
      WHERE username=?
    `).run(email || null, hash, role, username);
    console.log("Usuario actualizado:", username);
  }
}

upsertUser({
  name: "Administrador",
  username: ADMIN_USER,
  email: "admin@inventario.local",
  password: ADMIN_PASS,
  role: "ADMIN",
});

upsertUser({
  name: "Usuario",
  username: USER_USER,
  email: "user1@inventario.local",
  password: USER_PASS,
  role: "USER",
});

const docName = "Inventario Archivo";
const doc = db.prepare("SELECT id FROM documents WHERE name=?").get(docName);
if (!doc) {
  db.prepare("INSERT INTO documents (name, url_drive, status) VALUES (?, ?, 'ACTIVE')").run(docName, DRIVE_URL);
} else {
  db.prepare("UPDATE documents SET url_drive=? WHERE name=?").run(DRIVE_URL, docName);
}

const editorEmails = String(process.env.EDITOR_EMAILS || "admin@inventario.local")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const addEditor = db.prepare("INSERT OR IGNORE INTO editor_emails (email, status) VALUES (?, 'ACTIVE')");
for (const email of editorEmails) {
  addEditor.run(email);
}

const file = db.prepare("SELECT id FROM files WHERE title=?").get("Inventario general");
if (!file) {
  db.prepare(`
    INSERT INTO files (title, drive_url, cabinet, file_date, status)
    VALUES (?, ?, ?, ?, 'ACTIVE')
  `).run("Inventario general", DRIVE_URL, "Gabinete principal", null);
}

console.log("Seed finalizado.");
