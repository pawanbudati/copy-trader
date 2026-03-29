const state = {
  accounts: [],
  openOrders: [],
  searchResults: [],
  dashboard: null,
  systemStatus: null,
  auditLogs: [],
  themeMode: "system",
};

const THEME_STORAGE_KEY = "alice-copy-trader-theme-mode";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

const ui = {
  accountForm: document.getElementById("account-form"),
  accName: document.getElementById("acc-name"),
  accUser: document.getElementById("acc-user"),
  accKey: document.getElementById("acc-key"),
  accRole: document.getElementById("acc-role"),
  accMultiplier: document.getElementById("acc-multiplier"),
  accMaxQty: document.getElementById("acc-maxqty"),
  accMaxLoss: document.getElementById("acc-maxloss"),
  accMinFunds: document.getElementById("acc-minfunds"),
  accFallback: document.getElementById("acc-fallback"),
  accMarginGuard: document.getElementById("acc-margin-guard"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  emergencyBtn: document.getElementById("emergency-btn"),
  emergencyPill: document.getElementById("emergency-pill"),
  accountsBody: document.getElementById("accounts-body"),
  loginAllBtn: document.getElementById("login-all-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  searchQuery: document.getElementById("search-query"),
  searchExchange: document.getElementById("search-exchange"),
  searchBtn: document.getElementById("search-btn"),
  searchResults: document.getElementById("search-results"),
  orderForm: document.getElementById("order-form"),
  ordExchange: document.getElementById("ord-exchange"),
  ordSymbol: document.getElementById("ord-symbol"),
  ordSide: document.getElementById("ord-side"),
  ordQty: document.getElementById("ord-qty"),
  ordType: document.getElementById("ord-type"),
  ordPrice: document.getElementById("ord-price"),
  ordProduct: document.getElementById("ord-product"),
  ordTarget: document.getElementById("ord-target"),
  ordStoploss: document.getElementById("ord-stoploss"),
  ordersList: document.getElementById("orders-list"),
  dashboardBody: document.getElementById("dashboard-body"),
  auditList: document.getElementById("audit-list"),
  toast: document.getElementById("toast"),
};

async function call(channel, payload = {}) {
  const response = await window.api.invoke(channel, payload);
  if (!response.ok) {
    throw new Error(response.error || "Unknown error");
  }
  return response.data;
}

function showToast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("error", isError);
  ui.toast.classList.remove("hidden");
  setTimeout(() => ui.toast.classList.add("hidden"), 3200);
}

function currency(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function themeModeList() {
  return ["system", "light", "dark"];
}

function getSavedThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (themeModeList().includes(saved)) {
      return saved;
    }
  } catch (_error) {
    // no-op
  }
  return "system";
}

function saveThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (_error) {
    // no-op when storage is not available
  }
}

function applyThemeMode(mode) {
  const normalized = themeModeList().includes(mode) ? mode : "system";
  state.themeMode = normalized;
  const actualTheme =
    normalized === "system" ? (themeMedia.matches ? "dark" : "light") : normalized;
  document.body.dataset.theme = actualTheme;
  ui.themeToggleBtn.textContent = `Theme: ${capitalize(normalized)}`;
}

function cycleThemeMode() {
  const modes = themeModeList();
  const index = modes.indexOf(state.themeMode);
  const next = modes[(index + 1) % modes.length];
  applyThemeMode(next);
  saveThemeMode(next);
}

function riskText(risk) {
  return [
    `x${risk.qtyMultiplier}`,
    `MaxQty:${risk.maxOrderQty || "NoLimit"}`,
    `Loss:${risk.maxDailyLoss || "NoLimit"}`,
    `Funds:${risk.marginGuardEnabled ? risk.minAvailableFunds : "GuardOff"}`,
  ].join(" | ");
}

