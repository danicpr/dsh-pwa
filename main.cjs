const { app, BrowserWindow, session, shell, Menu, Tray, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const HOME = os.homedir();
const DEFAULT_PORT = Number(process.env.DSH_PWA_PORT || 3080);
const DEFAULT_HOST = process.env.DSH_PWA_HOST || "127.0.0.1";
const TARGET_ORIGIN = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const ICON_PATH = path.join(__dirname, "assets", "icon.png");

// 1. Identity & Wayland / GPU / Audio / Keyring flags for 100% Wallpaper Engine compatibility
app.setName("dsh-pwa");
if (typeof app.setDesktopName === "function") {
  app.setDesktopName("dsh-pwa.desktop");
}

// Avoid blocking on gnome-keyring / gcr-prompter on cold boot when setting localhost auth cookie
app.commandLine.appendSwitch("password-store", "basic");
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch(
  "enable-features",
  "VaapiVideoDecodeLinuxGL,VaapiVideoDecoder,CanvasOopRasterization"
);
app.commandLine.appendSwitch("disable-features", "Vulkan");

// CSS fix ensuring DSH root/frame containers are transparent under ALL Wallpaper Engine adapters
const WALLPAPER_ENGINE_COMPAT_CSS = `
body[data-we-wallpaper],
body[data-we-wallpaper] [class*="_frame"],
body[data-we-wallpaper] [class*="_root"] {
  background: transparent !important;
}
`;

function encodeBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(str) {
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(
    str.replaceAll("-", "+").replaceAll("_", "/") + padding,
    "base64"
  );
}

/**
 * Build a signed dsh-auth-<authority> cookie from ~/.dsh/.credentials.yaml.
 */
function buildDshAuthCookieData(targetOrigin) {
  try {
    const dshHome = process.env.DSH_HOME || path.join(HOME, ".dsh");
    const candidates = [
      path.join(dshHome, ".credentials.yaml"),
      path.join(dshHome, "profiles", "web", ".credentials.yaml")
    ];
    let secretB64 = null;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(
        /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/
      );
      if (match && match[1]) {
        secretB64 = match[1].trim();
        break;
      }
    }
    if (!secretB64) return null;

    const secret = decodeBase64Url(secretB64);
    if (!secret || secret.byteLength !== 32) return null;

    const url = new URL(targetOrigin);
    const authority = url.host;
    const cookieName =
      "dsh-auth-" +
      encodeBase64Url(crypto.createHash("sha256").update(authority).digest());

    const issuedAt = Date.now();
    const maxAgeDays = 30;
    const expiresAt = issuedAt + maxAgeDays * 1440 * 60 * 1000;
    const payload = {
      version: 1,
      authority,
      issuedAt,
      expiresAt
    };
    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = encodeBase64Url(
      crypto.createHmac("sha256", secret).update(body).digest()
    );
    const cookieValue = `v1.${body}.${sig}`;

    return {
      cookieName,
      cookieValue,
      expiresAt,
      header: `${cookieName}=${cookieValue}`
    };
  } catch {
    return null;
  }
}

/**
 * Mint and store a valid dsh-auth-<authority> cookie in Electron's session.
 */
async function ensureDshAuthCookie(targetOrigin) {
  try {
    const data = buildDshAuthCookieData(targetOrigin);
    if (!data) return false;

    await session.defaultSession.cookies.set({
      url: targetOrigin,
      name: data.cookieName,
      value: data.cookieValue,
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      expirationDate: Math.floor(data.expiresAt / 1000)
    });
    return true;
  } catch (err) {
    console.error("[dsh-pwa] Failed to mint DSH auth cookie:", err);
    return false;
  }
}

/**
 * Verify that 'dsh web' is NOT merely listening on the TCP port (which returns 404
 * while plugins are still loading), but has mounted FrontendStatic AND injected
 * window.__DSH_BOOT__ into index.html.
 */
