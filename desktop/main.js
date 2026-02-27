const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");

let backendProc;
let isQuitting = false;

function configureRuntimePaths() {
  const runtimeBase = path.join(os.tmpdir(), "InventarioBuscador");
  const userDataPath = path.join(runtimeBase, "userData");
  const sessionDataPath = path.join(runtimeBase, "sessionData");
  const cachePath = path.join(runtimeBase, "cache");

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(sessionDataPath, { recursive: true });
  fs.mkdirSync(cachePath, { recursive: true });

  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  app.commandLine.appendSwitch("disk-cache-dir", cachePath);
}

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, () => resolve(true));
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error("Servidor no respondio a tiempo"));
        setTimeout(tick, 300);
      });
      req.end();
    };
    tick();
  });
}

function findFreePort(preferred = 3786) {
  const canUsePort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });

  return canUsePort(preferred).then((ok) => {
    if (ok) return preferred;
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.once("listening", () => {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : preferred;
        server.close(() => resolve(port));
      });
      server.listen(0, "127.0.0.1");
    });
  });
}

const PREFERRED_BACKEND_PORT = 3786;

async function startBackend() {
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.join(__dirname, "..", "backend");
  const frontendDir = app.isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "..", "frontend");
  const serverPath = path.join(backendDir, "src", "server.js");
  const port = await findFreePort(PREFERRED_BACKEND_PORT);
  const driveTokenPath = path.join(app.getPath("userData"), "drive_tokens.json");
  const driveLocalDir = path.join(app.getPath("userData"), "drive_cache");

  backendProc = spawn(process.execPath, [serverPath], {
    cwd: backendDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOST: "127.0.0.1",
      BACKEND_ROOT: backendDir,
      FRONTEND_ROOT: frontendDir,
      DRIVE_TOKEN_PATH: driveTokenPath,
      DRIVE_FOLDER_ID: "1AVWtreQK7XZ5ccShIBKksAHObwZjAKia",
      ALLOWED_EMAILS: "sagcauca@gmail.com,sagcaucapw@gmail.com",
      DRIVE_LOCAL_DIR: driveLocalDir,
      DRIVE_OAUTH_REQUIRED_PORT: String(PREFERRED_BACKEND_PORT)
    },
    windowsHide: true,
    stdio: "inherit"
  });

  return port;
}

function stopBackend() {
  if (!backendProc || backendProc.killed) return;
  backendProc.kill("SIGTERM");
  setTimeout(() => {
    if (backendProc && !backendProc.killed) backendProc.kill();
  }, 3000).unref();
}

async function createWindow(port) {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    autoHideMenuBar: true,
  });

  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForServer(url);
    await win.loadURL(url);
  } catch (e) {
    win.loadURL(`data:text/plain,No se pudo iniciar el servidor local (puerto ${port}).`);
  }
}

configureRuntimePaths();

app.whenReady().then(async () => {
  const port = await startBackend();
  await createWindow(port);
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
  if (isQuitting) app.quit();
});
