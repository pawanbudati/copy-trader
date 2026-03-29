const crypto = require("crypto");
const http = require("http");
const { BROKER_TYPES, normalizeBrokerType, brokerLabel } = require("./brokers");

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function mask(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultRisk() {
  return {
    quantityMode: "multiplier",
    qtyMultiplier: 1,
    fixedQuantity: 1,
    maxOrderQty: 0,
    maxDailyLoss: 0,
    marginGuardEnabled: false,
    minAvailableFunds: 0,
    marketPriceFallback: 100,
  };
}

function normalizeRisk(risk) {
  const merged = {
    ...defaultRisk(),
    ...(risk || {}),
  };
  const quantityMode =
    String(merged.quantityMode || "").toLowerCase() === "fixed" ? "fixed" : "multiplier";
  return {
    quantityMode,
    qtyMultiplier: Math.max(0, toNumber(merged.qtyMultiplier, 1)),
    fixedQuantity: Math.max(1, Math.floor(toNumber(merged.fixedQuantity, 1))),
    maxOrderQty: Math.max(0, Math.floor(toNumber(merged.maxOrderQty, 0))),
    maxDailyLoss: Math.max(0, toNumber(merged.maxDailyLoss, 0)),
    marginGuardEnabled: Boolean(merged.marginGuardEnabled),
    minAvailableFunds: Math.max(0, toNumber(merged.minAvailableFunds, 0)),
    marketPriceFallback: Math.max(1, toNumber(merged.marketPriceFallback, 100)),
  };
}

function defaultCredentialsForBroker(brokerType) {
  const type = normalizeBrokerType(brokerType);
  if (type === BROKER_TYPES.ALICE_BLUE) {
    return {
      aliceUserId: "",
      aliceApiKey: "",
      sessionId: "",
    };
  }
  if (type === BROKER_TYPES.KOTAK_NEO) {
    return {
      consumerKey: "",
      accessToken: "",
      tradingSid: "",
      serverId: "",
      baseUrl: "",
      kotakUcc: "",
      mobileNumber: "",
    };
  }
  return {
    clientId: "",
    clientSecret: "",
    redirectUri: "",
    accessToken: "",
  };
}

function normalizeCredentials(brokerType, credentials = {}, fallback = {}) {
  const type = normalizeBrokerType(brokerType);
  const defaults = defaultCredentialsForBroker(type);
  const merged = {
    ...defaults,
    ...(credentials || {}),
  };

  if (type === BROKER_TYPES.ALICE_BLUE) {
    return {
      ...defaults,
      aliceUserId: String(
        merged.aliceUserId || fallback.aliceUserId || fallback.clientId || ""
      ).trim(),
      aliceApiKey: String(
        merged.aliceApiKey || fallback.aliceApiKey || fallback.clientSecret || ""
      ).trim(),
      sessionId: String(
        merged.sessionId || merged.accessToken || fallback.sessionId || fallback.accessToken || ""
      ).trim(),
    };
  }

  if (type === BROKER_TYPES.KOTAK_NEO) {
    return {
      ...defaults,
      consumerKey: String(
        merged.consumerKey || fallback.consumerKey || fallback.clientId || ""
      ).trim(),
      accessToken: String(
        merged.accessToken || fallback.accessToken || ""
      ).trim(),
      tradingSid: String(merged.tradingSid || fallback.tradingSid || "").trim(),
      serverId: String(merged.serverId || fallback.serverId || "").trim(),
      baseUrl: String(merged.baseUrl || fallback.baseUrl || "").trim(),
      kotakUcc: String(merged.kotakUcc || fallback.kotakUcc || "").trim(),
      mobileNumber: String(merged.mobileNumber || fallback.mobileNumber || "").trim(),
    };
  }

  return {
    ...defaults,
    clientId: String(merged.clientId || fallback.clientId || "").trim(),
    clientSecret: String(merged.clientSecret || fallback.clientSecret || "").trim(),
    redirectUri: String(merged.redirectUri || fallback.redirectUri || "").trim(),
    accessToken: String(merged.accessToken || fallback.accessToken || "").trim(),
  };
}

function normalizeUserId(value, fallbackPrefix) {
  const cleaned = String(value || "").trim();
  if (cleaned) {
    return cleaned;
  }
  return `${fallbackPrefix}_${Math.floor(Math.random() * 9000) + 1000}`;
}

function nowIso() {
  return new Date().toISOString();
}

function authHtml(status, message) {
  const color = status === "success" ? "#0d6f4f" : "#b43333";
  const title = status === "success" ? "Authentication Complete" : "Authentication Failed";
  return [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>",
    `<title>${title}</title>`,
    "</head><body style='font-family:Segoe UI,Arial,sans-serif;padding:24px;'>",
    `<h2 style='margin:0 0 10px;color:${color};'>${title}</h2>`,
    `<p style='margin:0 0 6px;'>${message}</p>`,
    "<p style='margin:0;color:#4b5563;'>You can close this browser tab and return to the app.</p>",
    "</body></html>",
  ].join("");
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch (_error) {
      resolve();
    }
  });
}

