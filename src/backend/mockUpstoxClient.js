const crypto = require("crypto");

const accountState = new Map();

const baseInstruments = [
  {
    exchange: "NSE",
    segment: "NSE_INDEX",
    symbol: "NIFTY 50",
    tradingSymbol: "NIFTY 50",
    instrumentKey: "NSE_INDEX|Nifty 50",
    token: "NSE_INDEX|Nifty 50",
    type: "INDEX",
    lotSize: 1,
  },
  {
    exchange: "NSE",
    segment: "NSE_INDEX",
    symbol: "NIFTY BANK",
    tradingSymbol: "NIFTY BANK",
    instrumentKey: "NSE_INDEX|Nifty Bank",
    token: "NSE_INDEX|Nifty Bank",
    type: "INDEX",
    lotSize: 1,
  },
  {
    exchange: "NSE",
    segment: "NSE_INDEX",
    symbol: "NIFTY FIN SERVICE",
    tradingSymbol: "NIFTY FIN SERVICE",
    instrumentKey: "NSE_INDEX|Nifty Fin Service",
    token: "NSE_INDEX|Nifty Fin Service",
    type: "INDEX",
    lotSize: 1,
  },
];

const optionTemplates = ["NIFTY", "BANKNIFTY", "FINNIFTY"];

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function priceForSymbol(symbol) {
  const now = Date.now();
  const drift = Math.sin(now / 60000) * 0.008;
  const base = 100 + (hashCode(symbol) % 1800);
  return Number((base * (1 + drift)).toFixed(2));
}

function ensureState(accountId) {
  if (!accountState.has(accountId)) {
    accountState.set(accountId, {
      loggedIn: false,
      accessToken: null,
      orders: [],
      positions: new Map(),
      fundsBase: 200000 + (hashCode(accountId) % 350000),
    });
  }
  return accountState.get(accountId);
}

function buildOptionContracts() {
  const strikes = [22000, 22100, 22200, 22300, 22400, 22500];
  const expiry = "2026-04-30";
  const contracts = [];

  optionTemplates.forEach((indexName) => {
    strikes.forEach((strike) => {
      contracts.push({
        exchange: "NSE",
        segment: "NSE_FO",
        symbol: `${indexName} ${strike} CE`,
        tradingSymbol: `${indexName} ${strike} CE APR 26`,
        instrumentKey: `NSE_FO|${hashCode(`${indexName}-${strike}-CE`)}`,
        token: `NSE_FO|${hashCode(`${indexName}-${strike}-CE`)}`,
        type: "CE",
        lotSize: indexName === "BANKNIFTY" ? 15 : 50,
        expiry,
      });
      contracts.push({
        exchange: "NSE",
        segment: "NSE_FO",
        symbol: `${indexName} ${strike} PE`,
        tradingSymbol: `${indexName} ${strike} PE APR 26`,
        instrumentKey: `NSE_FO|${hashCode(`${indexName}-${strike}-PE`)}`,
        token: `NSE_FO|${hashCode(`${indexName}-${strike}-PE`)}`,
        type: "PE",
        lotSize: indexName === "BANKNIFTY" ? 15 : 50,
        expiry,
      });
    });
  });

  return contracts;
}

const instruments = [...baseInstruments, ...buildOptionContracts()];

class MockUpstoxClient {
  constructor(account) {
    this.account = account;
  }

  getAuthorizeUrl() {
    return `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(
      this.account.clientId || "mock-client-id"
    )}&redirect_uri=${encodeURIComponent(
      this.account.redirectUri || "https://example.com/callback"
    )}&state=${encodeURIComponent(`mock-${this.account.id}`)}`;
  }

  async login(options = {}) {
    const state = ensureState(this.account.id);
    const accessToken = options.accessToken || crypto.randomBytes(16).toString("hex");
    state.loggedIn = true;
    state.accessToken = accessToken;
    return {
      accessToken,
      refreshToken: null,
      loginAt: new Date().toISOString(),
      userId: this.account.userId || `MOCK_${this.account.id.slice(-4)}`,
      userName: this.account.name || "Mock User",
    };
  }

