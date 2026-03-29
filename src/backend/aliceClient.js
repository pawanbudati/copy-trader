const crypto = require("crypto");
const { MockAliceClient } = require("./mockAliceClient");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inferType(symbol = "") {
  const upper = symbol.toUpperCase();
  if (upper.includes("CE") || upper.includes("PE")) {
    return "OPTION";
  }
  if (upper.includes("FUT")) {
    return "FUTURE";
  }
  if (upper.includes("NIFTY") || upper.includes("SENSEX")) {
    return "INDEX";
  }
  return "INSTRUMENT";
}

class RealAliceClient {
  constructor(account) {
    this.account = account;
    this.baseUrl =
      process.env.ALICE_BASE_API || "https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/";
    this.rootUrl = this.baseUrl.replace("AliceBlueAPIService/api/", "");
    this.instrumentCache = new Map();
  }

  userId() {
    return String(this.account.userId || "").toUpperCase();
  }

  sessionToken() {
    return this.account.sessionToken || null;
  }

  endpoint(path) {
    return `${this.baseUrl}${path}`;
  }

  headers(authRequired) {
    const headers = {
      "X-SAS-Version": "2.0",
      "User-Agent": "Codex Alice Copy Trader (Node)",
      "Content-Type": "application/json",
    };

    if (authRequired) {
      const token = this.sessionToken();
      if (!token) {
        throw new Error(`Account ${this.userId()} is not logged in`);
      }
      headers.Authorization = `Bearer ${this.userId()} ${token}`;
    }
    return headers;
  }