class TradeEngine {
  constructor({ store, brokerFactory, auditLogger = null }) {
    this.store = store;
    this.brokerFactory = brokerFactory;
    this.auditLogger = auditLogger;
    this.authFlows = new Map();
    this.state = {
      accounts: [],
      orderLinks: [],
      emergencyStopFollowers: false,
      emergencyReason: null,
      emergencyUpdatedAt: null,
    };
  }

  writeAudit(event) {
    if (!this.auditLogger) {
      return null;
    }
    return this.auditLogger.log(event);
  }

  getRecentAudit(limit = 100) {
    if (!this.auditLogger) {
      return [];
    }
    return this.auditLogger.readRecent(limit);
  }

  clearAudit() {
    if (!this.auditLogger) {
      return { cleared: false, reason: "Audit logger not configured" };
    }
    return this.auditLogger.clear();
  }

  normalizeLoadedState(stored) {
    const state = {
      accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
      orderLinks: Array.isArray(stored.orderLinks) ? stored.orderLinks : [],
      emergencyStopFollowers: Boolean(stored.emergencyStopFollowers),
      emergencyReason: stored.emergencyReason || null,
      emergencyUpdatedAt: stored.emergencyUpdatedAt || null,
    };

    state.accounts = state.accounts.map((account) => {
      const brokerType = normalizeBrokerType(account.brokerType);
      const legacyFallback = {
        clientId: String(account.clientId || account.apiKey || "").trim(),
        clientSecret: String(account.clientSecret || "").trim(),
        redirectUri: String(account.redirectUri || "").trim(),
        accessToken: String(account.accessToken || account.sessionToken || "").trim(),
        tradingSid: String(account.tradingSid || "").trim(),
        serverId: String(account.serverId || "").trim(),
        baseUrl: String(account.baseUrl || "").trim(),
      };
      const credentials = normalizeCredentials(
        brokerType,
        account.credentials || {},
        legacyFallback
      );
      const accessToken =
        String(
          account.accessToken ||
            credentials.accessToken ||
            credentials.sessionId ||
            account.sessionToken ||
            ""
        ).trim() || null;

      return {
        ...account,
        brokerType,
        credentials,
        risk: normalizeRisk(account.risk),
        accessToken,
        refreshToken: account.refreshToken || null,
        tokenExpiresAt: account.tokenExpiresAt || null,
        brokerUserId: account.brokerUserId || null,
        brokerUserName: account.brokerUserName || null,
      };
    });
    return state;
  }

  async load() {
    const stored = this.store.read();
    if (stored && Array.isArray(stored.accounts)) {
      this.state = this.normalizeLoadedState(stored);
      return;
    }
    await this.save();
  }

  async save() {
    this.store.write(this.state);
  }

  authFlowSnapshot(accountId) {
    const flow = this.authFlows.get(accountId);
    if (!flow) {
      return {
        status: "idle",
        message: null,
        startedAt: null,
        updatedAt: null,
      };
    }
    return {
      status: flow.status,
      message: flow.message || null,
      startedAt: flow.startedAt,
      updatedAt: flow.updatedAt,
      expiresAt: flow.expiresAt,
    };
  }

  accountConfigSummary(account) {
    const brokerType = normalizeBrokerType(account.brokerType);
    const credentials = normalizeCredentials(brokerType, account.credentials, account);
    if (brokerType === BROKER_TYPES.ALICE_BLUE) {
      return {
        keyMasked: mask(credentials.aliceApiKey || ""),
        hasSecondary: Boolean(credentials.aliceUserId),
        hasRedirectUri: false,
      };
    }
    if (brokerType === BROKER_TYPES.KOTAK_NEO) {
      return {
        keyMasked: mask(credentials.consumerKey || ""),
        hasSecondary: Boolean(credentials.tradingSid),
        hasRedirectUri: Boolean(credentials.baseUrl),
      };
    }
    return {
      keyMasked: mask(credentials.clientId || ""),
      hasSecondary: Boolean(credentials.clientSecret),
      hasRedirectUri: Boolean(credentials.redirectUri),
    };
  }

