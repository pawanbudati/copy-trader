const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { TradeEngine } = require("./src/backend/engine");
const { FileStore } = require("./src/backend/store");
const { createBrokerClient } = require("./src/backend/brokerFactory");
const { AuditLogger } = require("./src/backend/auditLogger");
const { configureApiCallLogger } = require("./src/backend/apiCallLogger");

const dataDir = path.join(app.getPath("userData"), "data");
const storePath = path.join(dataDir, "accounts.enc");
const auditPath = path.join(dataDir, "audit.log");
const apiCallLogPath = path.join(dataDir, "api-calls.log");
configureApiCallLogger(apiCallLogPath);
const store = new FileStore(storePath);
const auditLogger = new AuditLogger(auditPath);
const engine = new TradeEngine({
  store,
  brokerFactory: createBrokerClient,
  auditLogger,
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 760,
    webPreferences: {
      preload: path.join(__dirname, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "renderer", "index.html"));
}

function createAuthWindow(authUrl, redirectUri = null) {
  if (!authUrl || !mainWindow) {
    return;
  }

  const authWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 1000,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  authWindow.once("ready-to-show", () => {
    authWindow.show();
  });

  authWindow.webContents.on("did-finish-load", () => {
    const currentUrl = authWindow.webContents.getURL();
    if (redirectUri && currentUrl.startsWith(redirectUri)) {
      setTimeout(() => {
        if (!authWindow.isDestroyed()) {
          authWindow.close();
        }
      }, 1200);
    }
  });

  authWindow.on("closed", () => {
    // no-op, let GC do its job
  });

  authWindow.loadURL(authUrl);

  return authWindow;
}

function wireIpc() {
  const safe = (fn) => async (_event, payload) => {
    try {
      const data = await fn(payload || {});
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  };

  ipcMain.handle("accounts:list", safe(() => engine.listAccounts()));
  ipcMain.handle("accounts:add", safe((payload) => engine.addAccount(payload)));
  ipcMain.handle(
    "accounts:remove",
    safe((payload) => engine.removeAccount(payload.id))
  );
  ipcMain.handle(
    "accounts:setLeader",
    safe((payload) => engine.setLeader(payload.id))
  );
  ipcMain.handle(
    "accounts:updateRisk",
    safe((payload) => engine.updateRisk(payload.id, payload.risk))
  );
  ipcMain.handle(
    "accounts:getAuthUrl",
    safe((payload) => engine.getAuthorizeUrl(payload.id))
  );
  ipcMain.handle(
    "accounts:startAuthFlow",
    safe(async (payload) => {
      const result = await engine.startAuthFlow(payload.id, payload);

      const openInApp = Boolean(payload.openInApp);
      const openExternalBrowser = payload.openBrowser !== false;

      if (openInApp) {
        createAuthWindow(result.url, result.redirectUri || "");
      } else if (openExternalBrowser) {
        await shell.openExternal(result.url);
      }

      return result;
    })
  );
  ipcMain.handle(
    "accounts:getAuthFlowStatus",
    safe((payload) => engine.getAuthFlowStatus(payload.id))
  );
  ipcMain.handle(
    "accounts:cancelAuthFlow",
    safe((payload) => engine.cancelAuthFlow(payload.id))
  );
  ipcMain.handle(
    "accounts:login",
    safe((payload) => engine.loginAccount(payload.id, payload))
  );
  ipcMain.handle("accounts:loginAll", safe(() => engine.loginAllAccounts()));
  ipcMain.handle("system:getStatus", safe(() => engine.getSystemStatus()));
  ipcMain.handle(
    "system:setEmergencyStop",
    safe((payload) => engine.setEmergencyStop(payload))
  );
  ipcMain.handle(
    "audit:getRecent",
    safe((payload) => engine.getRecentAudit(payload.limit || 100))
  );
  ipcMain.handle("audit:clear", safe(() => engine.clearAudit()));
  ipcMain.handle(
    "instruments:search",
    safe((payload) => engine.searchInstruments(payload))
  );
  ipcMain.handle(
    "orders:placeLeader",
    safe((payload) => engine.placeLeaderOrder(payload))
  );
  ipcMain.handle(
    "orders:exitLeader",
    safe((payload) => engine.exitLeaderOrder(payload.leaderOrderId))
  );
  ipcMain.handle("orders:listOpen", safe(() => engine.listOpenLeaderOrders()));
  ipcMain.handle("dashboard:get", safe(() => engine.getDashboard()));
}

app.whenReady().then(async () => {
  await engine.load();
  wireIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
