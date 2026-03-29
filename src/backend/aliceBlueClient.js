const crypto = require("crypto");

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitCsv(input) {
  return String(input || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrderType(orderType) {
  const value = String(orderType || "").toUpperCase();
  return value === "LIMIT" || value === "L" ? "L" : "MKT";
}

function normalizeProduct(productType, exchange) {
  const value = String(productType || "").toUpperCase();
  if (value === "DELIVERY") {
    return "CNC";
  }
  if (value === "MTF") {
    return "NRML";
  }
  if (String(exchange || "").toUpperCase() === "NFO" && value === "CNC") {
    return "NRML";
  }
  return "MIS";
}

function inferType(item) {
  const optionType = String(item.optionType || item.option_type || "").toUpperCase();
  if (optionType) {
    return optionType;
  }
  const text = `${item.formattedInsName || ""} ${item.symbol || ""}`.toUpperCase();
  if (text.includes(" CE")) {
    return "CE";
  }
  if (text.includes(" PE")) {
    return "PE";
  }
  if (text.includes(" FUT")) {
    return "FUT";
  }
  return "EQ";
}

class RealAliceBlueClient {
  constructor(account) {
    this.account = account;
    this.apiBase =
      process.env.ALICE_BLUE_API_BASE ||
      "https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/";
    this.userAgent = "CopyTrader Electron";
    this.instrumentCache = new Map();
  }

  get credentials() {
    return this.account.credentials || {};
  }

  getApiUserId() {
    const fromCreds = String(this.credentials.aliceUserId || "").trim();
    const fromAccount = String(this.account.brokerUserId || "").trim();
    return (fromCreds || fromAccount || this.account.userId || "").toUpperCase();
  }

  getSessionId() {
    return (
      String(this.account.accessToken || "").trim() ||
      String(this.credentials.sessionId || "").trim() ||
      null
    );
  }

  authHeaderOrThrow() {
    const userId = this.getApiUserId();
    const sessionId = this.getSessionId();
    if (!userId || !sessionId) {
      throw new Error("Alice Blue login/session required");
    }
    return `Bearer ${userId} ${sessionId}`;
  }

  getSearchUrl() {
    const trimmed = this.apiBase.replace(/\/+$/, "");
    return `${trimmed.replace(
      /\/AliceBlueAPIService\/api$/,
      ""
    )}/DataApiService/v2/exchange/getScripForSearchAPI`;
  }

  async request(method, url, { body, authenticated = true } = {}) {
    const headers = {
      "X-SAS-Version": "2.0",
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authenticated) {
      headers.Authorization = this.authHeaderOrThrow();
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }

    if (!response.ok) {
      const detail =
        json?.message ||
        json?.emsg ||
        json?.error ||
        text ||
        response.statusText ||
        "Unknown error";
      throw new Error(`Alice Blue API ${response.status}: ${detail}`);
    }

    if (json?.stat && String(json.stat).toLowerCase() !== "ok") {
      const detail = json?.emsg || json?.message || "Alice Blue request failed";
      throw new Error(detail);
    }
    return json;
  }

  async generateSessionId() {
    const userId = this.getApiUserId();
    const apiKey = String(this.credentials.aliceApiKey || "").trim();
    if (!userId || !apiKey) {
      throw new Error("Alice Blue user ID and API key are required");
    }

    const enc = await this.request("POST", `${this.apiBase}customer/getAPIEncpkey`, {
      body: { userId },
      authenticated: false,
    });
    const encKey = String(enc?.encKey || "").trim();
    if (!encKey) {
      throw new Error("Unable to get Alice Blue encryption key");
    }

    const hashed = crypto
      .createHash("sha256")
      .update(`${userId}${apiKey}${encKey}`)
      .digest("hex");
    const sid = await this.request("POST", `${this.apiBase}customer/getUserSID`, {
      body: { userId, userData: hashed },
      authenticated: false,
    });
    const sessionId = String(sid?.sessionID || sid?.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Alice Blue session generation failed");
    }
    return sessionId;
  }

  async getProfile() {
    return this.request("GET", `${this.apiBase}customer/accountDetails`);
  }

  async login(options = {}) {
    const accessTokenHint =
      String(options.accessToken || options.sessionId || options.authCode || "").trim() || null;

    if (options.aliceUserId !== undefined) {
      this.account.credentials = {
        ...this.credentials,
        aliceUserId: String(options.aliceUserId || "").trim(),
      };
    }
    if (options.aliceApiKey !== undefined) {
      this.account.credentials = {
        ...this.credentials,
        aliceApiKey: String(options.aliceApiKey || "").trim(),
      };
    }

    if (accessTokenHint) {
      this.account.accessToken = accessTokenHint;
      this.account.credentials = {
        ...this.credentials,
        sessionId: accessTokenHint,
      };
    }

    if (!this.getSessionId()) {
      const sessionId = await this.generateSessionId();
      this.account.accessToken = sessionId;
      this.account.credentials = {
        ...this.credentials,
        sessionId,
      };
    }

    const profile = await this.getProfile();
    const brokerUserId =
      String(profile?.actid || profile?.accountId || profile?.uid || "").trim() ||
      this.getApiUserId();
    const brokerUserName =
      String(profile?.accountName || profile?.name || profile?.uname || "").trim() ||
      this.account.name;

    return {
      accessToken: this.getSessionId(),
      refreshToken: null,
      tokenExpiresAt: null,
      loginAt: new Date().toISOString(),
      userId: brokerUserId || this.account.userId,
      userName: brokerUserName || this.account.name,
      profile,
    };
  }

  normalizeInstrument(item) {
    const exchange = String(item.exch || item.exchange || "").toUpperCase();
    const token = String(item.token || item.symbolToken || item.instrumentToken || "").trim();
    const tradingSymbol = String(
      item.formattedInsName || item.tradingSymbol || item.symbol || token
    ).trim();
    const symbol = String(item.symbol || tradingSymbol || token).trim();
    const lotSize = Math.max(1, Math.floor(toNumber(item.lotSize, toNumber(item.lot_size, 1))));
    return {
      exchange,
      segment: exchange,
      symbol,
      tradingSymbol,
      instrumentKey: `${exchange}|${token}`,
      token,
      type: inferType(item),
      lotSize,
      expiry: item.expiry || null,
      strikePrice: toNumber(item.strikePrice, 0) || null,
      underlyingSymbol: item.underlyingSymbol || null,
      raw: item,
    };
  }

  cacheInstrument(instrument) {
    if (!instrument.instrumentKey) {
      return;
    }
    this.instrumentCache.set(instrument.instrumentKey, instrument);
    this.instrumentCache.set(
      `${instrument.exchange}:${instrument.tradingSymbol}`.toUpperCase(),
      instrument
    );
    this.instrumentCache.set(`${instrument.exchange}:${instrument.symbol}`.toUpperCase(), instrument);
    this.instrumentCache.set(instrument.tradingSymbol.toUpperCase(), instrument);
    this.instrumentCache.set(instrument.symbol.toUpperCase(), instrument);
  }

  async searchInstruments(payload = {}) {
    const query = String(payload.query || "").trim();
    if (!query) {
      return [];
    }

    const requestedExchanges = splitCsv(payload.exchanges || payload.exchange);
    const exchanges =
      requestedExchanges.length > 0 ? requestedExchanges.map((item) => item.toUpperCase()) : ["NSE", "NFO"];

    const rows = [];
    for (const exchange of exchanges) {
      try {
        const response = await this.request("POST", this.getSearchUrl(), {
          body: {
            symbol: query,
            exchange: [exchange],
          },
        });
        if (Array.isArray(response)) {
          rows.push(...response);
        }
      } catch (_error) {
        // continue other exchanges
      }
    }

    const mapped = rows.map((item) => this.normalizeInstrument(item));
    const dedup = new Map();
    mapped.forEach((item) => {
      dedup.set(item.instrumentKey, item);
      this.cacheInstrument(item);
    });

    const typeFilter = splitCsv(payload.instrumentTypes).map((item) => item.toUpperCase());
    const segmentFilter = splitCsv(payload.segments).map((item) => item.toUpperCase());
    const expiryFilter = String(payload.expiry || "").trim().toUpperCase();

    return [...dedup.values()]
      .filter((item) => {
        if (typeFilter.length > 0 && !typeFilter.includes(item.type.toUpperCase())) {
          return false;
        }
        if (segmentFilter.length > 0 && !segmentFilter.some((seg) => item.segment.includes(seg))) {
          return false;
        }
        if (expiryFilter && !String(item.expiry || "").toUpperCase().includes(expiryFilter)) {
          return false;
        }
        return true;
      })
      .slice(0, 80);
  }

  async resolveInstrument(order) {
    const byKey = this.instrumentCache.get(String(order.instrumentKey || "").trim());
    if (byKey) {
      return byKey;
    }
    const symbol = String(order.symbol || "").trim();
    if (!symbol) {
      return null;
    }

    const cacheHit =
      this.instrumentCache.get(symbol.toUpperCase()) ||
      this.instrumentCache.get(
        `${String(order.exchange || "").toUpperCase()}:${symbol}`.toUpperCase()
      );
    if (cacheHit) {
      return cacheHit;
    }

    const results = await this.searchInstruments({
      query: symbol,
      exchange: order.exchange || "",
    });
    const exact = results.find((item) => item.tradingSymbol.toUpperCase() === symbol.toUpperCase());
    return exact || results[0] || null;
  }

  async placeOrder(order) {
    const resolved = await this.resolveInstrument(order);
    if (!resolved) {
      throw new Error(`Alice Blue instrument not found for ${order.symbol || order.instrumentKey}`);
    }

    const prctyp = normalizeOrderType(order.orderType);
    const payload = {
      complexty: "regular",
      discqty: 0,
      exch: resolved.exchange,
      pCode: normalizeProduct(order.productType, resolved.exchange),
      price: prctyp === "L" ? toNumber(order.price, 0) : 0,
      prctyp,
      qty: Math.max(1, Math.floor(toNumber(order.quantity, 0))),
      ret: "DAY",
      symbol_id: resolved.token,
      trading_symbol: resolved.tradingSymbol,
      transtype: String(order.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY",
      trigPrice: toNumber(order.triggerPrice, 0),
    };

    const response = await this.request("POST", `${this.apiBase}placeOrder/executePlaceOrder`, {
      body: payload,
    });
    const first = Array.isArray(response) ? response[0] : response;
    const orderId = String(
      first?.NOrdNo || first?.nOrdNo || first?.nestOrderNumber || first?.order_id || ""
    ).trim();
    if (!orderId) {
      throw new Error("Alice Blue place order succeeded but order id is missing");
    }

    return {
      orderId,
      status: String(first?.stat || "Ok"),
      averagePrice: toNumber(payload.price, 0),
      timestamp: new Date().toISOString(),
      raw: response,
    };
  }

  async cancelOrder(orderId) {
    return this.request("POST", `${this.apiBase}placeOrder/cancelOrder`, {
      body: { nestOrderNumber: String(orderId) },
    });
  }

  async exitByReference(reference) {
    if (reference?.order) {
      const reverseSide = reference.order.side === "BUY" ? "SELL" : "BUY";
      return this.placeOrder({
        ...reference.order,
        side: reverseSide,
        orderType: "MARKET",
        price: 0,
      });
    }
    if (!reference?.orderId) {
      throw new Error("exitByReference requires order or orderId");
    }
    await this.cancelOrder(reference.orderId);
    return {
      orderId: String(reference.orderId),
      status: "cancelled",
      averagePrice: 0,
      timestamp: new Date().toISOString(),
    };
  }

  async getFunds() {
    const response = await this.request("GET", `${this.apiBase}limits/getRmsLimits`);
    const rows = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];

    let total = 0;
    let available = 0;
    let utilized = 0;
    rows.forEach((row) => {
      total += toNumber(row.net, 0);
      available += toNumber(row.cashmarginavailable, 0) || toNumber(row.rmsPayInAmnt, 0);
      utilized +=
        toNumber(row.varmargin, 0) +
        toNumber(row.spanmargin, 0) +
        toNumber(row.exposuremargin, 0);
    });

    if (total <= 0 && available > 0) {
      total = available + utilized;
    }
    return {
      total: Number(total.toFixed(2)),
      available: Number(available.toFixed(2)),
      utilized: Number(utilized.toFixed(2)),
      raw: response,
    };
  }

  async getPnl() {
    const response = await this.request("POST", `${this.apiBase}positionAndHoldings/positionBook`, {
      body: { ret: "NET" },
    });
    const rows = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
    let mtm = 0;
    const positions = [];

    rows.forEach((row) => {
      const netQty = Math.trunc(toNumber(row.Netqty, toNumber(row.netQty, 0)));
      if (!netQty) {
        return;
      }
      const symbol = String(row.Tsym || row.trading_symbol || row.symbol || "").trim();
      const avgPrice = toNumber(row.Buyavgprc, toNumber(row.averagePrice, 0));
      const ltp = toNumber(row.LTP, toNumber(row.ltp, avgPrice));
      const rowPnl = toNumber(row.MtoM, (ltp - avgPrice) * netQty);
      mtm += rowPnl;
      positions.push({
        symbol,
        netQty,
        avgPrice: Number(avgPrice.toFixed(2)),
        ltp: Number(ltp.toFixed(2)),
        pnl: Number(rowPnl.toFixed(2)),
      });
    });

    return {
      mtm: Number(mtm.toFixed(2)),
      positions,
      raw: response,
    };
  }
}

module.exports = {
  RealAliceBlueClient,
};