  accountView(account) {
    const brokerType = normalizeBrokerType(account.brokerType);
    const config = this.accountConfigSummary(account);
    return {
      id: account.id,
      name: account.name,
      userId: account.userId,
      brokerType,
      brokerLabel: brokerLabel(brokerType),
      brokerUserId: account.brokerUserId || null,
      brokerUserName: account.brokerUserName || null,
      role: account.role,
      status: account.status,
      hasSession: Boolean(account.accessToken),
      lastLoginAt: account.lastLoginAt || null,
      clientIdMasked: config.keyMasked,
      hasClientSecret: config.hasSecondary,
      hasRedirectUri: config.hasRedirectUri,
      lastError: account.lastError || null,
      risk: normalizeRisk(account.risk),
      authFlow: this.authFlowSnapshot(account.id),
    };
  }

  listAccounts() {
    return this.state.accounts.map((account) => this.accountView(account));
  }

  getLeader() {
    return this.state.accounts.find((item) => item.role === "leader") || null;
  }

  getAccountOrThrow(id) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }
    return account;
  }

  getSystemStatus() {
    return {
      emergencyStopFollowers: this.state.emergencyStopFollowers,
      emergencyReason: this.state.emergencyReason,
      emergencyUpdatedAt: this.state.emergencyUpdatedAt,
      accounts: this.listAccounts(),
    };
  }

  getClient(account) {
    return this.brokerFactory(account);
  }

  async setEmergencyStop(payload) {
    this.state.emergencyStopFollowers = Boolean(payload.enabled);
    this.state.emergencyReason = payload.reason || null;
    this.state.emergencyUpdatedAt = nowIso();
    await this.save();

    this.writeAudit({
      type: "emergency_stop",
      enabled: this.state.emergencyStopFollowers,
      reason: this.state.emergencyReason,
    });
    return this.getSystemStatus();
  }

  async addAccount(payload) {
    const name = (payload.name || "").trim();
    const brokerType = normalizeBrokerType(payload.brokerType);
    const userId = normalizeUserId(payload.userId, `${brokerType.toUpperCase()}_USER`);
    const credentials = normalizeCredentials(
      brokerType,
      payload.credentials || {},
      payload
    );
    const accessToken = String(
      payload.accessToken ||
        credentials.accessToken ||
        credentials.sessionId ||
        ""
    ).trim();
    const role = payload.role === "leader" ? "leader" : "follower";
    const risk = normalizeRisk(payload.risk);

    if (!name) {
      throw new Error("Account name is required");
    }
    if (brokerType === BROKER_TYPES.UPSTOX && !credentials.clientId) {
      throw new Error("Upstox client ID is required");
    }
    if (
      brokerType === BROKER_TYPES.ALICE_BLUE &&
      (!credentials.aliceUserId || !credentials.aliceApiKey)
    ) {
      throw new Error("Alice Blue user ID and API key are required");
    }
    if (brokerType === BROKER_TYPES.KOTAK_NEO && !credentials.consumerKey) {
      throw new Error("Kotak Neo consumer key is required");
    }
    if (this.state.accounts.some((item) => item.userId === userId)) {
      throw new Error(`Account alias already exists: ${userId}`);
    }

    if (role === "leader") {
      this.state.accounts.forEach((item) => {
        item.role = "follower";
      });
    } else if (!this.getLeader()) {
      payload.role = "leader";
    }

    const account = {
      id: makeId("acc"),
      name,
      userId,
      brokerType,
      credentials,
      role: payload.role === "leader" || !this.getLeader() ? "leader" : "follower",
      accessToken: accessToken || null,
      refreshToken: null,
      tokenExpiresAt: null,
      brokerUserId: null,
      brokerUserName: null,
      status: "logged_out",
      lastLoginAt: null,
      lastError: null,
      risk,
      createdAt: nowIso(),
    };

    this.state.accounts.push(account);
    await this.save();

    this.writeAudit({
      type: "account_add",
      accountId: account.id,
      userId: account.userId,
      brokerType: account.brokerType,
      role: account.role,
      hasToken: Boolean(account.accessToken),
      risk: account.risk,
    });

    return this.listAccounts();
  }

  async removeAccount(id) {
    const account = this.state.accounts.find((item) => item.id === id) || null;
    const previousLength = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter((item) => item.id !== id);
    if (this.state.accounts.length === previousLength) {
      throw new Error(`Account not found: ${id}`);
    }

    await this.cancelAuthFlow(id, true);

    this.state.orderLinks = this.state.orderLinks.filter((link) => {
      if (link.leaderAccountId === id) {
        return false;
      }
      link.followers = link.followers.filter((item) => item.accountId !== id);
      return true;
    });

    if (!this.getLeader() && this.state.accounts.length > 0) {
      this.state.accounts[0].role = "leader";
    }

    await this.save();
    this.writeAudit({
      type: "account_remove",
      accountId: id,
      userId: account?.userId || null,
    });
    return this.listAccounts();
  }

  async setLeader(id) {
    const selected = this.getAccountOrThrow(id);
    this.state.accounts.forEach((item) => {
      item.role = item.id === selected.id ? "leader" : "follower";
    });
    await this.save();

    this.writeAudit({
      type: "leader_change",
      accountId: selected.id,
      userId: selected.userId,
    });
    return this.listAccounts();
  }

  async updateRisk(id, riskPatch) {
    const account = this.getAccountOrThrow(id);
    account.risk = normalizeRisk({
      ...(account.risk || {}),
      ...(riskPatch || {}),
    });
    await this.save();

    this.writeAudit({
      type: "risk_update",
      accountId: account.id,
      userId: account.userId,
      risk: account.risk,
    });

    return this.listAccounts();
  }

  async getAuthorizeUrl(id, stateValue = null) {
    const account = this.getAccountOrThrow(id);
    if (normalizeBrokerType(account.brokerType) !== BROKER_TYPES.UPSTOX) {
      throw new Error("Auth URL flow is currently available only for Upstox accounts");
    }
    const client = this.getClient(account);
    const url = client.getAuthorizeUrl(stateValue || null);
    return { url };
  }

  async getAuthFlowStatus(id) {
    this.getAccountOrThrow(id);
    return this.authFlowSnapshot(id);
  }

  async finalizeAuthFlow(accountId, status, message) {
    const flow = this.authFlows.get(accountId);
    if (!flow) {
      return;
    }
    flow.status = status;
    flow.message = message;
    flow.updatedAt = nowIso();

    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }

    if (flow.server) {
      await closeServer(flow.server);
      flow.server = null;
    }

    this.writeAudit({
      type: "auth_flow_update",
      accountId,
      status,
      message,
    });

    setTimeout(() => {
      const current = this.authFlows.get(accountId);
      if (!current) {
        return;
      }
      if (current.status === status) {
        this.authFlows.delete(accountId);
      }
    }, 120000);
  }

  async cancelAuthFlow(accountId, quiet = false) {
    const flow = this.authFlows.get(accountId);
    if (!flow) {
      return this.authFlowSnapshot(accountId);
    }

    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    if (flow.server) {
      await closeServer(flow.server);
      flow.server = null;
    }

    if (!quiet) {
      flow.status = "cancelled";
      flow.message = "Authentication flow cancelled";
      flow.updatedAt = nowIso();
      this.writeAudit({
        type: "auth_flow_cancelled",
        accountId,
      });
      setTimeout(() => {
        const current = this.authFlows.get(accountId);
        if (current && current.status === "cancelled") {
          this.authFlows.delete(accountId);
        }
      }, 120000);
      return this.authFlowSnapshot(accountId);
    }

    this.authFlows.delete(accountId);
    return this.authFlowSnapshot(accountId);
  }

  async startAuthFlow(id, options = {}) {
    const account = this.getAccountOrThrow(id);
    if (normalizeBrokerType(account.brokerType) !== BROKER_TYPES.UPSTOX) {
      throw new Error("Auto auth flow is available only for Upstox accounts");
    }
    const redirectUri = String(account.credentials?.redirectUri || "").trim();
    if (!redirectUri) {
      throw new Error("Set redirect URI before starting auto auth flow");
    }

    let redirectUrl;
    try {
      redirectUrl = new URL(redirectUri);
    } catch (_error) {
      throw new Error("Invalid redirect URI");
    }

    const host = redirectUrl.hostname.toLowerCase();
    if (redirectUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(host)) {
      throw new Error(
        "Auto callback capture requires a local redirect URI (http://localhost or http://127.0.0.1)"
      );
    }

    await this.cancelAuthFlow(id, true);

    const stateValue = makeId("oauth_state");
    const client = this.getClient(account);
    const authorizeUrl = client.getAuthorizeUrl(stateValue);
    const timeoutMs = Math.max(60000, toNumber(options.timeoutMs, 240000));

    const flow = {
      accountId: id,
      stateValue,
      status: "waiting_callback",
      message: "Waiting for Upstox callback",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      server: null,
      timer: null,
    };
    this.authFlows.set(id, flow);

    const callbackPath = redirectUrl.pathname || "/";
    const callbackHost = host;
    const callbackPort = Number(redirectUrl.port || 0);
    if (!callbackPort) {
      throw new Error("Redirect URI must include an explicit port for auto callback capture");
    }

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url, `${redirectUrl.protocol}//${redirectUrl.host}`);
        if (requestUrl.pathname !== callbackPath) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const responseError = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        const returnedState = requestUrl.searchParams.get("state");

        if (returnedState !== stateValue) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("error", "State mismatch. Please retry authentication."));
          await this.finalizeAuthFlow(id, "error", "State mismatch in callback");
          return;
        }

        if (responseError) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("error", `Upstox returned error: ${responseError}`));
          await this.finalizeAuthFlow(id, "error", `Upstox callback error: ${responseError}`);
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("error", "No authorization code found in callback."));
          await this.finalizeAuthFlow(id, "error", "No authorization code in callback");
          return;
        }

        try {
          await this.loginAccount(id, { authCode: code });
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("success", "Account logged in successfully."));
          await this.finalizeAuthFlow(id, "success", "Authentication successful");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Login failed";
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("error", message));
          await this.finalizeAuthFlow(id, "error", message);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected callback error";
        try {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(authHtml("error", message));
        } catch (_inner) {
          // ignore
        }
        await this.finalizeAuthFlow(id, "error", message);
      }
    });

    server.on("error", async (error) => {
      const message = error instanceof Error ? error.message : "Unable to start callback server";
      await this.finalizeAuthFlow(id, "error", message);
    });

    await new Promise((resolve, reject) => {
      server.listen(callbackPort, callbackHost, () => resolve());
      server.once("error", (error) => reject(error));
    }).catch(async (error) => {
      const message =
        error instanceof Error
          ? `Cannot start local callback server on ${callbackHost}:${callbackPort} - ${error.message}`
          : "Cannot start local callback server";
      await this.finalizeAuthFlow(id, "error", message);
      throw new Error(message);
    });

    const liveFlow = this.authFlows.get(id);
    if (liveFlow) {
      liveFlow.server = server;
      liveFlow.timer = setTimeout(async () => {
        await this.finalizeAuthFlow(id, "timed_out", "Authentication timed out");
      }, timeoutMs);
    }

    this.writeAudit({
      type: "auth_flow_start",
      accountId: id,
      userId: account.userId,
      redirectUri,
      stateValue,
    });

    return {
      url: authorizeUrl,
      redirectUri,
      stateValue,
      expiresAt: liveFlow?.expiresAt || null,
      status: liveFlow?.status || "waiting_callback",
    };
  }

  async loginAccount(id, payload = {}) {
    const account = this.getAccountOrThrow(id);
    const brokerType = normalizeBrokerType(account.brokerType);

    const mergedCredentials = normalizeCredentials(
      brokerType,
      {
        ...(account.credentials || {}),
        ...(payload.credentials || {}),
      },
      {
        ...(account.credentials || {}),
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        redirectUri: payload.redirectUri,
        accessToken: payload.accessToken,
        sessionId: payload.sessionId,
        tradingSid: payload.tradingSid,
        serverId: payload.serverId,
        baseUrl: payload.baseUrl,
        aliceUserId: payload.aliceUserId,
        aliceApiKey: payload.aliceApiKey,
        consumerKey: payload.consumerKey,
      }
    );
    account.credentials = mergedCredentials;

    if (payload.accessToken !== undefined) {
      account.accessToken = String(payload.accessToken || "").trim() || null;
    } else if (brokerType === BROKER_TYPES.ALICE_BLUE && mergedCredentials.sessionId) {
      account.accessToken = mergedCredentials.sessionId;
    } else if (brokerType === BROKER_TYPES.KOTAK_NEO && mergedCredentials.accessToken) {
      account.accessToken = mergedCredentials.accessToken;
    }

    const client = this.getClient(account);

    try {
      const session = await client.login(payload);
      account.accessToken = session.accessToken || account.accessToken;
      if (brokerType === BROKER_TYPES.ALICE_BLUE) {
        account.credentials = {
          ...account.credentials,
          sessionId: account.accessToken || "",
        };
      }
      if (brokerType === BROKER_TYPES.KOTAK_NEO) {
        account.credentials = {
          ...account.credentials,
          accessToken: account.accessToken || "",
        };
      }
      account.refreshToken = session.refreshToken || account.refreshToken || null;
      account.tokenExpiresAt = session.tokenExpiresAt || account.tokenExpiresAt || null;
      account.lastLoginAt = session.loginAt || nowIso();
      account.brokerUserId = session.userId || account.brokerUserId || null;
      account.brokerUserName = session.userName || account.brokerUserName || null;
      account.status = "logged_in";
      account.lastError = null;

      await this.save();
      this.writeAudit({
        type: "account_login",
        accountId: account.id,
        userId: account.userId,
        brokerUserId: account.brokerUserId,
        ok: true,
      });
      return this.listAccounts();
    } catch (error) {
      account.status = "error";
      account.lastError = error instanceof Error ? error.message : "Unknown login error";
      await this.save();

      this.writeAudit({
        type: "account_login",
        accountId: account.id,
        userId: account.userId,
        ok: false,
        error: account.lastError,
      });
      throw error;
    }
  }

  async loginAllAccounts() {
    const results = [];
    for (const account of this.state.accounts) {
      try {
        await this.loginAccount(account.id, {});
        results.push({
          accountId: account.id,
          userId: account.userId,
          ok: true,
        });
      } catch (error) {
        results.push({
          accountId: account.id,
          userId: account.userId,
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    return results;
  }

  async searchInstruments(payload) {
    const query = (payload.query || "").trim();
    if (!query) {
      return [];
    }

    const leader = this.getLeader() || this.state.accounts[0];
    if (!leader) {
      throw new Error("Add at least one account before searching instruments");
    }
    if (!leader.accessToken) {
      throw new Error("Login leader account first");
    }

    const client = this.getClient(leader);
    return client.searchInstruments({
      query,
      exchange: payload.exchange || "",
      exchanges: payload.exchanges || payload.exchange || "",
      segments: payload.segments || "",
      instrumentTypes: payload.instrumentTypes || "",
      expiry: payload.expiry || "",
      atmOffset: payload.atmOffset,
      pageNumber: 1,
      records: 20,
    });
  }

  normalizeOrderInput(payload) {
    const quantity = Math.floor(Number(payload.quantity));
    const lots = Math.max(1, Math.floor(toNumber(payload.lots, 1)));
    const lotSize = Math.max(1, Math.floor(toNumber(payload.lotSize, 1)));
    const instrumentKey = String(payload.instrumentKey || "").trim();
    const symbol = String(payload.symbol || payload.tradingSymbol || instrumentKey).trim();
    if (!symbol || !payload.side || !quantity) {
      throw new Error("symbol, side and quantity are required");
    }

    const orderType = (payload.orderType || "MARKET").toUpperCase();
    const productType = (payload.productType || "INTRADAY").toUpperCase();
    const side = payload.side.toUpperCase();

    if (!["BUY", "SELL"].includes(side)) {
      throw new Error("Side must be BUY or SELL");
    }
    if (!["MARKET", "LIMIT"].includes(orderType)) {
      throw new Error("Order type must be MARKET or LIMIT");
    }

    return {
      instrumentKey: instrumentKey || symbol,
      symbol,
      exchange: String(payload.exchange || "").toUpperCase(),
      side,
      quantity,
      lots,
      lotSize,
      orderType,
      productType,
      price: toNumber(payload.price, 0),
      stoplossSpread: toNumber(payload.stoplossSpread, 0),
      targetSpread: toNumber(payload.targetSpread, 0),
    };
  }

  resolveFollowerOrder(leaderOrder, account) {
    const risk = normalizeRisk(account.risk);
    let resolvedQty = 0;

    if (risk.quantityMode === "fixed") {
      resolvedQty = risk.fixedQuantity;
    } else {
      resolvedQty = Math.floor(leaderOrder.quantity * risk.qtyMultiplier);
    }

    if (resolvedQty < 1) {
      return {
        ok: false,
        reason:
          risk.quantityMode === "fixed"
            ? "Fixed quantity must be at least 1"
            : `Qty multiplier (${risk.qtyMultiplier}) makes qty below 1`,
      };
    }

    return {
      ok: true,
      order: {
        ...leaderOrder,
        quantity: resolvedQty,
      },
    };
  }

  estimateOrderMargin(order, risk) {
    const unitPrice =
      order.orderType === "LIMIT" && order.price > 0
        ? order.price
        : risk.marketPriceFallback;
    const factor = order.productType === "DELIVERY" ? 1 : 0.35;
    return Number((unitPrice * order.quantity * factor).toFixed(2));
  }

  async runRiskChecks(account, order) {
    const risk = normalizeRisk(account.risk);
    if (risk.maxOrderQty > 0 && order.quantity > risk.maxOrderQty) {
      return {
        ok: false,
        reason: `Qty ${order.quantity} exceeds max order qty ${risk.maxOrderQty}`,
      };
    }

    if (risk.maxDailyLoss > 0) {
      const pnl = await this.getClient(account).getPnl();
      const mtm = toNumber(pnl?.mtm, 0);
      if (mtm <= -risk.maxDailyLoss) {
        return {
          ok: false,
          reason: `Daily loss guard hit (PnL ${mtm}, limit -${risk.maxDailyLoss})`,
        };
      }
    }

    if (risk.marginGuardEnabled) {
      const funds = await this.getClient(account).getFunds();
      const available = toNumber(funds?.available, 0);
      const estimatedMargin = this.estimateOrderMargin(order, risk);
      if (risk.minAvailableFunds > 0 && available < risk.minAvailableFunds) {
        return {
          ok: false,
          reason: `Available funds ${available} below minimum ${risk.minAvailableFunds}`,
        };
      }
      if (available < estimatedMargin) {
        return {
          ok: false,
          reason: `Estimated margin ${estimatedMargin} exceeds available ${available}`,
        };
      }
    }

    return { ok: true };
  }

  async placeLeaderOrder(payload) {
    const order = this.normalizeOrderInput(payload);
    const leader = this.getLeader();
    if (!leader) {
      throw new Error("No leader account configured");
    }
    if (!leader.accessToken) {
      throw new Error("Leader account is not logged in");
    }

    const leaderRisk = await this.runRiskChecks(leader, order);
    if (!leaderRisk.ok) {
      this.writeAudit({
        type: "risk_block",
        accountId: leader.id,
        userId: leader.userId,
        reason: leaderRisk.reason,
        order,
      });
      throw new Error(`Leader risk block: ${leaderRisk.reason}`);
    }

    const leaderClient = this.getClient(leader);
    const leaderExecution = await leaderClient.placeOrder(order);

    const link = {
      id: makeId("link"),
      leaderAccountId: leader.id,
      leaderOrderId: leaderExecution.orderId,
      leaderUserId: leader.userId,
      leaderEntryOrder: order,
      leaderEntryExecution: leaderExecution,
      order,
      followers: [],
      createdAt: nowIso(),
      exitedAt: null,
    };

    const followers = this.state.accounts.filter((item) => item.id !== leader.id);
    if (this.state.emergencyStopFollowers) {
      for (const follower of followers) {
        link.followers.push({
          accountId: follower.id,
          userId: follower.userId,
          ok: false,
          reason: this.state.emergencyReason || "Emergency stop enabled",
          orderId: null,
          placedOrder: null,
        });
      }
      this.writeAudit({
        type: "copy_skipped_emergency_stop",
        leaderOrderId: link.leaderOrderId,
      });
    } else {
      const followerTasks = followers.map(async (follower) => {
        if (!follower.accessToken) {
          return {
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: "Follower not logged in",
            orderId: null,
            placedOrder: null,
          };
        }

        const resolved = this.resolveFollowerOrder(order, follower);
        if (!resolved.ok) {
          this.writeAudit({
            type: "risk_block",
            accountId: follower.id,
            userId: follower.userId,
            reason: resolved.reason,
            order,
          });
          return {
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: resolved.reason,
            orderId: null,
            placedOrder: null,
          };
        }

        const riskCheck = await this.runRiskChecks(follower, resolved.order);
        if (!riskCheck.ok) {
          this.writeAudit({
            type: "risk_block",
            accountId: follower.id,
            userId: follower.userId,
            reason: riskCheck.reason,
            order: resolved.order,
          });
          return {
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: riskCheck.reason,
            orderId: null,
            placedOrder: resolved.order,
          };
        }

        const client = this.getClient(follower);
        try {
          const execution = await client.placeOrder(resolved.order);
          return {
            accountId: follower.id,
            userId: follower.userId,
            ok: true,
            orderId: execution.orderId,
            placedOrder: resolved.order,
          };
        } catch (error) {
          return {
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: error instanceof Error ? error.message : "Unknown error",
            orderId: null,
            placedOrder: resolved.order,
          };
        }
      });

      const settled = await Promise.allSettled(followerTasks);
      link.followers = settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        const follower = followers[index];
        return {
          accountId: follower.id,
          userId: follower.userId,
          ok: false,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : "Unexpected follower execution error",
          orderId: null,
          placedOrder: null,
        };
      });
    }

    this.state.orderLinks.unshift(link);
    await this.save();

    this.writeAudit({
      type: "leader_order",
      leaderAccountId: leader.id,
      leaderUserId: leader.userId,
      leaderOrderId: link.leaderOrderId,
      symbol: order.symbol,
      instrumentKey: order.instrumentKey,
      side: order.side,
      quantity: order.quantity,
      followers: link.followers.map((item) => ({
        accountId: item.accountId,
        userId: item.userId,
        ok: item.ok,
        reason: item.reason || null,
        quantity: item.placedOrder?.quantity || null,
      })),
    });

    return link;
  }

  listOpenLeaderOrders() {
    return this.state.orderLinks
      .filter((item) => !item.exitedAt)
      .map((item) => ({
        leaderOrderId: item.leaderOrderId,
        leaderUserId: item.leaderUserId,
        symbol: item.order.symbol,
        instrumentKey: item.order.instrumentKey,
        side: item.order.side,
        quantity: item.order.quantity,
        lots: item.order.lots || null,
        lotSize: item.order.lotSize || null,
        createdAt: item.createdAt,
        followerStatus: item.followers,
      }));
  }

  async exitLeaderOrder(leaderOrderId) {
    const link = this.state.orderLinks.find(
      (item) => item.leaderOrderId === leaderOrderId && !item.exitedAt
    );
    if (!link) {
      throw new Error(`Open leader order not found: ${leaderOrderId}`);
    }

    const leader = this.getAccountOrThrow(link.leaderAccountId);
    const leaderClient = this.getClient(leader);
    await leaderClient.exitByReference({
      orderId: link.leaderOrderId,
      order: link.leaderEntryOrder,
    });

    const followerExitTasks = link.followers.map(async (followerOrder) => {
      if (!followerOrder.ok || !followerOrder.orderId) {
        return {
          accountId: followerOrder.accountId,
          userId: followerOrder.userId,
          ok: false,
          reason: followerOrder.reason || "No entry order for follower",
        };
      }

      const follower = this.getAccountOrThrow(followerOrder.accountId);
      const client = this.getClient(follower);
      try {
        await client.exitByReference({
          orderId: followerOrder.orderId,
          order: followerOrder.placedOrder || link.order,
        });
        return {
          accountId: follower.id,
          userId: follower.userId,
          ok: true,
        };
      } catch (error) {
        return {
          accountId: follower.id,
          userId: follower.userId,
          ok: false,
          reason: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    const followerSettled = await Promise.allSettled(followerExitTasks);
    const followerResults = followerSettled.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      const fallback = link.followers[index];
      return {
        accountId: fallback.accountId,
        userId: fallback.userId,
        ok: false,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : "Unexpected follower exit error",
      };
    });

    link.exitedAt = nowIso();
    link.exitResults = followerResults;
    await this.save();

    this.writeAudit({
      type: "leader_exit",
      leaderOrderId,
      exitedAt: link.exitedAt,
      followerResults,
    });

    return {
      leaderOrderId,
      exitedAt: link.exitedAt,
      followerResults,
    };
  }

  async getDashboard() {
    const rows = [];
    for (const account of this.state.accounts) {
      const row = {
        accountId: account.id,
        name: account.name,
        userId: account.userId,
        brokerUserId: account.brokerUserId || null,
        role: account.role,
        status: account.status,
        funds: null,
        pnl: null,
        positions: [],
        lastError: account.lastError || null,
        risk: normalizeRisk(account.risk),
      };

      if (!account.accessToken) {
        rows.push(row);
        continue;
      }

      const client = this.getClient(account);
      try {
        const [funds, pnl] = await Promise.all([client.getFunds(), client.getPnl()]);
        row.funds = funds;
        row.pnl = pnl.mtm;
        row.positions = pnl.positions;
      } catch (error) {
        row.status = "error";
        row.lastError = error instanceof Error ? error.message : "Dashboard call failed";
      }

      rows.push(row);
    }

    return {
      generatedAt: nowIso(),
      emergencyStopFollowers: this.state.emergencyStopFollowers,
      emergencyReason: this.state.emergencyReason,
      emergencyUpdatedAt: this.state.emergencyUpdatedAt,
      accounts: rows,
      openLeaders: this.listOpenLeaderOrders(),
    };
  }
}

module.exports = {
  TradeEngine,
  normalizeRisk,
  defaultRisk,
};
