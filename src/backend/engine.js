const crypto = require("crypto");

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function mask(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultRisk() {
  return {
    qtyMultiplier: 1,
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
  return {
    qtyMultiplier: Math.max(0, toNumber(merged.qtyMultiplier, 1)),
    maxOrderQty: Math.max(0, Math.floor(toNumber(merged.maxOrderQty, 0))),
    maxDailyLoss: Math.max(0, toNumber(merged.maxDailyLoss, 0)),
    marginGuardEnabled: Boolean(merged.marginGuardEnabled),
    minAvailableFunds: Math.max(0, toNumber(merged.minAvailableFunds, 0)),
    marketPriceFallback: Math.max(1, toNumber(merged.marketPriceFallback, 100)),
  };
}

class TradeEngine {
  constructor({ store, brokerFactory, auditLogger = null }) {
    this.store = store;
    this.brokerFactory = brokerFactory;
    this.auditLogger = auditLogger;
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

  normalizeLoadedState(stored) {
    const state = {
      accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
      orderLinks: Array.isArray(stored.orderLinks) ? stored.orderLinks : [],
      emergencyStopFollowers: Boolean(stored.emergencyStopFollowers),
      emergencyReason: stored.emergencyReason || null,
      emergencyUpdatedAt: stored.emergencyUpdatedAt || null,
    };

    state.accounts = state.accounts.map((account) => ({
      ...account,
      risk: normalizeRisk(account.risk),
    }));
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

  accountView(account) {
    return {
      id: account.id,
      name: account.name,
      userId: account.userId,
      role: account.role,
      status: account.status,
      hasSession: Boolean(account.sessionToken),
      lastLoginAt: account.lastLoginAt || null,
      apiKeyMasked: mask(account.apiKey),
      lastError: account.lastError || null,
      risk: normalizeRisk(account.risk),
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

  async setEmergencyStop(payload) {
    this.state.emergencyStopFollowers = Boolean(payload.enabled);
    this.state.emergencyReason = payload.reason || null;
    this.state.emergencyUpdatedAt = new Date().toISOString();
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
    const userId = (payload.userId || "").trim().toUpperCase();
    const apiKey = (payload.apiKey || "").trim();
    const role = payload.role === "leader" ? "leader" : "follower";
    const risk = normalizeRisk(payload.risk);

    if (!name || !userId || !apiKey) {
      throw new Error("Name, User ID and API key are required");
    }

    if (this.state.accounts.some((item) => item.userId === userId)) {
      throw new Error(`User ID already exists: ${userId}`);
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
      apiKey,
      role: payload.role === "leader" || !this.getLeader() ? "leader" : "follower",
      status: "logged_out",
      sessionToken: null,
      lastLoginAt: null,
      lastError: null,
      risk,
      createdAt: new Date().toISOString(),
    };

    this.state.accounts.push(account);
    await this.save();

    this.writeAudit({
      type: "account_add",
      accountId: account.id,
      userId: account.userId,
      role: account.role,
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

  getClient(account) {
    return this.brokerFactory(account);
  }

  async loginAccount(id) {
    const account = this.getAccountOrThrow(id);
    const client = this.getClient(account);

    try {
      const session = await client.login({
        userId: account.userId,
        apiKey: account.apiKey,
      });
      account.sessionToken = session.sessionToken;
      account.lastLoginAt = session.loginAt || new Date().toISOString();
      account.status = "logged_in";
      account.lastError = null;
      await this.save();

      this.writeAudit({
        type: "account_login",
        accountId: account.id,
        userId: account.userId,
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
        await this.loginAccount(account.id);
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
    if (!leader.sessionToken) {
      throw new Error("Login leader account first");
    }

    const client = this.getClient(leader);
    return client.searchInstruments({
      query,
      exchange: payload.exchange || "",
    });
  }

  normalizeOrderInput(payload) {
    const quantity = Math.floor(Number(payload.quantity));
    if (!payload.symbol || !payload.exchange || !payload.side || !quantity) {
      throw new Error("Exchange, symbol, side and quantity are required");
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
      exchange: payload.exchange.toUpperCase(),
      symbol: payload.symbol.toUpperCase(),
      side,
      quantity,
      orderType,
      productType,
      price: toNumber(payload.price, 0),
      stoplossSpread: toNumber(payload.stoplossSpread, 0),
      targetSpread: toNumber(payload.targetSpread, 0),
    };
  }

  resolveFollowerOrder(leaderOrder, account) {
    const risk = normalizeRisk(account.risk);
    const scaledQty = Math.floor(leaderOrder.quantity * risk.qtyMultiplier);
    if (scaledQty < 1) {
      return {
        ok: false,
        reason: `Qty multiplier (${risk.qtyMultiplier}) makes qty below 1`,
      };
    }
    return {
      ok: true,
      order: {
        ...leaderOrder,
        quantity: scaledQty,
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
    if (!leader.sessionToken) {
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
      createdAt: new Date().toISOString(),
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
      for (const follower of followers) {
        if (!follower.sessionToken) {
          link.followers.push({
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: "Follower not logged in",
            orderId: null,
            placedOrder: null,
          });
          continue;
        }

        const resolved = this.resolveFollowerOrder(order, follower);
        if (!resolved.ok) {
          link.followers.push({
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: resolved.reason,
            orderId: null,
            placedOrder: null,
          });
          this.writeAudit({
            type: "risk_block",
            accountId: follower.id,
            userId: follower.userId,
            reason: resolved.reason,
            order,
          });
          continue;
        }

        const riskCheck = await this.runRiskChecks(follower, resolved.order);
        if (!riskCheck.ok) {
          link.followers.push({
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: riskCheck.reason,
            orderId: null,
            placedOrder: resolved.order,
          });
          this.writeAudit({
            type: "risk_block",
            accountId: follower.id,
            userId: follower.userId,
            reason: riskCheck.reason,
            order: resolved.order,
          });
          continue;
        }

        const client = this.getClient(follower);
        try {
          const execution = await client.placeOrder(resolved.order);
          link.followers.push({
            accountId: follower.id,
            userId: follower.userId,
            ok: true,
            orderId: execution.orderId,
            placedOrder: resolved.order,
          });
        } catch (error) {
          link.followers.push({
            accountId: follower.id,
            userId: follower.userId,
            ok: false,
            reason: error instanceof Error ? error.message : "Unknown error",
            orderId: null,
            placedOrder: resolved.order,
          });
        }
      }
    }

    this.state.orderLinks.unshift(link);
    await this.save();

    this.writeAudit({
      type: "leader_order",
      leaderAccountId: leader.id,
      leaderUserId: leader.userId,
      leaderOrderId: link.leaderOrderId,
      symbol: order.symbol,
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
        side: item.order.side,
        quantity: item.order.quantity,
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

    const followerResults = [];
    for (const followerOrder of link.followers) {
      if (!followerOrder.ok || !followerOrder.orderId) {
        followerResults.push({
          accountId: followerOrder.accountId,
          ok: false,
          reason: followerOrder.reason || "No entry order for follower",
        });
        continue;
      }

      const follower = this.getAccountOrThrow(followerOrder.accountId);
      const client = this.getClient(follower);
      try {
        await client.exitByReference({
          orderId: followerOrder.orderId,
          order: followerOrder.placedOrder || link.order,
        });
        followerResults.push({
          accountId: follower.id,
          userId: follower.userId,
          ok: true,
        });
      } catch (error) {
        followerResults.push({
          accountId: follower.id,
          userId: follower.userId,
          ok: false,
          reason: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    link.exitedAt = new Date().toISOString();
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
        role: account.role,
        status: account.status,
        funds: null,
        pnl: null,
        positions: [],
        lastError: account.lastError || null,
        risk: normalizeRisk(account.risk),
      };

      if (!account.sessionToken) {
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
      generatedAt: new Date().toISOString(),
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