  async searchInstruments(payload = {}) {
    const query = (payload.query || "").trim().toUpperCase();
    const exchangeFilter = (payload.exchange || payload.exchanges || "").trim().toUpperCase();
    const segmentFilter = (payload.segments || "").trim().toUpperCase();
    const typeFilter = (payload.instrumentTypes || "").trim().toUpperCase();

    const filtered = instruments.filter((item) => {
      const exchangeMatch = !exchangeFilter || item.exchange.toUpperCase() === exchangeFilter;
      const segmentMatch = !segmentFilter || item.segment.toUpperCase().includes(segmentFilter);
      const typeMatch = !typeFilter || item.type.toUpperCase().includes(typeFilter);
      const text = `${item.symbol} ${item.tradingSymbol}`.toUpperCase();
      const textMatch = !query || text.includes(query);
      return exchangeMatch && segmentMatch && typeMatch && textMatch;
    });
    return filtered.slice(0, 60);
  }

  async placeOrder(order) {
    const state = ensureState(this.account.id);
    if (!state.loggedIn) {
      throw new Error(`Account ${this.account.userId} is not logged in`);
    }

    const now = new Date().toISOString();
    const fillPrice =
      order.orderType === "LIMIT" && Number(order.price) > 0
        ? Number(order.price)
        : priceForSymbol(order.symbol || order.instrumentKey);
    const direction = order.side === "BUY" ? 1 : -1;
    const qty = Number(order.quantity);
    const signedQty = direction * qty;

    const key = order.instrumentKey || `${order.exchange}:${order.symbol}`;
    const position = state.positions.get(key) || {
      key,
      symbol: order.symbol || order.instrumentKey,
      netQty: 0,
      avgPrice: 0,
    };

    const oldQty = position.netQty;
    const oldValue = position.avgPrice * oldQty;
    const newQty = oldQty + signedQty;
    let avgPrice = position.avgPrice;
    if (newQty !== 0) {
      avgPrice = (oldValue + fillPrice * signedQty) / newQty;
    } else {
      avgPrice = 0;
    }
    position.netQty = newQty;
    position.avgPrice = Number(avgPrice.toFixed(2));
    state.positions.set(key, position);

    const createdOrder = {
      orderId: `UPMOCK-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      accountId: this.account.id,
      userId: this.account.userId,
      symbol: order.symbol,
      instrumentKey: order.instrumentKey,
      side: order.side,
      quantity: qty,
      price: fillPrice,
      orderType: order.orderType,
      productType: order.productType,
      status: "COMPLETE",
      createdAt: now,
    };
    state.orders.push(createdOrder);

    return {
      orderId: createdOrder.orderId,
      status: createdOrder.status,
      averagePrice: createdOrder.price,
      timestamp: now,
    };
  }

  async exitByReference(reference) {
    const state = ensureState(this.account.id);
    if (!state.loggedIn) {
      throw new Error(`Account ${this.account.userId} is not logged in`);
    }
    if (reference?.order) {
      const reverseSide = reference.order.side === "BUY" ? "SELL" : "BUY";
      return this.placeOrder({
        ...reference.order,
        side: reverseSide,
        orderType: "MARKET",
        price: 0,
      });
    }

    const sourceOrder = state.orders.find((item) => item.orderId === reference.orderId);
    if (!sourceOrder) {
      throw new Error(`Order not found: ${reference.orderId}`);
    }
    const reverseSide = sourceOrder.side === "BUY" ? "SELL" : "BUY";
    return this.placeOrder({
      instrumentKey: sourceOrder.instrumentKey,
      symbol: sourceOrder.symbol,
      side: reverseSide,
      quantity: sourceOrder.quantity,
      orderType: "MARKET",
      productType: sourceOrder.productType,
      price: 0,
    });
  }

  async getFunds() {
    const state = ensureState(this.account.id);
    let used = 0;
    for (const position of state.positions.values()) {
      used += Math.abs(position.netQty * position.avgPrice);
    }
    const available = Math.max(state.fundsBase - used * 0.2, 10000);
    return {
      total: Number(state.fundsBase.toFixed(2)),
      available: Number(available.toFixed(2)),
      utilized: Number((state.fundsBase - available).toFixed(2)),
    };
  }

  async getPnl() {
    const state = ensureState(this.account.id);
    let mtm = 0;
    const positions = [];
    for (const position of state.positions.values()) {
      if (position.netQty === 0) {
        continue;
      }
      const ltp = priceForSymbol(position.symbol);
      const value = (ltp - position.avgPrice) * position.netQty;
      mtm += value;
      positions.push({
        symbol: position.symbol,
        netQty: position.netQty,
        avgPrice: position.avgPrice,
        ltp,
        pnl: Number(value.toFixed(2)),
      });
    }
    return {
      mtm: Number(mtm.toFixed(2)),
      positions,
    };
  }
}

module.exports = {
  MockUpstoxClient,
};
