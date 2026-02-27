const fs = require("fs");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] == null || String(process.env[key]).trim() === "") {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const authRoutes = require("./routes/auth.routes");
const adminRoutes = require("./routes/admin.routes");
const appRoutes = require("./routes/app.routes");
const importRoutes = require("./routes/import.routes");
const driveRoutes = require("./routes/drive.routes");

const app = express();

app.use(express.json());
app.use(cookieParser());

// Servir frontend
const FRONTEND_ROOT = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : path.join(__dirname, "../../frontend");
app.use(express.static(FRONTEND_ROOT));

// API
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/app", appRoutes);
app.use("/api/import", importRoutes);
app.use("/api/drive", driveRoutes);

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_ROOT, "login.html"));
});

// Puerto/host configurable (Electron / produccion)
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const server = app.listen(PORT, HOST, () => {
  console.log(`Servidor: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Cierre solicitado (${signal})...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
