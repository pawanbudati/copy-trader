const { logApiCall, headersToObject } = require("./apiCallLogger");

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTokenResponse(payload) {
  const expiresIn = toNumber(payload?.expires_in, 0);
  const tokenIssuedAt = new Date();
  const tokenExpiresAt =
    expiresIn > 0 ? new Date(tokenIssuedAt.getTime() + expiresIn * 1000).toISOString() : null;
  return {
    accessToken: payload?.access_token || null,
    refreshToken: payload?.refresh_token || null,
    tokenType: payload?.token_type || "Bearer",
    expiresIn,
    tokenExpiresAt,
  };
}

function parseAuthCode(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value);
      return url.searchParams.get("code") || "";
    } catch (_error) {
      return "";
    }
  }

  if (value.includes("code=")) {
    try {
      const url = new URL(value.startsWith("?") ? `https://dummy.local/${value}` : `https://dummy.local/?${value}`);
      return url.searchParams.get("code") || "";
    } catch (_error) {
      return "";
    }
  }

  return value;
}

function inferInstrumentType(value) {
  const type = String(value || "").toUpperCase();
  if (!type) {
    return "INSTRUMENT";
  }
  return type;
}

function normalizeOhlcValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const open = toNumber(value.open ?? value.o ?? value.Open ?? value.OPEN, Number.NaN);
  const high = toNumber(value.high ?? value.h ?? value.High ?? value.HIGH, Number.NaN);
  const low = toNumber(value.low ?? value.l ?? value.Low ?? value.LOW, Number.NaN);
  const close = toNumber(
    value.close ?? value.c ?? value.Close ?? value.CLOSE ?? value.prev_close ?? value.previous_close,
    Number.NaN
  );
  if (![open, high, low, close].every((item) => Number.isFinite(item))) {
    return null;
  }
  return {
    open: Number(open.toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    close: Number(close.toFixed(2)),
  };
}

class RealUpstoxClient {
  constructor(account) {
    this.account = account;
    this.apiBase = process.env.UPSTOX_API_BASE || "https://api.upstox.com";
    this.orderBase = process.env.UPSTOX_ORDER_BASE || "https://api-hft.upstox.com";
    this.instrumentCache = new Map();
  }

  get credentials() {
    return this.account.credentials || {};
  }

  getAuthorizeUrl(stateValue = null) {
    const clientId = String(this.credentials.clientId || this.account.clientId || "").trim();
    const redirectUri = String(this.credentials.redirectUri || this.account.redirectUri || "").trim();
    if (!clientId || !redirectUri) {
      throw new Error("clientId and redirectUri are required to build Upstox authorize URL");
    }

    const state = stateValue || `copy-${this.account.id}-${Date.now()}`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `${this.apiBase}/v2/login/authorization/dialog?${params.toString()}`;
  }

  async request(method, url, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    let body = undefined;
    let requestBody = null;
    if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
      requestBody = options.form;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
      requestBody = options.body;
    }
    const startedAt = Date.now();
    let response;
    let text = "";

    try {
      response = await fetch(url, {
        method,
        headers,
        body,
      });
      text = await response.text();
    } catch (error) {
      logApiCall({
        source: "broker-api",
        broker: "upstox",
        accountId: this.account?.id || null,
        durationMs: Date.now() - startedAt,
        request: {
          method,
          url,
          headers,
          body: requestBody,
        },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }

    logApiCall({
      source: "broker-api",
      broker: "upstox",
      accountId: this.account?.id || null,
      durationMs: Date.now() - startedAt,
      request: {
        method,
        url,
        headers,
        body: requestBody,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: headersToObject(response.headers),
        body: text,
        json,
      },
    });

    if (!response.ok) {
      const detail =
        json?.errors?.[0]?.message ||
        json?.message ||
        text ||
        response.statusText ||
        "Unknown error";
      throw new Error(`Upstox API ${response.status}: ${detail}`);
    }

    if (json && typeof json === "object" && json.status && json.status !== "success") {
      const detail = json?.errors?.[0]?.message || json?.message || "Upstox API non-success response";
      throw new Error(detail);
    }

    return json;
  }

  async validateToken(accessToken) {
    const payload = await this.request("GET", `${this.apiBase}/v2/user/profile`, {
      token: accessToken,
    });
    return payload?.data || {};
  }

  async exchangeAuthCodeForToken(code) {
    const clientId = String(this.credentials.clientId || this.account.clientId || "").trim();
    const clientSecret = String(
      this.credentials.clientSecret || this.account.clientSecret || ""
    ).trim();
    const redirectUri = String(this.credentials.redirectUri || this.account.redirectUri || "").trim();
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("clientId, clientSecret and redirectUri are required for auth code login");
    }

    const payload = await this.request("POST", `${this.apiBase}/v2/login/authorization/token`, {
      form: {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      },
    });
    return normalizeTokenResponse(payload);
  }