  async request(method, url, options = {}) {
    const authRequired = options.authRequired !== false;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    const response = await fetch(url, {
      method,
      headers: this.headers(authRequired),
      body,
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.emsg || data?.message || text || response.statusText;
      throw new Error(`Alice API ${response.status} ${response.statusText}: ${detail}`);
    }

    if (data && typeof data === "object" && data.stat && String(data.stat).toLowerCase() !== "ok") {
      throw new Error(data.emsg || data.message || "Alice API returned Not_ok");
    }

    return data;
  }

  normalizeInstrument(item) {
    const exchange = String(item.exch || item.exchange || "").toUpperCase();
    const symbol = String(item.formattedInsName || item.symbol || "").toUpperCase();
    const tradingSymbol = String(item.symbol || item.formattedInsName || "").toUpperCase();
    return {
      exchange,
      token: String(item.token || item.symbol_id || ""),
      symbol,
      tradingSymbol,
      name: item.symbol || item.formattedInsName || symbol,
      expiry: item.expiry || null,
      lotSize: toNumber(item.lotSize, 0) || null,
      type: inferType(symbol),
    };
  }

  cacheInstrument(instrument) {
    const key1 = `${instrument.exchange}:${instrument.symbol}`;
    this.instrumentCache.set(key1, instrument);
    if (instrument.tradingSymbol) {
      const key2 = `${instrument.exchange}:${instrument.tradingSymbol}`;
      this.instrumentCache.set(key2, instrument);
    }
  }

  async login() {
    const userId = this.userId();
    const apiKey = String(this.account.apiKey || "");
    if (!userId || !apiKey) {
      throw new Error("Missing userId/apiKey for live Alice login");
    }

    const encKeyResponse = await this.request("POST", this.endpoint("customer/getAPIEncpkey"), {
      authRequired: false,
      body: { userId },
    });
    const encKey = encKeyResponse?.encKey;
    if (!encKey) {
      throw new Error("Alice login failed: encryption key not returned");
    }

    const userData = sha256(`${userId}${apiKey}${encKey}`);
    const sidResponse = await this.request("POST", this.endpoint("customer/getUserSID"), {
      authRequired: false,
      body: {
        userId,
        userData,
      },
    });

    const sessionToken = sidResponse?.sessionID;
    if (!sessionToken) {
      throw new Error("Alice login failed: sessionID missing");
    }

    return {
      sessionToken,
      loginAt: new Date().toISOString(),
      raw: sidResponse,
    };
  }

  async searchInstruments({ query, exchange }) {
    const q = String(query || "").trim();
    if (!q) {
      return [];
    }

    const exch = String(exchange || "").trim().toUpperCase();
    const exchanges = exch ? [exch] : ["INDICES", "NFO", "NSE", "BSE", "CDS", "MCX", "BFO", "BCD"];
    const url = `${this.rootUrl}DataApiService/v2/exchange/getScripForSearchAPI`;

    const response = await this.request("POST", url, {
      authRequired: true,
      body: {
        symbol: q,
        exchange: exchanges,
      },
    });

    if (!Array.isArray(response)) {
      return [];
    }

    const mapped = response.map((item) => this.normalizeInstrument(item));
    mapped.forEach((item) => this.cacheInstrument(item));
    return mapped;
  }

  mapProduct(productType, exchange) {
    const map = {
      INTRADAY: "MIS",
      DELIVERY: "CNC",
      NORMAL: "NRML",
      COVERORDER: "CO",
      BRACKETORDER: "BO",
    };
    let pCode = map[String(productType || "").toUpperCase()] || "MIS";
    if ((exchange === "NFO" || exchange === "MCX") && pCode === "CNC") {
      pCode = "NRML";
    }
    return pCode;
  }

  mapPriceType(orderType) {
    return String(orderType || "").toUpperCase() === "LIMIT" ? "L" : "MKT";
  }

  async resolveInstrument(exchange, symbol) {
    const key = `${exchange.toUpperCase()}:${symbol.toUpperCase()}`;
    if (this.instrumentCache.has(key)) {
      return this.instrumentCache.get(key);
    }

    const results = await this.searchInstruments({
      query: symbol,
      exchange,
    });
    const symbolUpper = symbol.toUpperCase();
    const exact =
      results.find((item) => item.symbol === symbolUpper) ||
      results.find((item) => item.tradingSymbol === symbolUpper) ||
      results[0];
    if (!exact) {
      throw new Error(`Unable to resolve instrument: ${exchange} ${symbol}`);
    }
    this.cacheInstrument(exact);
    return exact;
  }

  async placeOrder(order) {
    const exchange = String(order.exchange || "").toUpperCase();
    const symbol = String(order.symbol || "").toUpperCase();
    if (!exchange || !symbol) {
      throw new Error("Missing exchange/symbol for live order");
    }

    const instrument = await this.resolveInstrument(exchange, symbol);
    const pCode = this.mapProduct(order.productType, exchange);
    const complexty = pCode === "BO" ? "BO" : "regular";

    const payload = [
      {
        complexty,
        discqty: 0,
        exch: exchange,
        pCode: pCode === "BO" ? "MIS" : pCode,
        price: this.mapPriceType(order.orderType) === "L" ? toNumber(order.price, 0) : 0,
        prctyp: this.mapPriceType(order.orderType),
        qty: Math.floor(toNumber(order.quantity, 0)),
        ret: "DAY",
        symbol_id: instrument.token,
        trading_symbol: instrument.tradingSymbol || instrument.name || instrument.symbol,
        transtype: String(order.side || "").toUpperCase(),
        stopLoss: order.stoplossSpread > 0 ? toNumber(order.stoplossSpread, 0) : null,
        target: order.targetSpread > 0 ? toNumber(order.targetSpread, 0) : null,
        trailing_stop_loss: null,
        trigPrice: null,
        orderTag: order.orderTag || "copy-trader",
      },
    ];

    const response = await this.request("POST", this.endpoint("placeOrder/executePlaceOrder"), {
      authRequired: true,
      body: payload,
    });

    const first = Array.isArray(response) ? response[0] : response;
    const stat = String(first?.stat || "").toLowerCase();
    if (stat && stat !== "ok") {
      throw new Error(first?.emsg || first?.message || "Order rejected by Alice");
    }

    const orderId =
      first?.NOrdNo ||
      first?.Nstordno ||
      first?.nestOrderNumber ||
      first?.orderId ||
      null;
    if (!orderId) {
      throw new Error("Order succeeded but order id was not returned");
    }

    return {
      orderId: String(orderId),
      status: first?.stat || first?.Status || "Ok",
      averagePrice: toNumber(first?.Avgprc, toNumber(order.price, 0)),
      timestamp: new Date().toISOString(),
      raw: first,
    };
  }

  async cancelOrder(orderId) {
    const response = await this.request("POST", this.endpoint("placeOrder/cancelOrder"), {
      authRequired: true,
      body: {
        nestOrderNumber: orderId,
      },
    });
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
        targetSpread: 0,
        stoplossSpread: 0,
      });
    }

    if (!reference?.orderId) {
      throw new Error("exitByReference requires order or orderId");
    }
    await this.cancelOrder(reference.orderId);
    return {
      orderId: String(reference.orderId),
      status: "CANCELLED",
      averagePrice: 0,
      timestamp: new Date().toISOString(),
    };
  }

  async getFunds() {
    const response = await this.request("GET", this.endpoint("limits/getRmsLimits"), {
      authRequired: true,
    });
    const rows = Array.isArray(response) ? response : [];

    let total = 0;
    let available = 0;
    for (const row of rows) {
      total += toNumber(row.net, 0);
      available += toNumber(row.cashmarginavailable, 0);
    }

    if (total <= 0 && rows[0]) {
      total = toNumber(rows[0].net, 0);
    }
    if (available <= 0 && rows[0]) {
      available = toNumber(rows[0].cashmarginavailable, 0);
    }

    const utilized = Math.max(total - available, 0);
    return {
      total: Number(total.toFixed(2)),
      available: Number(available.toFixed(2)),
      utilized: Number(utilized.toFixed(2)),
      raw: rows,
    };
  }

  async getPnl() {
    const response = await this.request("POST", this.endpoint("positionAndHoldings/positionBook"), {
      authRequired: true,
      body: { ret: "NET" },
    });
    const rows = Array.isArray(response) ? response : [];

    let mtm = 0;
    const positions = [];
    for (const row of rows) {
      const netQty = Math.trunc(toNumber(row.Netqty, 0));
      const rowMtm = toNumber(row.MtoM, 0);
      mtm += rowMtm;
      if (netQty === 0) {
        continue;
      }

      const symbol = String(row.Tsym || row.symbol || "").toUpperCase();
      const ltp = toNumber(row.LTP, 0);
      const avgPrice =
        netQty >= 0 ? toNumber(row.Buyavgprc, 0) : toNumber(row.Sellavgprc, 0);
      positions.push({
        symbol,
        netQty,
        avgPrice: Number(avgPrice.toFixed(2)),
        ltp: Number(ltp.toFixed(2)),
        pnl: Number(rowMtm.toFixed(2)),
      });
    }

    return {
      mtm: Number(mtm.toFixed(2)),
      positions,
      raw: rows,
    };
  }
}

function createBrokerClient(account) {
  const useMock = process.env.USE_MOCK_BROKER !== "false";
  if (useMock) {
    return new MockAliceClient(account);
  }
  return new RealAliceClient(account);
}

module.exports = {
  createBrokerClient,
  RealAliceClient,
};
