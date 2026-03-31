const crypto = require("crypto");
const { logApiCall, headersToObject } = require("./apiCallLogger");

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
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

function normalizeOpenApiProduct(productType) {
  const value = String(productType || "").toUpperCase();
  if (value === "DELIVERY" || value === "CNC" || value === "LONGTERM") {
    return "LONGTERM";
  }
  if (value === "MTF") {
    return "MTF";
  }
  return "INTRADAY";
}

function normalizeOpenApiOrderType(orderType, triggerPrice = 0) {
  const value = String(orderType || "").toUpperCase();
  if (value === "LIMIT" || value === "L") {
    return "LIMIT";
  }
  if (toNumber(triggerPrice, 0) > 0) {
    return "SL";
  }
  return "MARKET";
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

const MONTH_LOOKUP = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeYear(value) {
  const yearNum = Number(value);
  if (!Number.isFinite(yearNum)) {
    return null;
  }
  if (yearNum < 100) {
    return 2000 + yearNum;
  }
  return yearNum;
}

function toIsoDate(day, monthText, year) {
  const month = MONTH_LOOKUP[String(monthText || "").toUpperCase()];
  const normalizedYear = normalizeYear(year);
  const dayNum = Number(day);
  if (!month || !normalizedYear || !Number.isFinite(dayNum)) {
    return "";
  }
  return `${normalizedYear}-${pad2(month)}-${pad2(dayNum)}`;
}

function parseExpiryFromText(text) {
  const input = String(text || "").toUpperCase().trim();
  if (!input) {
    return "";
  }

  const spaced = input.match(/\b(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{2,4})\b/);
  if (spaced) {
    return toIsoDate(spaced[1], spaced[2], spaced[3]);
  }

  const compact = input.match(/\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2,4})\b/);
  if (compact) {
    return toIsoDate(compact[1], compact[2], compact[3]);
  }
  return "";
}

function parseExpiryToDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const parsedIso = new Date(raw);
  if (!Number.isNaN(parsedIso.getTime())) {
    return parsedIso;
  }
  const parsedExpiryText = parseExpiryFromText(raw);
  if (parsedExpiryText) {
    const parsedDate = new Date(parsedExpiryText);
    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }
  return null;
}

function parseStrikeFromText(text) {
  const input = String(text || "").toUpperCase();
  if (!input) {
    return null;
  }
  const match = input.match(/\b(\d+(?:\.\d+)?)\s+(CE|PE)\b/);
  if (!match) {
    return null;
  }
  const strike = Number(match[1]);
  return Number.isFinite(strike) ? strike : null;
}

function normalizeMatchText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseOrderSymbolHint(symbol) {
  const raw = String(symbol || "").toUpperCase().trim();
  if (!raw) {
    return {
      raw,
      underlying: "",
      type: "",
      strike: null,
      expiry: "",
    };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  const typeMatch = raw.match(/\b(CE|PE|FUT)\b/);
  const type = typeMatch ? typeMatch[1] : "";
  let strike = parseStrikeFromText(raw);
  if ((type === "CE" || type === "PE") && !Number.isFinite(strike)) {
    const typeIndex = tokens.indexOf(type);
    if (typeIndex > 0) {
      for (let index = typeIndex - 1; index >= 0; index -= 1) {
        const candidate = Number(tokens[index].replace(/,/g, ""));
        if (Number.isFinite(candidate)) {
          strike = candidate;
          break;
        }
      }
    }
  }

  return {
    raw,
    underlying: tokens[0] || "",
    type,
    strike: Number.isFinite(strike) ? strike : null,
    expiry: parseExpiryFromText(raw),
  };
}

function scoreInstrumentCandidate(orderHint, candidate, symbol) {
  let score = 0;
  const symbolText = String(symbol || "").toUpperCase();
  const candidateTrading = String(candidate.tradingSymbol || "").toUpperCase();
  const candidateSymbol = String(candidate.symbol || "").toUpperCase();
  const candidateType = String(candidate.type || "").toUpperCase();
  const candidateExpiry = String(candidate.expiry || "").trim();
  const candidateStrike = Number(candidate.strikePrice);

  if (candidateTrading === symbolText || candidateSymbol === symbolText) {
    score += 1000;
  }

  const normalizedSymbol = normalizeMatchText(symbolText);
  if (
    normalizeMatchText(candidateTrading) === normalizedSymbol ||
    normalizeMatchText(candidateSymbol) === normalizedSymbol
  ) {
    score += 900;
  }

  if (orderHint.underlying && candidateSymbol === orderHint.underlying) {
    score += 120;
  }

  if (orderHint.type && candidateType === orderHint.type) {
    score += 140;
  }

  if (
    Number.isFinite(orderHint.strike) &&
    Number.isFinite(candidateStrike) &&
    Math.abs(candidateStrike - orderHint.strike) < 0.001
  ) {
    score += 160;
  }

  if (orderHint.expiry && candidateExpiry === orderHint.expiry) {
    score += 180;
  }

  return score;
}

function extractQueryValue(url, names = []) {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) {
      return String(value).trim();
    }
  }
  return "";
}