  async login(options = {}) {
    const accessTokenHint = String(options.accessToken || "").trim();
    const authInput = options.authCode || options.redirectedUrl || options.code || "";
    const authCode = parseAuthCode(authInput);

    if (accessTokenHint) {
      const profile = await this.validateToken(accessTokenHint);
      return {
        accessToken: accessTokenHint,
        refreshToken: this.account.refreshToken || null,
        tokenExpiresAt: this.account.tokenExpiresAt || null,
        loginAt: new Date().toISOString(),
        userId: profile.user_id || this.account.userId || "",
        userName: profile.user_name || this.account.name || "",
        profile,
      };
    }

    if (authCode) {
      const tokenData = await this.exchangeAuthCodeForToken(authCode);
      if (!tokenData.accessToken) {
        throw new Error("Upstox token response did not include access_token");
      }
      const profile = await this.validateToken(tokenData.accessToken);
      return {
        ...tokenData,
        loginAt: new Date().toISOString(),
        userId: profile.user_id || this.account.userId || "",
        userName: profile.user_name || this.account.name || "",
        profile,
      };
    }

    const storedAccessToken = String(this.account.accessToken || "").trim();
    if (storedAccessToken) {
      const profile = await this.validateToken(storedAccessToken);
      return {
        accessToken: storedAccessToken,
        refreshToken: this.account.refreshToken || null,
        tokenExpiresAt: this.account.tokenExpiresAt || null,
        loginAt: new Date().toISOString(),
        userId: profile.user_id || this.account.userId || "",
        userName: profile.user_name || this.account.name || "",
        profile,
      };
    }

    throw new Error("No auth code/access token found. Generate auth URL and login once per account.");
  }

  normalizeInstrument(item) {
    const instrumentKey = String(item.instrument_key || item.instrument_token || "");
    const exchange = String(item.exchange || "").toUpperCase();
    const segment = String(item.segment || "").toUpperCase();
    const tradingSymbol = String(item.trading_symbol || item.short_name || item.name || "");
    const symbol = tradingSymbol || String(item.name || instrumentKey);
    return {
      exchange,
      segment,
      symbol,
      tradingSymbol,
      instrumentKey,
      token: instrumentKey,
      type: inferInstrumentType(item.instrument_type || item.security_type),
      lotSize: toNumber(item.lot_size, 0) || null,
      expiry: item.expiry || null,
      strikePrice: toNumber(item.strike_price, 0) || null,
      underlyingSymbol: item.underlying_symbol || null,
    };
  }

  cacheInstrument(instrument) {
    if (!instrument.instrumentKey) {
      return;
    }
    this.instrumentCache.set(instrument.instrumentKey, instrument);
    this.instrumentCache.set(`${instrument.exchange}:${instrument.symbol}`.toUpperCase(), instrument);
    this.instrumentCache.set(instrument.symbol.toUpperCase(), instrument);
    if (instrument.tradingSymbol) {
      this.instrumentCache.set(instrument.tradingSymbol.toUpperCase(), instrument);
      this.instrumentCache.set(
        `${instrument.exchange}:${instrument.tradingSymbol}`.toUpperCase(),
        instrument
      );
    }
  }

