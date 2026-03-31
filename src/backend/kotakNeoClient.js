const { logApiCall, headersToObject } = require("./apiCallLogger");

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

function parseJsonOrNull(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_error) {
    return null;
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

function mapExchangeSegmentToCode(value) {
  const key = String(value || "").trim().toUpperCase();
  if (["NSE", "NSE_CM", "NSECM", "EQ"].includes(key)) {
    return "nse_cm";
  }
  if (["BSE", "BSE_CM", "BSECM"].includes(key)) {
    return "bse_cm";
  }
  if (["NFO", "NSE_FO", "NSEFO", "FO", "OPT"].includes(key)) {
    return "nse_fo";
  }
  if (["BFO", "BSE_FO", "BSEFO"].includes(key)) {
    return "bse_fo";
  }
  if (["MCX", "MCX_FO", "MCXFO"].includes(key)) {
    return "mcx_fo";
  }
  return String(value || "").trim().toLowerCase() || "nse_cm";
}

function normalizeProduct(productType) {
  const key = String(productType || "").toUpperCase();
  if (key === "DELIVERY") {
    return "CNC";
  }
  if (key === "MTF") {
    return "MTF";
  }
  if (key === "NRML") {
    return "NRML";
  }
  return "MIS";
}

function normalizeOrderType(orderType) {
  const key = String(orderType || "").toUpperCase();
  if (key === "LIMIT" || key === "L") {
    return "L";
  }
  if (key === "SL" || key === "SL-M") {
    return key;
  }
  return "MKT";
}

function parseKotakExpiry(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 0) {
    const ms = asNum > 1_000_000_000_000 ? asNum : asNum * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

class RealKotakNeoClient {
  constructor(account) {
    this.account = account;
    this.sessionBase = process.env.KOTAK_NEO_SESSION_BASE || "https://mis.kotaksecurities.com";
    this.defaultTradeBase =
      process.env.KOTAK_NEO_TRADING_BASE || "https://mis.kotaksecurities.com";
    this.neoFinKey = process.env.KOTAK_NEO_FIN_KEY || "neotradeapi";
    this.instrumentCache = new Map();
    this.masterFileCache = {
      timestamp: 0,
      files: [],
    };
    this.masterRowsCache = new Map();
  }

  get credentials() {
    return this.account.credentials || {};
  }

  ensureCredentialsPatch(patch) {
    this.account.credentials = {
      ...this.credentials,
      ...patch,
    };
  }

  getConsumerKey() {
    return String(this.credentials.consumerKey || this.account.clientId || "").trim();
  }

  getAccessToken() {
    return String(this.account.accessToken || this.credentials.accessToken || "").trim();
  }

  getTradingSid() {
    return String(this.credentials.tradingSid || "").trim();
  }

  getServerId() {
    return String(this.credentials.serverId || "").trim();
  }

  getTradeBaseUrl() {
    return String(this.credentials.baseUrl || this.defaultTradeBase || "").replace(/\/+$/, "");
  }

  getAuthorizeUrl(stateValue = null) {
    const consumerKey = this.getConsumerKey();
    if (!consumerKey) {
      throw new Error("Kotak Neo consumer key is required");
    }
    const state = stateValue || `copy-${this.account.id}-${Date.now()}`;
    const params = new URLSearchParams({
      consumerKey,
      state,
    });
    return `${this.sessionBase.replace(/\/+$/, "")}/apim/login/2.0/algo-user/v5/login/authorization/dialog?${params}`;
  }

  async request(method, url, { headers, query, body, formLike = false } = {}) {
    const builtUrl = new URL(url);
    if (query && typeof query === "object") {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          builtUrl.searchParams.set(key, String(value));
        }
      });
    }

    const mergedHeaders = {
      Accept: "application/json",
      ...(headers || {}),
    };

    let payload;
    let requestBody = null;
    if (body !== undefined) {
      if (formLike) {
        mergedHeaders["Content-Type"] = "application/x-www-form-urlencoded";
        payload = new URLSearchParams({
          jData: JSON.stringify(body),
        });
        requestBody = body;
      } else {
        mergedHeaders["Content-Type"] = mergedHeaders["Content-Type"] || "application/json";
        payload =
          mergedHeaders["Content-Type"].includes("json") && typeof body !== "string"
            ? JSON.stringify(body)
            : body;
        requestBody = body;
      }
    }
    const startedAt = Date.now();
    let response;
    let text = "";

    try {
      response = await fetch(builtUrl.toString(), {
        method,
        headers: mergedHeaders,
        body: payload,
      });
      text = await response.text();
    } catch (error) {
      logApiCall({
        source: "broker-api",
        broker: "kotakneo",
        accountId: this.account?.id || null,
        durationMs: Date.now() - startedAt,
        request: {
          method,
          url: builtUrl.toString(),
          headers: mergedHeaders,
          query: query || null,
          body: requestBody,
        },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const json = parseJsonOrNull(text);

    logApiCall({
      source: "broker-api",
      broker: "kotakneo",
      accountId: this.account?.id || null,
      durationMs: Date.now() - startedAt,
      request: {
        method,
        url: builtUrl.toString(),
        headers: mergedHeaders,
        query: query || null,
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
      const detail = json?.message || json?.error || text || response.statusText || "Unknown error";
      throw new Error(`Kotak Neo API ${response.status}: ${detail}`);
    }
    return json ?? text;
  }

  async validateSession() {
    await this.getFunds();
  }

  async totpLogin({ mobileNumber, ucc, totp }) {
    const consumerKey = this.getConsumerKey();
    if (!consumerKey) {
      throw new Error("Kotak Neo consumer key is required");
    }
    const response = await this.request(
      "POST",
      `${this.sessionBase.replace(/\/+$/, "")}/login/1.0/tradeApiLogin`,
      {
        headers: {
          Authorization: consumerKey,
          "neo-fin-key": this.neoFinKey,
        },
        body: {
          mobileNumber,
          ucc,
          totp,
        },
      }
    );
    const data = response?.data || {};
    return {
      viewToken: String(data.token || "").trim(),
      sid: String(data.sid || "").trim(),
    };
  }

  async totpValidate({ viewToken, sid, mpin }) {
    const consumerKey = this.getConsumerKey();
    const response = await this.request(
      "POST",
      `${this.sessionBase.replace(/\/+$/, "")}/login/1.0/tradeApiValidate`,
      {
        headers: {
          Authorization: consumerKey,
          sid,
          Auth: viewToken,
          "neo-fin-key": this.neoFinKey,
        },
        body: {
          mpin,
        },
      }
    );
    const data = response?.data || {};
    return {
      accessToken: String(data.token || "").trim(),
      tradingSid: String(data.sid || "").trim(),
      serverId: String(data.hsServerId || data.serverId || "").trim(),
      baseUrl: String(data.baseUrl || "").trim(),
      rid: String(data.rid || "").trim(),
      userId: String(data.ucc || "").trim(),
    };
  }

  async login(options = {}) {
    if (options.consumerKey !== undefined) {
      this.ensureCredentialsPatch({
        consumerKey: String(options.consumerKey || "").trim(),
      });
    }
    if (options.baseUrl !== undefined) {
      this.ensureCredentialsPatch({
        baseUrl: String(options.baseUrl || "").trim(),
      });
    }
    if (options.tradingSid !== undefined) {
      this.ensureCredentialsPatch({
        tradingSid: String(options.tradingSid || "").trim(),
      });
    }
    if (options.serverId !== undefined) {
      this.ensureCredentialsPatch({
        serverId: String(options.serverId || "").trim(),
      });
    }
    if (options.accessToken !== undefined) {
      this.account.accessToken = String(options.accessToken || "").trim() || null;
      this.ensureCredentialsPatch({
        accessToken: this.account.accessToken,
      });
    }

    const hasInteractiveFields =
      options.mobileNumber && options.ucc && options.totp && options.mpin;
    if (!this.getAccessToken() || !this.getTradingSid() || !this.getServerId()) {
      if (!hasInteractiveFields) {
        throw new Error(
          "Kotak login needs access token + trading SID + server ID, or mobile+ucc+totp+mpin for interactive login"
        );
      }
      const stage1 = await this.totpLogin(options);
      const stage2 = await this.totpValidate({
        viewToken: stage1.viewToken,
        sid: stage1.sid,
        mpin: options.mpin,
      });
      this.account.accessToken = stage2.accessToken || this.account.accessToken;
      this.ensureCredentialsPatch({
        accessToken: this.account.accessToken,
        tradingSid: stage2.tradingSid || this.getTradingSid(),
        serverId: stage2.serverId || this.getServerId(),
        baseUrl: stage2.baseUrl || this.getTradeBaseUrl(),
        kotakUcc: options.ucc || this.credentials.kotakUcc || "",
      });
    }

    await this.validateSession();
    return {
      accessToken: this.getAccessToken(),
      refreshToken: null,
      tokenExpiresAt: null,
      loginAt: new Date().toISOString(),
      userId: String(this.credentials.kotakUcc || options.ucc || this.account.userId || ""),
      userName: this.account.name,
      profile: {
        broker: "kotakneo",
        baseUrl: this.getTradeBaseUrl(),
      },
    };
  }

  tradeAuthHeaders() {
    const token = this.getAccessToken();
    const sid = this.getTradingSid();
    if (!token || !sid) {
      throw new Error("Kotak account is not logged in");
    }
    return {
      Sid: sid,
      Auth: token,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  async getMasterFiles() {
    const consumerKey = this.getConsumerKey();
    if (!consumerKey) {
      throw new Error("Kotak consumer key missing");
    }

    const now = Date.now();
    if (this.masterFileCache.files.length && now - this.masterFileCache.timestamp < 15 * 60 * 1000) {
      return this.masterFileCache.files;
    }

    const response = await this.request(
      "GET",
      `${this.sessionBase.replace(/\/+$/, "")}/script-details/1.0/masterscrip/file-paths`,
      {
        headers: {
          Authorization: consumerKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    const files = Array.isArray(response?.data?.filesPaths) ? response.data.filesPaths : [];
    this.masterFileCache = {
      timestamp: now,
      files,
    };
    return files;
  }

  async loadMasterRows(fileUrl) {
    const cached = this.masterRowsCache.get(fileUrl);
    if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) {
      return cached.rows;
    }
    const startedAt = Date.now();
    let response;
    let csvText = "";
    try {
      response = await fetch(fileUrl);
      csvText = await response.text();
    } catch (error) {
      logApiCall({
        source: "broker-api",
        broker: "kotakneo",
        accountId: this.account?.id || null,
        durationMs: Date.now() - startedAt,
        request: {
          method: "GET",
          url: fileUrl,
          headers: {},
          body: null,
        },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    logApiCall({
      source: "broker-api",
      broker: "kotakneo",
      accountId: this.account?.id || null,
      durationMs: Date.now() - startedAt,
      request: {
        method: "GET",
        url: fileUrl,
        headers: {},
        body: null,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: headersToObject(response.headers),
        body: csvText,
        json: null,
      },
    });

    if (!response.ok) {
      throw new Error(`Unable to fetch master file: ${fileUrl}`);
    }
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) {
      return [];
    }
    const headers = parseCsvLine(lines[0]).map((value) => value.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i]);
      if (!cols.length) {
        continue;
      }
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = cols[idx] !== undefined ? cols[idx] : "";
      });
      rows.push(row);
    }

    this.masterRowsCache.set(fileUrl, {
      timestamp: Date.now(),
      rows,
    });
    return rows;
  }

  mapMasterRow(row) {
    const segment = mapExchangeSegmentToCode(row.pExchSeg || row.pSegment || row.pExchange);
    const exchange = String(row.pExchange || "").toUpperCase() || segment.slice(0, 3).toUpperCase();
    const token = String(row.pSymbol || row.pScripRefKey || "").trim();
    const tradingSymbol = String(row.pTrdSymbol || row.pCombinedSymbol || "").trim();
    const symbol = String(row.pSymbolName || tradingSymbol || token).trim();
    const lotSize = Math.max(
      1,
      Math.floor(toNumber(row.lLotSize, toNumber(row.iLotSize, toNumber(row.iBoardLotQty, 1))))
    );
    const type = String(row.pOptionType || row.pInstType || row.pInstName || "EQ").toUpperCase();
    const expiry = parseKotakExpiry(row.pExpiryDate || row.lExpiryDate);
    const strikePrice = toNumber(row["dStrikePrice;"], 0) / 100 || null;
    const instrument = {
      exchange,
      segment,
      symbol,
      tradingSymbol: tradingSymbol || symbol,
      instrumentKey: `${segment}|${token || tradingSymbol || symbol}`,
      token: token || null,
      type,
      lotSize,
      expiry,
      strikePrice,
      underlyingSymbol: symbol,
      raw: row,
    };
    return instrument;
  }

  cacheInstrument(instrument) {
    if (!instrument.instrumentKey) {
      return;
    }
    this.instrumentCache.set(instrument.instrumentKey, instrument);
    this.instrumentCache.set(instrument.tradingSymbol.toUpperCase(), instrument);
    this.instrumentCache.set(instrument.symbol.toUpperCase(), instrument);
    this.instrumentCache.set(
      `${instrument.exchange}:${instrument.tradingSymbol}`.toUpperCase(),
      instrument
    );
    this.instrumentCache.set(`${instrument.exchange}:${instrument.symbol}`.toUpperCase(), instrument);
  }

  chooseMasterFiles(files, payload = {}) {
    const exchanges = splitCsv(payload.exchanges || payload.exchange).map((value) =>
      value.toLowerCase()
    );
    const segments = splitCsv(payload.segments).map((value) => value.toLowerCase());

    let chosen = files;
    if (segments.length) {
      const wantsFo = segments.some((seg) => seg.includes("fo") || seg.includes("opt"));
      const wantsEq = segments.some((seg) => seg.includes("eq") || seg.includes("index"));
      if (wantsFo && !wantsEq) {
        chosen = chosen.filter((file) => file.toLowerCase().includes("_fo"));
      } else if (wantsEq && !wantsFo) {
        chosen = chosen.filter((file) => file.toLowerCase().includes("_cm"));
      }
    }
    if (exchanges.length) {
      chosen = chosen.filter((file) =>
        exchanges.some((exchange) => file.toLowerCase().includes(exchange))
      );
    }
    if (!chosen.length) {
      chosen = files;
    }
    return chosen.slice(0, 3);
  }

  async searchInstruments(payload = {}) {
    const query = String(payload.query || "").trim();
    if (!query) {
      return [];
    }
    const files = await this.getMasterFiles();
    const selected = this.chooseMasterFiles(files, payload);
    const rows = [];
    for (const file of selected) {
      const masterRows = await this.loadMasterRows(file);
      rows.push(...masterRows);
    }

    const typeFilter = splitCsv(payload.instrumentTypes).map((value) => value.toUpperCase());
    const segmentFilter = splitCsv(payload.segments).map((value) => value.toUpperCase());
    const exchangeFilter = splitCsv(payload.exchanges || payload.exchange).map((value) =>
      value.toUpperCase()
    );
    const expiryFilter = String(payload.expiry || "").trim().toUpperCase();
    const queryUpper = query.toUpperCase();

    const mapped = rows
      .map((row) => this.mapMasterRow(row))
      .filter((instrument) => {
        const text = `${instrument.tradingSymbol} ${instrument.symbol}`.toUpperCase();
        if (!text.includes(queryUpper)) {
          return false;
        }
        if (typeFilter.length && !typeFilter.some((item) => instrument.type.includes(item))) {
          return false;
        }
        if (segmentFilter.length && !segmentFilter.some((item) => instrument.segment.toUpperCase().includes(item))) {
          return false;
        }
        if (exchangeFilter.length && !exchangeFilter.includes(instrument.exchange)) {
          return false;
        }
        if (expiryFilter && !String(instrument.expiry || "").toUpperCase().includes(expiryFilter)) {
          return false;
        }
        return true;
      })
      .slice(0, 120);

    mapped.forEach((item) => this.cacheInstrument(item));
    return mapped;
  }

  async resolveInstrument(order) {
    const key = String(order.instrumentKey || "").trim();
    if (key && this.instrumentCache.has(key)) {
      return this.instrumentCache.get(key);
    }
    const symbol = String(order.symbol || "").trim();
    if (!symbol) {
      return null;
    }
    const hit =
      this.instrumentCache.get(symbol.toUpperCase()) ||
      this.instrumentCache.get(
        `${String(order.exchange || "").toUpperCase()}:${symbol}`.toUpperCase()
      );
    if (hit) {
      return hit;
    }
    const results = await this.searchInstruments({
      query: symbol,
      exchange: order.exchange || "",
    });
    const exact = results.find((item) => item.tradingSymbol.toUpperCase() === symbol.toUpperCase());
    return exact || results[0] || null;
  }

  async placeOrder(order) {
    const instrument = await this.resolveInstrument(order);
    if (!instrument) {
      throw new Error(`Kotak instrument not found for ${order.symbol || order.instrumentKey}`);
    }

    const serverId = this.getServerId();
    if (!serverId) {
      throw new Error("Kotak server ID is missing. Login again and save server ID.");
    }

    const payload = {
      am: "NO",
      dq: 0,
      es: mapExchangeSegmentToCode(instrument.segment),
      mp: 0,
      pc: normalizeProduct(order.productType),
      pf: "N",
      pr: normalizeOrderType(order.orderType) === "L" ? toNumber(order.price, 0) : 0,
      pt: normalizeOrderType(order.orderType),
      qt: Math.max(1, Math.floor(toNumber(order.quantity, 0))),
      rt: "DAY",
      tp: toNumber(order.triggerPrice, 0),
      ts: instrument.tradingSymbol,
      tt: String(order.side || "").toUpperCase() === "SELL" ? "S" : "B",
      ig: order.orderTag || "copy-trader",
      tk: instrument.token || "",
      os: "NEOTRADEAPI",
    };

    const response = await this.request(
      "POST",
      `${this.getTradeBaseUrl()}/quick/order/rule/ms/place`,
      {
        headers: this.tradeAuthHeaders(),
        query: { sId: serverId },
        body: payload,
        formLike: true,
      }
    );
    const data = response?.data || {};
    const orderId = String(
      data.nOrdNo || data.orderId || response?.nOrdNo || response?.orderId || data?.order_id || ""
    ).trim();
    if (!orderId) {
      throw new Error("Kotak place order succeeded but order id is missing");
    }
    return {
      orderId,
      status: String(response?.stat || response?.message || "Ok"),
      averagePrice: toNumber(payload.pr, 0),
      timestamp: new Date().toISOString(),
      raw: response,
    };
  }

  async cancelOrder(orderId) {
    const serverId = this.getServerId();
    return this.request("POST", `${this.getTradeBaseUrl()}/quick/order/cancel`, {
      headers: this.tradeAuthHeaders(),
      query: { sId: serverId },
      body: {
        on: String(orderId),
        am: "NO",
      },
      formLike: true,
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

  parseLimitsRows(response) {
    if (Array.isArray(response?.data)) {
      return response.data;
    }
    if (response?.data && typeof response.data === "object") {
      return Object.values(response.data).filter((item) => item && typeof item === "object");
    }
    return [];
  }

  async getFunds() {
    const serverId = this.getServerId();
    const response = await this.request("POST", `${this.getTradeBaseUrl()}/quick/user/limits`, {
      headers: this.tradeAuthHeaders(),
      query: { sId: serverId },
      body: {
        seg: "ALL",
        exch: "ALL",
        prod: "ALL",
      },
      formLike: true,
    });
    const rows = this.parseLimitsRows(response);
    let total = 0;
    let available = 0;
    let utilized = 0;
    rows.forEach((row) => {
      const rowAvailable =
        toNumber(row.cashmarginavailable, 0) ||
        toNumber(row.availableMargin, 0) ||
        toNumber(row.available, 0);
      const rowTotal = toNumber(row.net, 0) || toNumber(row.total, 0) || rowAvailable;
      const rowUtilized =
        toNumber(row.utilized, 0) ||
        toNumber(row.varmargin, 0) +
          toNumber(row.spanmargin, 0) +
          toNumber(row.exposuremargin, 0);
      available += rowAvailable;
      total += rowTotal;
      utilized += rowUtilized;
    });

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
      raw: response,
    };
  }

  async getPnl() {
    const serverId = this.getServerId();
    const response = await this.request("GET", `${this.getTradeBaseUrl()}/quick/user/positions`, {
      headers: this.tradeAuthHeaders(),
      query: { sId: serverId },
    });
    const rows = Array.isArray(response?.data) ? response.data : [];
    let mtm = 0;
    const positions = [];
    rows.forEach((row) => {
      const netQty = Math.trunc(toNumber(row.Netqty, toNumber(row.netQty, toNumber(row.net_quantity, 0))));
      if (!netQty) {
        return;
      }
      const symbol = String(row.Tsym || row.trading_symbol || row.symbol || "").trim();
      const avgPrice = toNumber(row.Buyavgprc, toNumber(row.average_price, 0));
      const ltp = toNumber(row.LTP, toNumber(row.ltp, avgPrice));
      const pnl = toNumber(row.MtoM, (ltp - avgPrice) * netQty);
      mtm += pnl;
      positions.push({
        symbol,
        netQty,
        avgPrice: Number(avgPrice.toFixed(2)),
        ltp: Number(ltp.toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
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
  RealKotakNeoClient,
};
