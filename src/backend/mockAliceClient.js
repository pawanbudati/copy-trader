const crypto = require("crypto");

const accountState = new Map();

const baseInstruments = [
  { exchange: "INDICES", symbol: "NIFTY 50", token: "26000", type: "INDEX" },
  { exchange: "INDICES", symbol: "NIFTY BANK", token: "26009", type: "INDEX" },
  { exchange: "INDICES", symbol: "NIFTY FIN SERVICE", token: "26037", type: "INDEX" },
  { exchange: "INDICES", symbol: "SENSEX", token: "1", type: "INDEX" },
];

const optionTemplates = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
];

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
      sessionToken: null,
      orders: [],
      positions: new Map(),
      fundsBase: 150000 + (hashCode(accountId) % 200000),
    });
  }
  return accountState.get(accountId);
}

function buildOptionContracts() {
  const monthCode = "APR";
  const yearCode = "26";
  const strikes = [22000, 22100, 22200, 22300, 22400, 22500];
  const contracts = [];

  optionTemplates.forEach((indexName) => {
    strikes.forEach((strike) => {
      contracts.push({
        exchange: "NFO",
        symbol: `${indexName}${yearCode}${monthCode}${strike}CE`,
        token: `${hashCode(`${indexName}-${strike}-CE`)}`,
        type: "OPTION",
      });
      contracts.push({
        exchange: "NFO",
        symbol: `${indexName}${yearCode}${monthCode}${strike}PE`,
        token: `${hashCode(`${indexName}-${strike}-PE`)}`,
        type: "OPTION",
      });
    });
  });

  return contracts;
}

const instruments = [...baseInstruments, ...buildOptionContracts()];

class MockAliceClient {
  constructor(account) {
    this.account = account;
  }

  async login() {
    const state = ensureState(this.account.id);
    const sessionToken = crypto.randomBytes(16).toString("hex");
    state.loggedIn = true;
    state.sessionToken = sessionToken;
    return {
      sessionToken,
      loginAt: new Date().toISOString(),
    };
  }

  async searchInstruments({ query, exchange }) {
    const q = (query || "").trim().toUpperCase();
    const exch = (exchange || "").trim().toUpperCase();
    const filtered = instruments.filter((item) => {
      const exchangeMatch = !exch || item.exchange === exch;
      const textMatch = !q || item.symbol.toUpperCase().includes(q);
      return exchangeMatch && textMatch;
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
        : priceForSymbol(order.symbol);
    const direction = order.side === "BUY" ? 1 : -1;
    const qty = Number(order.quantity);
    const signedQty = direction * qty;

    const position = state.positions.get(order.symbol) || {
      symbol: order.symbol,
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
    state.positions.set(order.symbol, position);

    const createdOrder = {
      orderId: `MOCK-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      accountId: this.account.id,
      userId: this.account.userId,
      symbol: order.symbol,
      exchange: order.exchange,
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

    const sourceOrder = state.orders.find((item) => item.orderId === reference.orderId);
    if (!sourceOrder) {
      throw new Error(`Order not found: ${reference.orderId}`);
    }

    const reverseSide = sourceOrder.side === "BUY" ? "SELL" : "BUY";
    return this.placeOrder({
      exchange: sourceOrder.exchange,
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
  MockAliceClient,
};