  async resolveInstrument(order) {
    const inputKey = String(order.instrumentKey || "").trim();
    if (inputKey && this.instrumentCache.has(inputKey)) {
      return this.instrumentCache.get(inputKey);
    }

    if (inputKey && inputKey.includes("|") && !inputKey.includes("mock")) {
      return {
        instrumentKey: inputKey,
        symbol: order.symbol || inputKey,
        tradingSymbol: order.symbol || inputKey,
        exchange: String(order.exchange || "").toUpperCase(),
      };
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
      records: 20,
    });
    const exact = results.find((item) => item.tradingSymbol.toUpperCase() === symbol.toUpperCase());
    return exact || results[0] || null;
  }

  async searchInstruments(payload = {}) {
    const query = String(payload.query || "").trim();
    if (!query) {
      return [];
    }

    const token = String(this.account.accessToken || "").trim();
    if (!token) {
      throw new Error(`Account ${this.account.userId || this.account.name} has no access token`);
    }

    const params = new URLSearchParams({
      query,
      page_number: String(payload.pageNumber || 1),
      records: String(payload.records || 20),
    });

    if (payload.exchanges || payload.exchange) {
      params.set("exchanges", String(payload.exchanges || payload.exchange));
    }
    if (payload.segments) {
      params.set("segments", String(payload.segments));
    }
    if (payload.instrumentTypes) {
      params.set("instrument_types", String(payload.instrumentTypes));
    }
    if (payload.expiry) {
      params.set("expiry", String(payload.expiry));
    }
    if (payload.atmOffset !== undefined && payload.atmOffset !== null && payload.atmOffset !== "") {
      params.set("atm_offset", String(payload.atmOffset));
    }

    const response = await this.request(
      "GET",
      `${this.apiBase}/v2/instruments/search?${params.toString()}`,
      { token }
    );
    const rows = Array.isArray(response?.data) ? response.data : [];
    const mapped = rows.map((item) => this.normalizeInstrument(item));
    mapped.forEach((item) => this.cacheInstrument(item));
    return mapped;
  }

  async getOhlcByInstruments(instrumentKeys = []) {
    const uniqueKeys = Array.from(
      new Set(
        (Array.isArray(instrumentKeys) ? instrumentKeys : [])
          .map((item) => String(item || "").trim())
          .filter((item) => Boolean(item))
      )
    );
    if (!uniqueKeys.length) {
      return {};
    }

    const token = String(this.account.accessToken || "").trim();
    if (!token) {
      return {};
    }

    const params = new URLSearchParams({
      instrument_key: uniqueKeys.join(","),
      interval: "1d",
    });
    const response = await this.request(
      "GET",
      `${this.apiBase}/v2/market-quote/ohlc?${params.toString()}`,
      { token }
    );
    const rows = response?.data && typeof response.data === "object" ? response.data : {};
    const map = {};
    Object.entries(rows).forEach(([key, row]) => {
      const normalized =
        normalizeOhlcValue(row?.ohlc) ||
        normalizeOhlcValue(row?.OHLC) ||
        normalizeOhlcValue(row?.marketOHLC) ||
        normalizeOhlcValue(row);
      if (normalized) {
        map[String(key).trim()] = normalized;
      }
    });
    return map;
  }

  normalizeProduct(productType) {
    const key = String(productType || "").toUpperCase();
    if (key === "DELIVERY") {
      return "D";
    }
    if (key === "MTF") {
      return "MTF";
    }
    return "I";
  }

  normalizeOrderType(orderType) {
    const key = String(orderType || "").toUpperCase();
    if (["MARKET", "LIMIT", "SL", "SL-M"].includes(key)) {
      return key;
    }
    return "MARKET";
  }

  async placeOrder(order) {
    const token = String(this.account.accessToken || "").trim();
    if (!token) {
      throw new Error(`Account ${this.account.userId || this.account.name} has no access token`);
    }

    const resolved = await this.resolveInstrument(order);
    if (!resolved?.instrumentKey) {
      throw new Error(`Unable to resolve Upstox instrument for ${order.symbol || order.instrumentKey}`);
    }

    const payload = {
      quantity: Math.max(1, Math.floor(toNumber(order.quantity, 0))),
      product: this.normalizeProduct(order.productType),
      validity: "DAY",
      price: this.normalizeOrderType(order.orderType) === "LIMIT" ? toNumber(order.price, 0) : 0,
      tag: order.orderTag || "copy-trader",
      instrument_token: resolved.instrumentKey,
      order_type: this.normalizeOrderType(order.orderType),
      transaction_type: String(order.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY",
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
      slice: false,
    };

    const response = await this.request("POST", `${this.orderBase}/v3/order/place`, {
      token,
      body: payload,
    });

    const orderIds = Array.isArray(response?.data?.order_ids) ? response.data.order_ids : [];
    const orderId = response?.data?.order_id || orderIds[0] || null;
    if (!orderId) {
      throw new Error("Upstox place order succeeded but order_id is missing");
    }

    return {
      orderId: String(orderId),
      status: response?.status || "success",
      averagePrice: toNumber(order.price, 0),
      timestamp: new Date().toISOString(),
      raw: response,
    };
  }

  async cancelOrder(orderId) {
    const token = String(this.account.accessToken || "").trim();
    const params = new URLSearchParams({ order_id: String(orderId) });
    const response = await this.request(
      "DELETE",
      `${this.orderBase}/v2/order/cancel?${params.toString()}`,
      { token }
    );
    return response;
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

  getFundRows(data) {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object") {
      return Object.values(data).filter((value) => value && typeof value === "object");
    }
    return [];
  }

  async getFunds() {
    const token = String(this.account.accessToken || "").trim();
    const response = await this.request("GET", `${this.apiBase}/v2/user/get-funds-and-margin`, {
      token,
    });

    const rows = this.getFundRows(response?.data);
    let available = 0;
    let utilized = 0;
    let total = 0;

    for (const row of rows) {
      const rowAvailable =
        toNumber(row.available_margin, 0) ||
        toNumber(row.cashmarginavailable, 0) ||
        toNumber(row.available, 0);
      const rowUtilized =
        toNumber(row.used_margin, 0) ||
        toNumber(row.utilized, 0) ||
        toNumber(row.debits, 0);
      const rowTotal =
        toNumber(row.total_margin, 0) ||
        toNumber(row.net, 0) ||
        toNumber(rowAvailable + rowUtilized, 0);
      available += rowAvailable;
      utilized += rowUtilized;
      total += rowTotal;
    }

    if (total < available) {
      total = available;
    }
    if (utilized <= 0 && total >= available) {
      utilized = total - available;
    }

    return {
      total: Number(total.toFixed(2)),
      available: Number(available.toFixed(2)),
      utilized: Number(utilized.toFixed(2)),
      raw: response?.data,
    };
  }

  async getPnl() {
    const token = String(this.account.accessToken || "").trim();
    const response = await this.request("GET", `${this.apiBase}/v2/portfolio/short-term-positions`, {
      token,
    });
    const rows = Array.isArray(response?.data) ? response.data : [];

    let mtm = 0;
    const positions = [];

    for (const row of rows) {
      const netQty =
        toNumber(row.net_quantity, Number.NaN) ||
        toNumber(row.quantity, 0) ||
        toNumber(row.buy_quantity, 0) - toNumber(row.sell_quantity, 0);
      if (!netQty) {
        continue;
      }

      const symbol = String(row.trading_symbol || row.symbol || row.instrument_token || "");
      const ltp = toNumber(row.last_price, toNumber(row.ltp, 0));
      const avgPrice =
        toNumber(row.average_price, Number.NaN) ||
        toNumber(row.buy_price, Number.NaN) ||
        toNumber(row.avg_price, 0);
      let pnl = toNumber(row.pnl, Number.NaN);
      if (!Number.isFinite(pnl)) {
        pnl = toNumber(row.unrealised, Number.NaN);
      }
      if (!Number.isFinite(pnl)) {
        pnl = Number(((ltp - avgPrice) * netQty).toFixed(2));
      }
      mtm += pnl;

      positions.push({
        symbol,
        netQty: Math.trunc(netQty),
        avgPrice: Number(avgPrice.toFixed(2)),
        ltp: Number(ltp.toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
      });
    }

    return {
      mtm: Number(mtm.toFixed(2)),
      positions,
      raw: response?.data,
    };
  }
}

module.exports = {
  RealUpstoxClient,
};
