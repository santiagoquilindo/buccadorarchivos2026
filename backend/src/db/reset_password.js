const db = require("./database");
const bcrypt = require("bcryptjs");

// CAMBIA ESTO:
const username = "isabella victoria";   // <-- el username exacto guardado
const newPassword = "Nueva123*";        // <-- la nueva contraseña

const user = db.prepare("SELECT id FROM users WHERE username=?").get(username);
if (!user) {
  console.log("❌ No existe el usuario:", username);
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 12);
db.prepare("UPDATE users SET password_hash=? WHERE username=?").run(hash, username);

console.log("✅ Password reseteada para:", username);