function checkServerReady(targetOrigin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const cookieData = buildDshAuthCookieData(targetOrigin);
    const headers = cookieData ? { Cookie: cookieData.header } : {};
    const req = http.get(targetOrigin, { headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 65536) body += chunk;
      });
      res.on("end", () => {
        // Ready when authenticated GET / returns 200 HTML with __DSH_BOOT__ injected
        if (res.statusCode === 200 && body.includes("__DSH_BOOT__")) {
          resolve(true);
          return;
        }
        // Fallback if .credentials.yaml is not readable yet but auth gate is mounted
        if (!cookieData && res.statusCode === 401 && body.includes("dsh web authentication required")) {
          resolve(true);
          return;
        }
        resolve(false);
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Resolve the 'dsh' executable even on cold boot when fnm_multishells is not in PATH.
 */
function resolveDshBinary() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }
  const fnmDefault = path.join(HOME, ".local", "share", "fnm", "aliases", "default", "bin", "dsh");
  if (fs.existsSync(fnmDefault)) {
    return fnmDefault;
  }
  const fnmVersionsDir = path.join(HOME, ".local", "share", "fnm", "node-versions");
  try {
    if (fs.existsSync(fnmVersionsDir)) {
      const versions = fs.readdirSync(fnmVersionsDir).sort().reverse();
      for (const ver of versions) {
        const candidate = path.join(fnmVersionsDir, ver, "installation", "bin", "dsh");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  const nvmVersionsDir = path.join(HOME, ".nvm", "versions", "node");
  try {
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
      for (const ver of versions) {
        const candidate = path.join(nvmVersionsDir, ver, "bin", "dsh");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  const pnpmBin = path.join(HOME, ".local", "share", "pnpm", "dsh");
  if (fs.existsSync(pnpmBin)) {
    return pnpmBin;
  }
  const localBin = path.join(HOME, ".local", "bin", "dsh");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return "dsh";
}

// Only populated if dsh-pwa itself had to spawn 'dsh web' because none was running.
// If 'dsh web' was already running before opening dsh-pwa, this remains null and is never touched.
let spawnedServerChild = null;
let latestDiscoveredTokenUrl = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;

function stopSpawnedServer() {
  if (!spawnedServerChild) return;
  const child = spawnedServerChild;
  spawnedServerChild = null;
  try {
    child.kill("SIGTERM");
  } catch {}
}

function quitApplication() {
  isQuitting = true;
  stopSpawnedServer();
  app.quit();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  updateTrayMenu();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  saveWindowState(mainWindow);
  mainWindow.hide();
  updateTrayMenu();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showMainWindow();
  } else {
    hideMainWindow();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const isVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isVisible ? "Hide" : "Show",
      click: () => toggleMainWindow()
    },
    {
      label: "Reload",
      click: () => {
        showMainWindow();
        mainWindow?.webContents.reload();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => quitApplication()
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function setupSystemTray() {
  if (tray) return;
  try {
    let trayIcon = nativeImage.createFromPath(ICON_PATH);
    if (!trayIcon.isEmpty()) {
      trayIcon = trayIcon.resize({ width: 32, height: 32 });
    }
    tray = new Tray(trayIcon);
    tray.setToolTip("DeepSeek Harness");
    tray.on("click", () => toggleMainWindow());
    updateTrayMenu();
  } catch (err) {
    console.error("[dsh-pwa] Failed to initialize system tray:", err);
  }
}

function startDshWebServer(targetOrigin, port) {
  return new Promise((resolve, reject) => {
    const workdir = path.join(HOME, "Documents", "deepseek-harness", "default-workspace");
    const cwd = fs.existsSync(workdir) ? workdir : HOME;

    let settled = false;
    let discoveredTokenUrl = null;
    let outputBuffer = "";

    const dshBin = resolveDshBinary();
    const dshBinDir = path.isAbsolute(dshBin) ? path.dirname(dshBin) : null;
    const localBinDir = path.join(HOME, ".local", "bin");
    const rawPathParts = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
    const cleanPathParts = rawPathParts.filter(
      (p) => p && !p.startsWith("/tmp/.mount_") && (!process.env.APPDIR || !p.startsWith(process.env.APPDIR))
    );
    const pathParts = [
      localBinDir,
      ...(dshBinDir ? [dshBinDir] : []),
      ...cleanPathParts
    ];
    const childEnv = {
      ...process.env,
      PATH: Array.from(new Set(pathParts)).join(path.delimiter)
    };
    // Strip AppImage runtime variables so 'dsh web' and tools it spawns (gio, nvim, etc.)
    // never inherit bundled AppImage libraries.
    for (const key of [
      "LD_LIBRARY_PATH",
      "LD_PRELOAD",
      "APPIMAGE",
      "APPDIR",
      "OWD",
      "ARGV0",
      "GDK_PIXBUF_MODULE_FILE",
      "GDK_PIXBUF_MODULEDIR",
      "GIO_MODULE_DIR",
      "GIO_EXTRA_MODULES",
      "GTK_PATH",
      "GTK_EXE_PREFIX",
      "GTK_DATA_PREFIX",
      "GSETTINGS_SCHEMA_DIR",
      "QT_PLUGIN_PATH",
      "PERLLIB",
      "PYTHONHOME",
      "PYTHONPATH"
    ]) {
      delete childEnv[key];
    }

    const child = spawn(
      dshBin,
      ["--profile", "web", "--no-open", "--port", String(port)],
      {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    spawnedServerChild = child;

    const onData = (chunk) => {
      outputBuffer += chunk.toString("utf8");
      if (outputBuffer.length > 16384) {
        outputBuffer = outputBuffer.slice(-8192);
      }
      const m = outputBuffer.match(/dsh web:\s*(http:\/\/[^\s]+)/);
      if (m && m[1]) {
        discoveredTokenUrl = m[1].trim();
        latestDiscoveredTokenUrl = discoveredTokenUrl;
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("exit", (code) => {
      if (spawnedServerChild === child) {
        spawnedServerChild = null;
      }
      if (!settled) {
        settled = true;
        reject(new Error(`dsh web terminó prematuramente (código ${code})`));
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    const startTime = Date.now();
    const maxWaitMs = 45000;

    const poll = async () => {
      if (settled) return;
      const elapsed = Date.now() - startTime;
      const ready = await checkServerReady(targetOrigin, 1200);
      if (ready && (discoveredTokenUrl || elapsed > 4000)) {
        settled = true;
        resolve(discoveredTokenUrl || targetOrigin);
        return;
      }
      if (elapsed > maxWaitMs) {
        settled = true;
        reject(new Error("Tiempo de espera agotado iniciando dsh web (45s)"));
        return;
      }
      setTimeout(poll, 300);
    };

    setTimeout(poll, 350);
  });
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width >= 480 &&
      parsed.height >= 360
    ) {
      return parsed;
    }
  } catch {}
  return { width: 1400, height: 900, isMaximized: false };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const isMaximized = win.isMaximized();
    const bounds = win.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch {}
}

function buildLoadingHtml(statusText) {
  return `data:text/html;charset=utf-8,` + encodeURIComponent(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>DeepSeek Harness</title>
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #0a0e17;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    user-select: none;
  }
  .card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 18px;
    padding: 36px 44px;
    text-align: center;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    max-width: 420px;
  }
  .spinner {
    width: 42px; height: 42px;
    margin: 0 auto 20px;
    border: 3px solid rgba(99, 102, 241, 0.2);
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 0.85s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; font-size: 13px; color: #94a3b8; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>DeepSeek Harness</h2>
    <p id="msg">${statusText}</p>
  </div>
</body>
</html>`);
}

async function createMainWindow() {
  const rawUa = session.defaultSession.getUserAgent();
  const cleanUa = rawUa
    .replace(/\s*Electron\/[\d.]+/gi, "")
    .replace(/\s*dsh-pwa\/[\d.]+/gi, "");
  session.defaultSession.setUserAgent(cleanUa);

  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width || 1400,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 360,
    title: "DeepSeek Harness",
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: "#0a0e17",
    autoHideMenuBar: true,
    show: !process.argv.includes("--minimized"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  });

  if (state.isMaximized && !process.argv.includes("--minimized")) {
    mainWindow.maximize();
  }

  mainWindow.webContents.setUserAgent(cleanUa);

  const injectWeCss = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.insertCSS(WALLPAPER_ENGINE_COMPAT_CSS).catch(() => {});
  };
  mainWindow.webContents.on("dom-ready", injectWeCss);
  mainWindow.webContents.on("did-finish-load", injectWeCss);

  // Self-healing guard: if navigation to TARGET_ORIGIN ever lands on an empty/404/401 page
  // during cold-boot initialization, automatically re-authenticate and reload.
  let recoveryAttempts = 0;
  const maxRecoveryAttempts = 10;

  const scheduleRecovery = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (recoveryAttempts >= maxRecoveryAttempts) return;
    recoveryAttempts += 1;
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await ensureDshAuthCookie(TARGET_ORIGIN);
      const ready = await checkServerReady(TARGET_ORIGIN, 1200);
      if (ready && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(latestDiscoveredTokenUrl || TARGET_ORIGIN).catch(() => {});
      } else {
        scheduleRecovery();
      }
    }, 500);
  };

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 is ERR_ABORTED
    if (validatedURL && validatedURL.startsWith("http://")) {
      scheduleRecovery();
    }
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl.startsWith("http://")) return;
    try {
      const pageOk = await mainWindow.webContents.executeJavaScript(`(() => {
        const text = document.body ? document.body.innerText : "";
        if (text.includes("dsh web authentication required")) return false;
        const hasBoot = typeof window.__DSH_BOOT__ !== "undefined";
        const hasRoot = Boolean(document.getElementById("root") || document.querySelector('[class*="_root"]'));
        return hasBoot || hasRoot;
      })()`);
      if (pageOk) {
        recoveryAttempts = 0;
      } else {
        scheduleRecovery();
      }
    } catch {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === TARGET_ORIGIN || parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return { action: "allow" };
      }
    } catch {}
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
          event.preventDefault();
          shell.openExternal(url);
        }
      }
    } catch {}
  });

  mainWindow.on("show", () => updateTrayMenu());
  mainWindow.on("hide", () => updateTrayMenu());

  // Close-to-tray behavior: closing the window hides it to the system tray
  // unless the user explicitly requested a full quit (Tray -> Salir or Ctrl+Q).
  mainWindow.on("close", (event) => {
    saveWindowState(mainWindow);
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  const menuTemplate = [
    {
      label: "Aplicación",
      submenu: [
        {
          label: "Ocultar en bandeja del sistema",
          accelerator: "CmdOrCtrl+W",
          click: () => hideMainWindow()
        },
        {
          label: "Recargar DSH",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload()
        },
        {
          label: "Forzar recarga (sin caché)",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => mainWindow?.webContents.reloadIgnoringCache()
        },
        { type: "separator" },
        {
          label: "Herramientas de desarrollo (DevTools)",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools()
        },
        {
          label: "Pantalla completa",
          accelerator: "F11",
          click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen())
        },
        { type: "separator" },
        {
          label: "Salir completamente",
          accelerator: "CmdOrCtrl+Q",
          click: () => quitApplication()
        }
      ]
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "Vista",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  updateTrayMenu();

  const ready = await checkServerReady(TARGET_ORIGIN);
  let urlToLoad = TARGET_ORIGIN;

  if (!ready) {
    await mainWindow.loadURL(
      buildLoadingHtml("Iniciando servidor local 'dsh web'...")
    );
    try {
      urlToLoad = await startDshWebServer(TARGET_ORIGIN, DEFAULT_PORT);
    } catch (err) {
      await mainWindow.loadURL(
        buildLoadingHtml("Error al iniciar dsh web: " + (err?.message || String(err)))
      );
      return;
    }
  }

  await ensureDshAuthCookie(TARGET_ORIGIN);
  await mainWindow.loadURL(urlToLoad);

  if (process.argv.includes("--verify")) {
    setTimeout(async () => {
      try {
        const report = await mainWindow.webContents.executeJavaScript(`(() => {
          const stage = document.querySelector(".we-stage");
          const rootEl = document.querySelector('[class*="_root"]');
          const frameEl = document.querySelector('[class*="_frame"]');
          const c = document.createElement("canvas");
          const gl2 = c.getContext("webgl2");
          return {
            title: document.title,
            url: location.href,
            userAgent: navigator.userAgent,
            weWallpaper: document.body.dataset.weWallpaper || null,
            weAdapter: document.body.dataset.weAdapter || null,
            hasWeStage: Boolean(stage),
            stageChildren: stage ? stage.children.length : 0,
            rootBg: rootEl ? getComputedStyle(rootEl).backgroundColor : null,
            frameBg: frameEl ? getComputedStyle(frameEl).backgroundColor : null,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            webgl2: Boolean(gl2),
            webglRenderer: gl2 ? gl2.getParameter(gl2.RENDERER) : null
          };
        })()`);
        report.hasTray = Boolean(tray);
        console.log("DSH_PWA_VERIFY_REPORT=" + JSON.stringify(report));
      } catch (e) {
        console.error("DSH_PWA_VERIFY_ERROR=", e);
      } finally {
        quitApplication();
      }
    }, 3500);
  }
}

app.on("before-quit", () => {
  isQuitting = true;
});
app.on("will-quit", () => stopSpawnedServer());
process.on("exit", () => stopSpawnedServer());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    quitApplication();
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock && !process.argv.includes("--new-window")) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    setupSystemTray();
    await createMainWindow();
  });

  app.on("window-all-closed", () => {
    if (isQuitting || !tray) {
      stopSpawnedServer();
      app.quit();
    }
  });
}