function renderSystemStatus() {
  const emergencyOn = Boolean(state.systemStatus?.emergencyStopFollowers);
  if (emergencyOn) {
    ui.emergencyPill.textContent = "Follower copy STOPPED";
    ui.emergencyPill.classList.add("emergency");
    ui.emergencyBtn.textContent = "Resume Follower Copy";
  } else {
    ui.emergencyPill.textContent = "Follower copy ACTIVE";
    ui.emergencyPill.classList.remove("emergency");
    ui.emergencyBtn.textContent = "Emergency Stop Followers";
  }
}

function renderAccounts() {
  if (state.accounts.length === 0) {
    ui.accountsBody.innerHTML =
      "<tr><td colspan='7'>No accounts added yet.</td></tr>";
    return;
  }

  ui.accountsBody.innerHTML = state.accounts
    .map((acc) => {
      const statusClass = acc.status === "error" ? "pill error" : "pill";
      const roleClass = acc.role === "leader" ? "pill leader" : "pill";
      const actions = [
        `<button class="btn" data-action="login" data-id="${acc.id}">Login</button>`,
        `<button class="btn" data-action="leader" data-id="${acc.id}">Set Leader</button>`,
        `<button class="btn" data-action="risk" data-id="${acc.id}">Risk</button>`,
        `<button class="btn danger" data-action="remove" data-id="${acc.id}">Remove</button>`,
      ].join(" ");
      return `
        <tr>
          <td>${acc.name}</td>
          <td>${acc.userId}</td>
          <td><span class="${roleClass}">${acc.role}</span></td>
          <td><span class="${statusClass}">${acc.status}</span></td>
          <td><small>${riskText(acc.risk)}</small></td>
          <td>${acc.hasSession ? "Yes" : "No"}<br /><small>${acc.apiKeyMasked}</small></td>
          <td>${actions}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSearchResults() {
  if (!state.searchResults.length) {
    ui.searchResults.innerHTML = "<div class='item'><span>No search results.</span></div>";
    return;
  }

  ui.searchResults.innerHTML = state.searchResults
    .map(
      (item) => `
      <div class="item">
        <div>
          <strong>${item.symbol}</strong><br />
          <small>${item.exchange} | ${item.type || "N/A"} | token ${item.token}</small>
        </div>
        <button class="btn" data-action="pick-symbol" data-symbol="${item.symbol}" data-exchange="${item.exchange}">
          Use
        </button>
      </div>
    `
    )
    .join("");
}

function renderOpenOrders() {
  if (!state.openOrders.length) {
    ui.ordersList.innerHTML = "<div class='item'><span>No open leader orders.</span></div>";
    return;
  }

  ui.ordersList.innerHTML = state.openOrders
    .map((order) => {
      const followerInfo = order.followerStatus
        .map((item) => `${item.userId}: ${item.ok ? "OK" : "ERR"}`)
        .join(" | ");
      return `
        <div class="item">
          <div>
            <strong>${order.symbol}</strong>
            <small>${order.side} x ${order.quantity} | Leader: ${order.leaderUserId}</small><br />
            <small>${followerInfo || "No followers"}</small>
          </div>
          <button class="btn danger" data-action="exit-order" data-id="${order.leaderOrderId}">Exit All</button>
        </div>
      `;
    })
    .join("");
}

function renderDashboard() {
  if (!state.dashboard || !state.dashboard.accounts.length) {
    ui.dashboardBody.innerHTML =
      "<tr><td colspan='8'>No dashboard data available.</td></tr>";
    return;
  }

  ui.dashboardBody.innerHTML = state.dashboard.accounts
    .map((row) => {
      const positionsText = row.positions.length
        ? row.positions.map((p) => `${p.symbol}:${p.netQty}`).join(" | ")
        : "-";
      return `
      <tr>
        <td>${row.name}</td>
        <td>${row.userId}</td>
        <td>${row.role}</td>
        <td>${row.status}</td>
        <td>${currency(row.funds?.total)}</td>
        <td>${currency(row.funds?.available)}</td>
        <td>${currency(row.pnl)}</td>
        <td>${positionsText}</td>
      </tr>
    `;
    })
    .join("");
}

function renderAuditLogs() {
  if (!state.auditLogs.length) {
    ui.auditList.innerHTML = "<div class='item'><span>No audit entries yet.</span></div>";
    return;
  }

  ui.auditList.innerHTML = state.auditLogs
    .map((entry) => {
      const label = `${entry.type || "event"} | ${entry.timestamp || ""}`;
      const detail = entry.reason
        ? entry.reason
        : entry.userId
          ? `user ${entry.userId}`
          : entry.leaderOrderId
            ? `order ${entry.leaderOrderId}`
            : "";
      return `
        <div class="item">
          <div>
            <strong>${label}</strong><br />
            <small>${detail}</small>
          </div>
        </div>
      `;
    })
    .join("");
}

async function refreshSystemStatus() {
  state.systemStatus = await call("system:getStatus");
  renderSystemStatus();
}

async function refreshAccounts() {
  state.accounts = await call("accounts:list");
  renderAccounts();
}

async function refreshOrders() {
  state.openOrders = await call("orders:listOpen");
  renderOpenOrders();
}

async function refreshDashboard() {
  state.dashboard = await call("dashboard:get");
  renderDashboard();
}

async function refreshAudit() {
  state.auditLogs = await call("audit:getRecent", { limit: 80 });
  renderAuditLogs();
}

async function refreshAll() {
  await refreshSystemStatus();
  await refreshAccounts();
  await refreshOrders();
  await refreshDashboard();
  await refreshAudit();
}

async function promptAndUpdateRisk(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found for risk update");
  }

  const qtyMultiplier = window.prompt(
    `Qty multiplier for ${account.userId}`,
    String(account.risk.qtyMultiplier)
  );
  if (qtyMultiplier === null) {
    return false;
  }

  const maxOrderQty = window.prompt(
    `Max order qty (0 for no limit) for ${account.userId}`,
    String(account.risk.maxOrderQty)
  );
  if (maxOrderQty === null) {
    return false;
  }

  const maxDailyLoss = window.prompt(
    `Max daily loss INR (0 for no limit) for ${account.userId}`,
    String(account.risk.maxDailyLoss)
  );
  if (maxDailyLoss === null) {
    return false;
  }

  const minAvailableFunds = window.prompt(
    `Minimum available funds INR for margin guard (${account.userId})`,
    String(account.risk.minAvailableFunds)
  );
  if (minAvailableFunds === null) {
    return false;
  }

  const marketPriceFallback = window.prompt(
    `Market order fallback price per unit (${account.userId})`,
    String(account.risk.marketPriceFallback)
  );
  if (marketPriceFallback === null) {
    return false;
  }

  const marginGuardEnabled = window.confirm(
    `Enable margin guard for ${account.userId}? Click OK for enabled, Cancel for disabled.`
  );

  state.accounts = await call("accounts:updateRisk", {
    id: account.id,
    risk: {
      qtyMultiplier: toNumber(qtyMultiplier, account.risk.qtyMultiplier),
      maxOrderQty: toNumber(maxOrderQty, account.risk.maxOrderQty),
      maxDailyLoss: toNumber(maxDailyLoss, account.risk.maxDailyLoss),
      minAvailableFunds: toNumber(minAvailableFunds, account.risk.minAvailableFunds),
      marketPriceFallback: toNumber(marketPriceFallback, account.risk.marketPriceFallback),
      marginGuardEnabled,
    },
  });
  renderAccounts();
  return true;
}

ui.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.accounts = await call("accounts:add", {
      name: ui.accName.value,
      userId: ui.accUser.value,
      apiKey: ui.accKey.value,
      role: ui.accRole.value,
      risk: {
        qtyMultiplier: toNumber(ui.accMultiplier.value, 1),
        maxOrderQty: toNumber(ui.accMaxQty.value, 0),
        maxDailyLoss: toNumber(ui.accMaxLoss.value, 0),
        minAvailableFunds: toNumber(ui.accMinFunds.value, 0),
        marketPriceFallback: toNumber(ui.accFallback.value, 100),
        marginGuardEnabled: ui.accMarginGuard.checked,
      },
    });
    renderAccounts();
    ui.accountForm.reset();
    ui.accMultiplier.value = "1";
    ui.accMaxQty.value = "0";
    ui.accMaxLoss.value = "0";
    ui.accMinFunds.value = "0";
    ui.accFallback.value = "100";
    ui.accMarginGuard.checked = false;
    showToast("Account added");
    await refreshAudit();
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.accountsBody.addEventListener("click", async (event) => {
  const btn = event.target.closest("button");
  if (!btn) {
    return;
  }

  const action = btn.dataset.action;
  const id = btn.dataset.id;
  try {
    if (action === "login") {
      state.accounts = await call("accounts:login", { id });
      showToast("Account login completed");
    } else if (action === "leader") {
      state.accounts = await call("accounts:setLeader", { id });
      showToast("Leader updated");
    } else if (action === "risk") {
      const updated = await promptAndUpdateRisk(id);
      if (updated) {
        showToast("Risk updated");
      }
    } else if (action === "remove") {
      state.accounts = await call("accounts:remove", { id });
      showToast("Account removed");
    }
    renderAccounts();
    await refreshOrders();
    await refreshDashboard();
    await refreshAudit();
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.loginAllBtn.addEventListener("click", async () => {
  try {
    const result = await call("accounts:loginAll");
    const failed = result.filter((item) => !item.ok);
    if (failed.length) {
      showToast(`Login completed with ${failed.length} failures`, true);
    } else {
      showToast("All accounts logged in");
    }
    await refreshAll();
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.searchBtn.addEventListener("click", async () => {
  try {
    state.searchResults = await call("instruments:search", {
      query: ui.searchQuery.value,
      exchange: ui.searchExchange.value,
    });
    renderSearchResults();
    showToast(`Found ${state.searchResults.length} instruments`);
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.searchResults.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn || btn.dataset.action !== "pick-symbol") {
    return;
  }
  ui.ordSymbol.value = btn.dataset.symbol;
  ui.ordExchange.value = btn.dataset.exchange;
  showToast("Instrument copied to order form");
});

ui.orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const link = await call("orders:placeLeader", {
      exchange: ui.ordExchange.value,
      symbol: ui.ordSymbol.value,
      side: ui.ordSide.value,
      quantity: Number(ui.ordQty.value),
      orderType: ui.ordType.value,
      price: Number(ui.ordPrice.value),
      productType: ui.ordProduct.value,
      targetSpread: Number(ui.ordTarget.value),
      stoplossSpread: Number(ui.ordStoploss.value),
    });
    showToast(`Leader order ${link.leaderOrderId} processed`);
    await refreshOrders();
    await refreshDashboard();
    await refreshAudit();
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.ordersList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button");
  if (!btn || btn.dataset.action !== "exit-order") {
    return;
  }
  try {
    await call("orders:exitLeader", { leaderOrderId: btn.dataset.id });
    showToast("Exit copied to all followers");
    await refreshOrders();
    await refreshDashboard();
    await refreshAudit();
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshAll();
    showToast("Dashboard refreshed");
  } catch (error) {
    showToast(error.message, true);
  }
});

ui.themeToggleBtn.addEventListener("click", () => {
  cycleThemeMode();
});

ui.emergencyBtn.addEventListener("click", async () => {
  try {
    const currentlyOn = Boolean(state.systemStatus?.emergencyStopFollowers);
    let reason = null;
    if (!currentlyOn) {
      reason = window.prompt("Reason for emergency stop (optional)", "Manual emergency stop") || null;
    }

    state.systemStatus = await call("system:setEmergencyStop", {
      enabled: !currentlyOn,
      reason,
    });
    renderSystemStatus();
    showToast(currentlyOn ? "Follower copy resumed" : "Follower copy stopped");
    await refreshAudit();
  } catch (error) {
    showToast(error.message, true);
  }
});

themeMedia.addEventListener("change", () => {
  if (state.themeMode === "system") {
    applyThemeMode("system");
  }
});

applyThemeMode(getSavedThemeMode());

refreshAll().catch((error) => {
  showToast(error.message, true);
});