function safeDecodeUrlValue(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }
  try {
    return decodeURIComponent(raw);
  } catch (_error) {
    return raw;
  }
}

function extractQueryValuePreservePlus(rawCandidate, names = []) {
  const raw = String(rawCandidate || "").trim();
  if (!raw || !names.length) {
    return "";
  }
  const keys = names.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean);
  if (!keys.length) {
    return "";
  }

  const segments = [];
  const queryIndex = raw.indexOf("?");
  if (queryIndex >= 0) {
    segments.push(raw.slice(queryIndex + 1));
  }
  const hashIndex = raw.indexOf("#");
  if (hashIndex >= 0) {
    segments.push(raw.slice(hashIndex + 1));
  }
  if (!segments.length && raw.includes("=")) {
    segments.push(raw.replace(/^[?#]/, ""));
  }

  for (const segment of segments) {
    const cleanSegment = String(segment || "")
      .split("#")[0]
      .trim();
    if (!cleanSegment) {
      continue;
    }
    const pairs = cleanSegment.split("&");
    for (const pair of pairs) {
      const text = String(pair || "").trim();
      if (!text) {
        continue;
      }
      const eqIndex = text.indexOf("=");
      if (eqIndex <= 0) {
        continue;
      }
      const key = safeDecodeUrlValue(text.slice(0, eqIndex)).trim().toLowerCase();
      if (!key || !keys.includes(key)) {
        continue;
      }
      const value = safeDecodeUrlValue(text.slice(eqIndex + 1)).trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function parseAuthDetails(input = {}) {
  const details = {
    authCode: String(input.authCode || input.code || "").trim(),
    userId: String(input.userId || input.aliceUserId || "").trim(),
  };
  const candidates = [
    String(input.redirectedUrl || "").trim(),
    String(input.authCode || "").trim(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!details.authCode) {
      details.authCode = extractQueryValuePreservePlus(candidate, [
        "authCode",
        "authcode",
        "auth_code",
        "code",
      ]);
    }
    if (!details.userId) {
      details.userId = extractQueryValuePreservePlus(candidate, [
        "userId",
        "userid",
        "user_id",
        "uid",
      ]);
    }
    if (details.authCode && details.userId) {
      break;
    }

    let parsed = null;
    try {
      parsed = new URL(candidate);
    } catch (_error) {
      try {
        parsed = new URL(
          candidate.startsWith("?") ? `https://dummy.local/${candidate}` : `https://dummy.local/?${candidate}`
        );
      } catch (_innerError) {
        parsed = null;
      }
    }
    if (!parsed) {
      continue;
    }
    if (!details.authCode) {
      details.authCode = extractQueryValue(parsed, ["authCode", "authcode", "auth_code", "code"]);
    }
    if (!details.userId) {
      details.userId = extractQueryValue(parsed, ["userId", "userid", "user_id", "uid"]);
    }
  }
  return details;
}

function extractSessionId(payload) {
  if (!payload) {
    return "";
  }
  const fromObject = [
    payload.userSession,
    payload.user_session,
    payload.userSessionId,
    payload.sessionID,
    payload.sessionId,
    payload.session,
    payload?.data?.userSession,
    payload?.data?.user_session,
    payload?.data?.userSessionId,
    payload?.data?.sessionID,
    payload?.data?.sessionId,
    payload?.data?.session,
  ]
    .map((item) => String(item || "").trim())
    .find((item) => Boolean(item));
  if (fromObject) {
    return fromObject;
  }

  if (Array.isArray(payload)) {
    for (const row of payload) {
      const candidate = extractSessionId(row);
      if (candidate) {
        return candidate;
      }
    }
  }
  return "";
}

class RealAliceBlueClient {
  constructor(account) {
    this.account = account;
    const rootFromEnv = String(process.env.ALICE_BLUE_API_ROOT || "").trim();
    this.apiRoot = (rootFromEnv || "https://ant.aliceblueonline.com/rest/AliceBlueAPIService").replace(
      /\/+$/,
      ""
    );
    const apiBaseFromEnv = String(process.env.ALICE_BLUE_API_BASE || "").trim();
    this.apiBase = (apiBaseFromEnv || `${this.apiRoot}/api/`).replace(/\/?$/, "/");
    this.apiOrigin = String(process.env.ALICE_BLUE_ORIGIN || "https://a3.aliceblueonline.com")
      .trim()
      .replace(/\/+$/, "");
    this.openApiBase = String(process.env.ALICE_BLUE_OPEN_API_BASE || `${this.apiOrigin}/open-api/od/v1`)
      .trim()
      .replace(/\/+$/, "");
    const primarySsoUrl = String(process.env.ALICE_BLUE_SSO_URL || "").trim();
    const legacySsoUrl = String(process.env.ALICE_BLUE_LEGACY_SSO_URL || "").trim();
    this.ssoUrl = primarySsoUrl || `${this.openApiBase}/vendor/getUserDetails`;
    this.legacySsoUrl = legacySsoUrl || `${this.apiRoot}/sso/getUserDetails`;
    this.loginUrl = String(process.env.ALICE_BLUE_LOGIN_URL || "https://ant.aliceblueonline.com/").trim();
    this.userAgent = "CopyTrader Electron";
    this.instrumentCache = new Map();
  }

  get credentials() {
    return this.account.credentials || {};
  }

  patchCredentials(patch) {
    this.account.credentials = {
      ...this.credentials,
      ...patch,
    };
  }

  getAppCode() {
    return String(this.credentials.aliceAppCode || this.credentials.appCode || "").trim();
  }

  getApiSecret() {
    return String(
      this.credentials.aliceApiSecret || this.credentials.apiSecret || this.credentials.aliceApiKey || ""
    ).trim();
  }

  getRedirectUri() {
    return String(this.credentials.redirectUri || "").trim();
  }

  getApiUserId() {
    const fromCreds = String(this.credentials.aliceUserId || "").trim();
    const fromAccount = String(this.account.brokerUserId || "").trim();
    return fromCreds || fromAccount || this.account.userId || "";
  }

  getSessionId() {
    return (
      String(this.account.accessToken || "").trim() ||
      String(this.credentials.sessionId || this.credentials.userSession || "").trim() ||
      null
    );
  }

  isOpenApiUrl(url) {
    const value = String(url || "").toLowerCase();
    return value.includes("/open-api/");
  }

  authHeaderOrThrow(url = "") {
    const userId = this.getApiUserId();
    const sessionId = this.getSessionId();
    if (!sessionId) {
      throw new Error("Alice Blue login/session required");
    }
    if (this.isOpenApiUrl(url)) {
      return `Bearer ${sessionId}`;
    }
    if (!userId) {
      return `Bearer ${sessionId}`;
    }
    return `Bearer ${String(userId).toUpperCase()} ${sessionId}`;
  }

  getAuthorizeUrl() {
    const appCode = this.getAppCode();
    if (!appCode) {
      throw new Error("Alice Blue app code is required to build login URL");
    }
    let url;
    try {
      url = new URL(this.loginUrl);
    } catch (_error) {
      throw new Error("Alice Blue login URL is invalid");
    }
    url.searchParams.set("appcode", appCode);
    return url.toString();
  }

  getSearchUrls() {
    const endpointPath = "/DataApiService/v2/exchange/getScripForSearchAPI";
    const urls = [];

    const envUrl = String(process.env.ALICE_BLUE_SEARCH_URL || "").trim();
    if (envUrl) {
      urls.push(envUrl);
    }

    const fromApiBase = String(this.apiBase || "")
      .replace(/\/+$/, "")
      .replace(/\/AliceBlueAPIService\/api$/i, "");
    if (fromApiBase) {
      urls.push(`${fromApiBase}${endpointPath}`);
    }

    const fromApiRoot = String(this.apiRoot || "")
      .replace(/\/+$/, "")
      .replace(/\/AliceBlueAPIService$/i, "");
    if (fromApiRoot) {
      urls.push(`${fromApiRoot}${endpointPath}`);
    }

    try {
      const origin = new URL(this.loginUrl).origin.replace(/\/+$/, "");
      urls.push(`${origin}/rest${endpointPath}`);
      urls.push(`${origin}${endpointPath}`);
    } catch (_error) {
      // ignore
    }
    if (this.apiOrigin) {
      urls.push(`${this.apiOrigin}/rest${endpointPath}`);
      urls.push(`${this.apiOrigin}${endpointPath}`);
    }

    const cleaned = urls
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .map((item) => item.replace(/([^:]\/)\/+/g, "$1"));
    return [...new Set(cleaned)];
  }

  uniqueUrls(urls = []) {
    return [...new Set(urls.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  async request(method, url, { body, authenticated = true } = {}) {
    const headers = {
      "X-SAS-Version": "2.0",
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authenticated) {
      headers.Authorization = this.authHeaderOrThrow(url);
    }
    const startedAt = Date.now();
    let response;
    let text = "";

    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await response.text();
    } catch (error) {
      logApiCall({
        source: "broker-api",
        broker: "aliceblue",
        accountId: this.account?.id || null,
        durationMs: Date.now() - startedAt,
        request: {
          method,
          url,
          headers,
          body: body === undefined ? null : body,
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
      broker: "aliceblue",
      accountId: this.account?.id || null,
      durationMs: Date.now() - startedAt,
      request: {
        method,
        url,
        headers,
        body: body === undefined ? null : body,
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

  async requestAny(method, urls = [], { body, authenticated = true } = {}) {
    const targets = this.uniqueUrls(urls);
    if (!targets.length) {
      throw new Error("No Alice Blue endpoint URL provided");
    }
    const errors = [];
    for (const url of targets) {
      try {
        const response = await this.request(method, url, { body, authenticated });
        return { response, url };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        errors.push(`${url} -> ${message}`);
      }
    }
    throw new Error(errors.slice(0, 3).join(" | "));
  }

  async exchangeAuthCodeForSession({ userId, authCode }) {
    const normalizedUserId = String(userId || "").trim();
    const normalizedAuthCode = String(authCode || "").trim();
    const apiSecret = this.getApiSecret();
    if (!normalizedUserId || !normalizedAuthCode) {
      throw new Error("Alice Blue authCode and userId are required");
    }
    if (!apiSecret) {
      throw new Error("Alice Blue API Secret is required");
    }

    const checkSum = crypto
      .createHash("sha256")
      .update(`${normalizedUserId}${normalizedAuthCode}${apiSecret}`)
      .digest("hex");

    const endpoints = [this.ssoUrl, this.legacySsoUrl]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index);
    if (!endpoints.length) {
      throw new Error("Alice Blue SSO endpoint is not configured");
    }

    const errors = [];
    for (const endpoint of endpoints) {
      const isModernSso = endpoint.includes("/open-api/od/v1/vendor/getUserDetails");
      const payloads = isModernSso
        ? [{ checkSum }, { checksum: checkSum }]
        : [
            { checkSum },
            { checksum: checkSum },
            { userId: normalizedUserId, checkSum },
            { userId: normalizedUserId, checksum: checkSum },
            { userId: normalizedUserId, userData: checkSum },
            { userId: normalizedUserId, authCode: normalizedAuthCode, checkSum },
            { userId: normalizedUserId, authCode: normalizedAuthCode, checksum: checkSum },
          ];

      for (const body of payloads) {
        const bodyKeys = Object.keys(body).join(",") || "(empty)";
        try {
          const response = await this.request("POST", endpoint, {
            body,
            authenticated: false,
          });
          const sessionId = extractSessionId(response);
          if (sessionId) {
            return {
              userId: String(response?.userId || normalizedUserId).trim() || normalizedUserId,
              authCode: normalizedAuthCode,
              checkSum,
              sessionId,
              response,
              endpoint,
            };
          }
          errors.push(`${endpoint} [${bodyKeys}] -> Session token missing in getUserDetails response`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Unknown getUserDetails error";
          errors.push(`${endpoint} [${bodyKeys}] -> ${detail}`);
        }
      }
    }
    const tail = errors.filter(Boolean).slice(0, 4).join(" | ");
    throw new Error(`Alice Blue SSO session generation failed: ${tail || "No details"}`);
  }

  async getProfile() {
    const urls = [
      `${this.openApiBase}/profile/`,
      `${this.openApiBase}/profile`,
      `${this.apiBase}customer/accountDetails`,
    ];
    const { response } = await this.requestAny("GET", urls, {
      authenticated: true,
    });
    return response;
  }

  async login(options = {}) {
    if (options.aliceAppCode !== undefined || options.appCode !== undefined) {
      this.patchCredentials({
        aliceAppCode: String(options.aliceAppCode || options.appCode || "").trim(),
      });
    }
    if (
      options.aliceApiSecret !== undefined ||
      options.apiSecret !== undefined ||
      options.aliceApiKey !== undefined
    ) {
      this.patchCredentials({
        aliceApiSecret: String(options.aliceApiSecret || options.apiSecret || options.aliceApiKey || "").trim(),
      });
    }
    if (options.redirectUri !== undefined) {
      this.patchCredentials({
        redirectUri: String(options.redirectUri || "").trim(),
      });
    }
    if (options.userId !== undefined || options.aliceUserId !== undefined) {
      this.patchCredentials({
        aliceUserId: String(options.userId || options.aliceUserId || "").trim(),
      });
    }

    const directSession =
      String(options.accessToken || options.sessionId || options.userSession || "").trim() || null;
    if (directSession) {
      this.account.accessToken = directSession;
      this.patchCredentials({
        sessionId: directSession,
      });
    }

    if (!this.getSessionId()) {
      const parsed = parseAuthDetails(options);
      const authCode = String(parsed.authCode || "").trim();
      const userId = String(parsed.userId || this.getApiUserId() || "").trim();
      if (!authCode) {
        throw new Error(
          "Alice Blue authCode is required. Open Auth URL and paste redirect URL (with authCode and userId) in manual login."
        );
      }
      if (!userId) {
        throw new Error("Alice Blue userId is required for SSO session generation");
      }

      const session = await this.exchangeAuthCodeForSession({ userId, authCode });
      this.account.accessToken = session.sessionId;
      this.patchCredentials({
        sessionId: session.sessionId,
        aliceUserId: session.userId,
      });
    }

    const authUserId = String(this.getApiUserId() || "").trim();
    let profile = null;
    try {
      profile = await this.getProfile();
    } catch (_error) {
      profile = null;
    }
    const profileData =
      profile && typeof profile === "object" && !Array.isArray(profile) && profile.data && typeof profile.data === "object"
        ? profile.data
        : profile;
    const brokerUserId =
      String(
        profileData?.actid ||
          profileData?.accountId ||
          profileData?.uid ||
          profileData?.clientId ||
          profileData?.userId ||
          ""
      ).trim() || this.getApiUserId();
    const brokerUserName =
      String(profileData?.accountName || profileData?.name || profileData?.uname || "").trim() ||
      this.account.name;

    return {
      accessToken: this.getSessionId(),
      refreshToken: null,
      tokenExpiresAt: null,
      loginAt: new Date().toISOString(),
      userId: brokerUserId || this.account.userId,
      aliceUserId: authUserId || null,
      userName: brokerUserName || this.account.name,
      profile: profile || {},
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
    const parsedStrike = parseStrikeFromText(tradingSymbol);
    const strikePriceValue = toNumber(item.strikePrice, 0) || parsedStrike || null;
    const expiryValue = item.expiry || parseExpiryFromText(tradingSymbol) || null;
    return {
      exchange,
      segment: exchange,
      symbol,
      tradingSymbol,
      instrumentKey: `${exchange}|${token}`,
      token,
      type: inferType(item),
      lotSize,
      expiry: expiryValue,
      strikePrice: strikePriceValue,
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

    const searchUrls = this.getSearchUrls();
    const rows = [];
    const searchErrors = [];
    for (const exchange of exchanges) {
      const body = {
        symbol: query,
        exchange: [exchange],
      };

      const extractRows = (response) => {
        if (Array.isArray(response)) {
          return response;
        }
        if (Array.isArray(response?.data)) {
          return response.data;
        }
        if (Array.isArray(response?.result)) {
          return response.result;
        }
        if (Array.isArray(response?.values)) {
          return response.values;
        }
        return [];
      };

      let response = null;
      const exchangeErrors = [];
      for (const searchUrl of searchUrls) {
        try {
          // Some Alice environments may reject auth header for search,
          // while others allow/expect it.
          response = await this.request("POST", searchUrl, {
            body,
            authenticated: true,
          });
          break;
        } catch (authError) {
          const authMessage = authError instanceof Error ? authError.message : "auth search failed";
          try {
            response = await this.request("POST", searchUrl, {
              body,
              authenticated: false,
            });
            break;
          } catch (publicError) {
            const publicMessage =
              publicError instanceof Error ? publicError.message : "public search failed";
            exchangeErrors.push(`${searchUrl} -> ${authMessage}; ${publicMessage}`);
          }
        }
      }

      if (!response) {
        if (exchangeErrors.length) {
          searchErrors.push(`${exchange}: ${exchangeErrors.slice(0, 2).join(" | ")}`);
        }
        continue;
      }
      rows.push(...extractRows(response));
    }

    if (!rows.length && searchErrors.length) {
      throw new Error(`Alice Blue search failed: ${searchErrors.slice(0, 2).join(" | ")}`);
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

    let effectiveExpiry = expiryFilter;
    if (!effectiveExpiry) {
      const today = Date.now();
      const candidateExpiries = [...new Set(mapped
        .map((item) => String(item.expiry || "").trim())
        .filter(Boolean))];

      const sortedFutureExpiryDates = candidateExpiries
        .map((expiry) => ({ expiry, date: parseExpiryToDate(expiry) }))
        .filter((entry) => entry.date && entry.date.getTime() >= today)
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      if (sortedFutureExpiryDates.length > 0) {
        const firstExpiry = sortedFutureExpiryDates[0].expiry;
        effectiveExpiry = String(firstExpiry).trim().toUpperCase();
      }
    }

    return [...dedup.values()]
      .filter((item) => {
        if (typeFilter.length > 0 && !typeFilter.includes(item.type.toUpperCase())) {
          return false;
        }
        if (segmentFilter.length > 0 && !segmentFilter.some((seg) => item.segment.includes(seg))) {
          return false;
        }
        if (
          effectiveExpiry &&
          !String(item.expiry || "").toUpperCase().includes(effectiveExpiry)
        ) {
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

    const orderHint = parseOrderSymbolHint(symbol);
    const queryCandidates = [
      symbol,
      orderHint.underlying && orderHint.underlying !== symbol.toUpperCase() ? orderHint.underlying : "",
    ].filter(Boolean);

    const collected = [];
    for (const query of queryCandidates) {
      try {
        const results = await this.searchInstruments({
          query,
          exchange: order.exchange || "",
        });
        collected.push(...results);
      } catch (_error) {
        // keep trying fallbacks
      }
    }

    const unique = new Map();
    collected.forEach((item) => {
      if (item?.instrumentKey) {
        unique.set(item.instrumentKey, item);
      }
    });
    const results = [...unique.values()];
    if (!results.length) {
      return null;
    }

    const scored = results
      .map((item) => ({
        item,
        score: scoreInstrumentCandidate(orderHint, item, symbol),
      }))
      .sort((left, right) => right.score - left.score);

    const best = scored[0];
    if (best && best.score > 0) {
      return best.item;
    }

    const exact = results.find((item) => item.tradingSymbol.toUpperCase() === symbol.toUpperCase());
    return exact || results[0] || null;
  }

  async placeOrder(order) {
    const resolved = await this.resolveInstrument(order);
    if (!resolved) {
      throw new Error(`Alice Blue instrument not found for ${order.symbol || order.instrumentKey}`);
    }

    const prctyp = normalizeOrderType(order.orderType);
    const legacyPayload = {
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

    const modernOrderType = normalizeOpenApiOrderType(order.orderType, order.triggerPrice);
    const modernPayload = [
      {
        exchange: resolved.exchange,
        instrumentId: String(resolved.token),
        transactionType: String(order.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY",
        quantity: Math.max(1, Math.floor(toNumber(order.quantity, 0))),
        product: normalizeOpenApiProduct(order.productType),
        orderComplexity: "REGULAR",
        orderType: modernOrderType,
        validity: "DAY",
        price:
          modernOrderType === "LIMIT" || modernOrderType === "SL"
            ? String(toNumber(order.price, 0))
            : "0",
        slTriggerPrice: modernOrderType === "SL" ? String(toNumber(order.triggerPrice, 0)) : "",
        disclosedQuantity: "",
        marketProtectionPercent: "",
        targetLegPrice: "",
        slLegPrice: "",
        trailingSlAmount: "",
        apiOrderSource: "WEB",
        algoId: "",
        orderTag: "",
      },
    ];

    let response = null;
    const orderErrors = [];
    try {
      const modern = await this.requestAny(
        "POST",
        [`${this.openApiBase}/orders/placeorder`, `${this.openApiBase}/orders/placeorder/`],
        {
          body: modernPayload,
          authenticated: true,
        }
      );
      response = modern.response;
    } catch (error) {
      orderErrors.push(error instanceof Error ? error.message : "Modern place order failed");
      try {
        const legacy = await this.requestAny("POST", [`${this.apiBase}placeOrder/executePlaceOrder`], {
          body: legacyPayload,
          authenticated: true,
        });
        response = legacy.response;
      } catch (legacyError) {
        orderErrors.push(legacyError instanceof Error ? legacyError.message : "Legacy place order failed");
        throw new Error(orderErrors.slice(0, 2).join(" | "));
      }
    }

    const first = Array.isArray(response) ? response[0] : response;
    const firstData =
      first && typeof first === "object" && !Array.isArray(first) && first.data && typeof first.data === "object"
        ? first.data
        : first;
    const orderId = String(
      firstData?.brokerOrderId ||
        firstData?.orderId ||
        firstData?.NOrdNo ||
        firstData?.nOrdNo ||
        firstData?.nestOrderNumber ||
        firstData?.order_id ||
        response?.brokerOrderId ||
        response?.orderId ||
        ""
    ).trim();
    if (!orderId) {
      throw new Error("Alice Blue place order succeeded but order id is missing");
    }

    return {
      orderId,
      status: String(firstData?.stat || firstData?.status || response?.status || "Ok"),
      averagePrice: toNumber(firstData?.price, toNumber(legacyPayload.price, 0)),
      timestamp: new Date().toISOString(),
      raw: response,
    };
  }

  async cancelOrder(orderId) {
    try {
      const modern = await this.requestAny(
        "POST",
        [`${this.openApiBase}/orders/cancel`, `${this.openApiBase}/orders/cancel/`],
        {
          body: { brokerOrderId: String(orderId) },
          authenticated: true,
        }
      );
      return modern.response;
    } catch (_error) {
      const legacy = await this.requestAny("POST", [`${this.apiBase}placeOrder/cancelOrder`], {
        body: { nestOrderNumber: String(orderId) },
        authenticated: true,
      });
      return legacy.response;
    }
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
    let response = null;
    try {
      response = (
        await this.requestAny("GET", [`${this.openApiBase}/limits/`, `${this.openApiBase}/limits`], {
          authenticated: true,
        })
      ).response;
    } catch (_error) {
      response = (
        await this.requestAny("GET", [`${this.apiBase}limits/getRmsLimits`], {
          authenticated: true,
        })
      ).response;
    }
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.result)
          ? response.result
          : [];

    let total = 0;
    let available = 0;
    let utilized = 0;
    if (rows.length) {
      rows.forEach((row) => {
        total += firstFinite(row.net, row.total, row.totalMargin, row.availableMargin, 0) || 0;
        available +=
          firstFinite(
            row.cashmarginavailable,
            row.rmsPayInAmnt,
            row.available,
            row.availableCash,
            row.availableMargin,
            0
          ) || 0;
        utilized +=
          (firstFinite(row.varmargin, row.spanmargin, row.exposuremargin, row.used, row.utilized, 0) || 0);
      });
    } else if (response && typeof response === "object") {
      const totalCandidate = firstFinite(
        response.total,
        response.net,
        response.totalMargin,
        response.availableMargin
      );
      const availableCandidate = firstFinite(
        response.available,
        response.availableCash,
        response.cash,
        response.cashBalance,
        response.availableMargin
      );
      const utilizedCandidate = firstFinite(
        response.utilized,
        response.used,
        response.usedMargin,
        response.blocked,
        response.span,
        response.exposure
      );
      total = totalCandidate || 0;
      available = availableCandidate || 0;
      utilized = utilizedCandidate || 0;
    }

    if (total <= 0 && available > 0) {
      total = available + Math.max(0, utilized);
    }
    return {
      total: Number(total.toFixed(2)),
      available: Number(available.toFixed(2)),
      utilized: Number(utilized.toFixed(2)),
      raw: response,
    };
  }

  async getPnl() {
    let response = null;
    try {
      response = (
        await this.requestAny("GET", [`${this.openApiBase}/positions`, `${this.openApiBase}/positions/`], {
          authenticated: true,
        })
      ).response;
    } catch (_error) {
      response = (
        await this.requestAny("POST", [`${this.apiBase}positionAndHoldings/positionBook`], {
          body: { ret: "NET" },
          authenticated: true,
        })
      ).response;
    }

    const rows = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.result)
          ? response.result
          : [];
    let mtm = 0;
    const positions = [];

    rows.forEach((row) => {
      const netQty = Math.trunc(
        toNumber(
          row.Netqty,
          toNumber(
            row.netQty,
            toNumber(row.netQuantity, toNumber(row.quantity, toNumber(row.qty, 0)))
          )
        )
      );
      const avgPrice = toNumber(
        row.Buyavgprc,
        toNumber(row.averagePrice, toNumber(row.buyAvgPrice, toNumber(row.avgPrice, 0)))
      );
      const ltp = toNumber(
        row.LTP,
        toNumber(row.ltp, toNumber(row.lastTradedPrice, toNumber(row.lastPrice, avgPrice)))
      );
      const rowPnl = toNumber(
        row.MtoM,
        toNumber(row.mtm, toNumber(row.pnl, toNumber(row.unrealizedPnl, (ltp - avgPrice) * netQty)))
      );

      if (!netQty && !rowPnl) {
        return;
      }
      const symbol = String(
        row.Tsym || row.trading_symbol || row.tradingSymbol || row.symbol || row.scrip || ""
      ).trim();
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
