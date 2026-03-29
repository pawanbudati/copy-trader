const state = {
  accounts: [],
  openOrders: [],
  searchResults: [],
  instrumentByKey: new Map(),
  favorites: [],
  dashboard: null,
  systemStatus: null,
  auditLogs: [],
  themeMode: "system",
  activeTab: "accounts",
};
const authPollers = new Map();
const SEARCH_DEBOUNCE_MS = 350;

let searchDebounceTimer = null;
let searchRequestSeq = 0;

const THEME_STORAGE_KEY = "upstox-copy-trader-theme-mode";
const FAVORITES_STORAGE_KEY = "upstox-copy-trader-favorites";
const TAB_STORAGE_KEY = "upstox-copy-trader-active-tab";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

const ui = {
  accountForm: document.getElementById("account-form"),
  accName: document.getElementById("acc-name"),
  accUser: document.getElementById("acc-user"),
  accBrokerType: document.getElementById("acc-broker-type"),
  brokerFieldGroups: document.querySelectorAll(".broker-fields-group"),
  accClientId: document.getElementById("acc-client-id"),
  accClientSecret: document.getElementById("acc-client-secret"),
  accRedirectUri: document.getElementById("acc-redirect-uri"),
  accAccessToken: document.getElementById("acc-access-token"),
  accAliceUserId: document.getElementById("acc-alice-user-id"),
  accAliceApiKey: document.getElementById("acc-alice-api-key"),
  accAliceSessionId: document.getElementById("acc-alice-session-id"),
  accKotakConsumerKey: document.getElementById("acc-kotak-consumer-key"),
  accKotakAccessToken: document.getElementById("acc-kotak-access-token"),
  accKotakSid: document.getElementById("acc-kotak-sid"),
  accKotakServerId: document.getElementById("acc-kotak-server-id"),
  accKotakBaseUrl: document.getElementById("acc-kotak-base-url"),
  accKotakUcc: document.getElementById("acc-kotak-ucc"),
  accKotakMobile: document.getElementById("acc-kotak-mobile"),
  accRole: document.getElementById("acc-role"),
  accQtyMode: document.getElementById("acc-qty-mode"),
  accMultiplier: document.getElementById("acc-multiplier"),
  accFixedQty: document.getElementById("acc-fixed-qty"),
  accMaxQty: document.getElementById("acc-maxqty"),
  accMaxLoss: document.getElementById("acc-maxloss"),
  accMinFunds: document.getElementById("acc-minfunds"),
  accFallback: document.getElementById("acc-fallback"),
  accMarginGuard: document.getElementById("acc-margin-guard"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  emergencyBtn: document.getElementById("emergency-btn"),
  emergencyPill: document.getElementById("emergency-pill"),
  topTabNav: document.getElementById("top-tab-nav"),
  accountsBody: document.getElementById("accounts-body"),
  loginAllBtn: document.getElementById("login-all-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  searchQuery: document.getElementById("search-query"),
  searchExchanges: document.getElementById("search-exchanges"),
  searchSegments: document.getElementById("search-segments"),
  searchTypes: document.getElementById("search-types"),
  searchExpiry: document.getElementById("search-expiry"),
  searchResults: document.getElementById("search-results"),
  favoritesList: document.getElementById("favorites-list"),
  orderForm: document.getElementById("order-form"),
  ordInstrumentKey: document.getElementById("ord-instrument-key"),
  ordSymbol: document.getElementById("ord-symbol"),
  ordLotSize: document.getElementById("ord-lot-size"),
  ordSide: document.getElementById("ord-side"),
  ordQty: document.getElementById("ord-qty"),
  ordType: document.getElementById("ord-type"),
  ordPrice: document.getElementById("ord-price"),
  ordProduct: document.getElementById("ord-product"),
  ordTarget: document.getElementById("ord-target"),
  ordStoploss: document.getElementById("ord-stoploss"),
  ordLotIndicator: document.getElementById("ord-lot-indicator"),
  ordersList: document.getElementById("orders-list"),
  dashboardBody: document.getElementById("dashboard-body"),
  auditList: document.getElementById("audit-list"),
  clearLogsBtn: document.getElementById("clear-logs-btn"),
  modalRoot: document.getElementById("app-modal"),
  modalOverlay: document.getElementById("modal-overlay"),
  modalTitle: document.getElementById("modal-title"),
  modalMessage: document.getElementById("modal-message"),
  modalInput: document.getElementById("modal-input"),
  modalFormFields: document.getElementById("modal-form-fields"),
  modalOkBtn: document.getElementById("modal-ok-btn"),
  modalCancelBtn: document.getElementById("modal-cancel-btn"),
  toast: document.getElementById("toast"),
};
const modalState = {
  resolver: null,
  mode: "confirm",
  lastFocus: null,
  fields: [],
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
  setTimeout(() => ui.toast.classList.add("hidden"), 3600);
}

function closeModalWithResult(result) {
  if (!modalState.resolver) {
    return;
  }
  const resolve = modalState.resolver;
  modalState.resolver = null;
  modalState.fields = [];
  ui.modalRoot.classList.add("hidden");
  ui.modalRoot.setAttribute("aria-hidden", "true");
  ui.modalInput.classList.add("hidden");
  ui.modalInput.type = "text";
  ui.modalInput.value = "";
  ui.modalInput.placeholder = "";
  ui.modalFormFields.classList.add("hidden");
  ui.modalFormFields.innerHTML = "";
  ui.modalOkBtn.classList.remove("danger");
  ui.modalOkBtn.classList.add("primary");
  resolve(result);

  if (modalState.lastFocus?.focus) {
    setTimeout(() => {
      modalState.lastFocus.focus({ preventScroll: true });
    }, 0);
  }
}

function openModalDialog({
  title,
  message,
  mode = "confirm",
  defaultValue = "",
  placeholder = "",
  inputType = "text",
  okLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
}) {
  if (modalState.resolver) {
    closeModalWithResult(mode === "prompt" ? null : false);
  }
  modalState.mode = mode;
  modalState.fields = [];
  modalState.lastFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ui.modalTitle.textContent = title || "";
  ui.modalMessage.textContent = message || "";
  ui.modalOkBtn.textContent = okLabel;
  ui.modalCancelBtn.textContent = cancelLabel;
  ui.modalOkBtn.classList.toggle("danger", Boolean(danger));
  ui.modalOkBtn.classList.toggle("primary", !danger);

  const isPrompt = mode === "prompt";
  ui.modalInput.classList.toggle("hidden", !isPrompt);
  ui.modalFormFields.classList.add("hidden");
  ui.modalFormFields.innerHTML = "";
  if (isPrompt) {
    ui.modalInput.type = inputType;
    ui.modalInput.placeholder = placeholder;
    ui.modalInput.value = String(defaultValue ?? "");
  }

  ui.modalRoot.classList.remove("hidden");
  ui.modalRoot.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    if (isPrompt) {
      ui.modalInput.focus({ preventScroll: true });
      ui.modalInput.select();
      return;
    }
    ui.modalOkBtn.focus({ preventScroll: true });
  }, 0);

  return new Promise((resolve) => {
    modalState.resolver = resolve;
  });
}

async function promptInput({
  title = "Input Required",
  message,
  defaultValue = "",
  placeholder = "",
  inputType = "text",
  okLabel = "Continue",
  cancelLabel = "Cancel",
}) {
  return openModalDialog({
    title,
    message,
    mode: "prompt",
    defaultValue,
    placeholder,
    inputType,
    okLabel,
    cancelLabel,
  });
}

async function confirmAction({
  title = "Please Confirm",
  message,
  okLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return openModalDialog({
    title,
    message,
    mode: "confirm",
    okLabel,
    cancelLabel,
    danger,
  });
}

function renderModalFormFields(fields) {
  ui.modalFormFields.innerHTML = fields
    .map((field) => {
      const type = field.type === "password" ? "password" : "text";
      const value = String(field.defaultValue ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const label = String(field.label || field.id || "Field")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const placeholder = String(field.placeholder || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `
        <label>
          ${label}
          <input
            type="${type}"
            data-modal-field="${field.id}"
            placeholder="${placeholder}"
            value="${value}"
          />
        </label>
      `;
    })
    .join("");
}

function collectModalFormFields() {
  const result = {};
  modalState.fields.forEach((field) => {
    const input = ui.modalFormFields.querySelector(`[data-modal-field="${field.id}"]`);
    result[field.id] = input ? String(input.value || "").trim() : "";
  });
  return result;
}

function promptFormFields({
  title = "Input Required",
  message = "",
  fields = [],
  okLabel = "Continue",
  cancelLabel = "Cancel",
}) {
  if (modalState.resolver) {
    closeModalWithResult(null);
  }
  modalState.mode = "form";
  modalState.fields = fields;
  modalState.lastFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  ui.modalTitle.textContent = title;
  ui.modalMessage.textContent = message;
  ui.modalOkBtn.textContent = okLabel;
  ui.modalCancelBtn.textContent = cancelLabel;
  ui.modalOkBtn.classList.remove("danger");
  ui.modalOkBtn.classList.add("primary");

  ui.modalInput.classList.add("hidden");
  ui.modalInput.value = "";
  renderModalFormFields(fields);
  ui.modalFormFields.classList.remove("hidden");

  ui.modalRoot.classList.remove("hidden");
  ui.modalRoot.setAttribute("aria-hidden", "false");

  setTimeout(() => {
    const firstInput = ui.modalFormFields.querySelector("input");
    if (firstInput) {
      firstInput.focus({ preventScroll: true });
      return;
    }
    ui.modalOkBtn.focus({ preventScroll: true });
  }, 0);

  return new Promise((resolve) => {
    modalState.resolver = resolve;
  });
}

async function promptAliceLoginDetails(account) {
  const response = await promptFormFields({
    title: "Alice Blue Login",
    message: `Provide Alice login details for ${account?.userId || "account"}. Leave blank to reuse saved values.`,
    okLabel: "Login",
    fields: [
      {
        id: "aliceUserId",
        label: "Alice User ID",
        placeholder: "AB1234",
      },
      {
        id: "aliceApiKey",
        label: "Alice API Key",
        type: "password",
      },
      {
        id: "sessionId",
        label: "Session ID (optional)",
        type: "password",
      },
    ],
  });
  if (response === null) {
    return null;
  }
  const sanitized = {};
  if (response.aliceUserId) {
    sanitized.aliceUserId = response.aliceUserId;
  }
  if (response.aliceApiKey) {
    sanitized.aliceApiKey = response.aliceApiKey;
  }
  if (response.sessionId) {
    sanitized.sessionId = response.sessionId;
    sanitized.accessToken = response.sessionId;
  }
  return sanitized;
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
    // ignore
  }
  return "system";
}

function saveThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (_error) {
    // ignore
  }
}

function normalizeFavoriteInstrument(item) {
  const instrumentKey = String(item?.instrumentKey || "").trim();
  if (!instrumentKey) {
    return null;
  }
  const tradingSymbol = String(item?.tradingSymbol || item?.symbol || instrumentKey).trim();
  return {
    instrumentKey,
    symbol: String(item?.symbol || tradingSymbol).trim(),
    tradingSymbol,
    exchange: String(item?.exchange || "").trim(),
    segment: String(item?.segment || "").trim(),
    type: String(item?.type || "").trim(),
    lotSize: toWholeNumber(item?.lotSize, 1),
  };
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => normalizeFavoriteInstrument(item))
      .filter((item) => Boolean(item));
  } catch (_error) {
    return [];
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch (_error) {
    // ignore
  }
}

function availableTabs() {
  return ["accounts", "search", "trade", "dashboard", "audit"];
}

function getSavedActiveTab() {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (availableTabs().includes(saved)) {
      return saved;
    }
  } catch (_error) {
    // ignore
  }
  return "accounts";
}

function saveActiveTab(tab) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch (_error) {
    // ignore
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

function normalizeBrokerType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["aliceblue", "alice", "alice_blue"].includes(raw)) {
    return "aliceblue";
  }
  if (["kotakneo", "kotak", "kotak_neo"].includes(raw)) {
    return "kotakneo";
  }
  return "upstox";
}

function setRequired(input, required) {
  if (!input) {
    return;
  }
  input.required = Boolean(required);
}

function applyBrokerFieldVisibility() {
  const brokerType = normalizeBrokerType(ui.accBrokerType.value);
  ui.brokerFieldGroups.forEach((group) => {
    const isActive = group.dataset.broker === brokerType;
    group.classList.toggle("hidden", !isActive);
  });

  setRequired(ui.accClientId, brokerType === "upstox");
  setRequired(ui.accAliceUserId, brokerType === "aliceblue");
  setRequired(ui.accAliceApiKey, brokerType === "aliceblue");
  setRequired(ui.accKotakConsumerKey, brokerType === "kotakneo");
}

function readCredentialsFromForm() {
  const brokerType = normalizeBrokerType(ui.accBrokerType.value);
  if (brokerType === "aliceblue") {
    return {
      aliceUserId: String(ui.accAliceUserId.value || "").trim(),
      aliceApiKey: String(ui.accAliceApiKey.value || "").trim(),
      sessionId: String(ui.accAliceSessionId.value || "").trim(),
    };
  }
  if (brokerType === "kotakneo") {
    return {
      consumerKey: String(ui.accKotakConsumerKey.value || "").trim(),
      accessToken: String(ui.accKotakAccessToken.value || "").trim(),
      tradingSid: String(ui.accKotakSid.value || "").trim(),
      serverId: String(ui.accKotakServerId.value || "").trim(),
      baseUrl: String(ui.accKotakBaseUrl.value || "").trim(),
      kotakUcc: String(ui.accKotakUcc.value || "").trim(),
      mobileNumber: String(ui.accKotakMobile.value || "").trim(),
    };
  }
  return {
    clientId: String(ui.accClientId.value || "").trim(),
    clientSecret: String(ui.accClientSecret.value || "").trim(),
    redirectUri: String(ui.accRedirectUri.value || "").trim(),
    accessToken: String(ui.accAccessToken.value || "").trim(),
  };
}

function resetBrokerInputs() {
  ui.accClientId.value = "";
  ui.accClientSecret.value = "";
  ui.accRedirectUri.value = "";
  ui.accAccessToken.value = "";
  ui.accAliceUserId.value = "";
  ui.accAliceApiKey.value = "";
  ui.accAliceSessionId.value = "";
  ui.accKotakConsumerKey.value = "";
  ui.accKotakAccessToken.value = "";
  ui.accKotakSid.value = "";
  ui.accKotakServerId.value = "";
  ui.accKotakBaseUrl.value = "";
  ui.accKotakUcc.value = "";
  ui.accKotakMobile.value = "";
}

function applyActiveTab(tab, shouldFocus = false) {
  const tabs = availableTabs();
  const selected = tabs.includes(tab) ? tab : "accounts";
  state.activeTab = selected;

  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === selected;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active && shouldFocus) {
      button.focus({ preventScroll: true });
    }
  });

  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === selected);
  });
}

function toWholeNumber(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function setOrderLotSize(lotSize) {
  ui.ordLotSize.value = String(toWholeNumber(lotSize, 1));
  updateOrderLotIndicator();
}

function updateOrderLotIndicator() {
  const lots = toWholeNumber(ui.ordQty.value, 1);
  const lotSize = toWholeNumber(ui.ordLotSize.value, 1);
  const finalQty = lots * lotSize;
  ui.ordLotIndicator.textContent = `Final Qty = ${lots} x ${lotSize} = ${finalQty}`;
}

function applyLotSizeFromSelectedInstrument() {
  const instrumentKey = String(ui.ordInstrumentKey.value || "").trim();
  if (!instrumentKey) {
    setOrderLotSize(1);
    return;
  }
  const selected = state.instrumentByKey.get(instrumentKey);
  if (selected) {
    setOrderLotSize(selected.lotSize || 1);
  }
}

function favoriteIndex(instrumentKey) {
  return state.favorites.findIndex((item) => item.instrumentKey === instrumentKey);
}

function isFavoriteInstrument(instrumentKey) {
  return favoriteIndex(instrumentKey) >= 0;
}

function findKnownInstrument(instrumentKey) {
  return (
    state.searchResults.find((item) => item.instrumentKey === instrumentKey) ||
    state.instrumentByKey.get(instrumentKey) ||
    state.favorites.find((item) => item.instrumentKey === instrumentKey) ||
    null
  );
}

function syncFavoritesToStorage() {
  saveFavorites(state.favorites);
}

function addFavoriteInstrument(source) {
  const favorite = normalizeFavoriteInstrument(source);
  if (!favorite || isFavoriteInstrument(favorite.instrumentKey)) {
    return false;
  }
  state.favorites.push(favorite);
  state.instrumentByKey.set(favorite.instrumentKey, favorite);
  syncFavoritesToStorage();
  renderFavorites();
  renderSearchResults();
  return true;
}

function removeFavoriteInstrument(instrumentKey) {
  const index = favoriteIndex(instrumentKey);
  if (index < 0) {
    return false;
  }
  state.favorites.splice(index, 1);
  syncFavoritesToStorage();
  renderFavorites();
  renderSearchResults();
  return true;
}

function riskText(risk) {
  const qtyText =
    risk.quantityMode === "fixed"
      ? `Fixed:${risk.fixedQuantity}`
      : `x${risk.qtyMultiplier}`;
  return [
    qtyText,
    `MaxQty:${risk.maxOrderQty || "NoLimit"}`,
    `Loss:${risk.maxDailyLoss || "NoLimit"}`,
    `Funds:${risk.marginGuardEnabled ? risk.minAvailableFunds : "GuardOff"}`,
  ].join(" | ");
}

function authFlowText(account) {
  if (!account.authFlow) {
    return "idle";
  }
  if (normalizeBrokerType(account.brokerType) !== "upstox" && account.authFlow.status === "idle") {
    return "manual";
  }
  return account.authFlow.status === "idle"
    ? "idle"
    : `${account.authFlow.status}${account.authFlow.message ? ` (${account.authFlow.message})` : ""}`;
}

function configText(account) {
  const flags = [];
  flags.push(account.clientIdMasked || "");
  flags.push(account.hasClientSecret ? "extra:set" : "extra:missing");
  flags.push(account.hasRedirectUri ? "url:set" : "url:n/a");
  return flags.join(" | ");
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

function accountActionIcon(action) {
  const icons = {
    auth: `
      <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 1 1 7 7L17 13" />
        <path d="M14 11a5 5 0 0 1 0 7L12.5 19.5a5 5 0 0 1-7-7L7 11" />
      </svg>
    `,
    login: `
      <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
        <path d="M10 17l5-5-5-5" />
        <path d="M15 12H3" />
      </svg>
    `,
    leader: `
      <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z" />
      </svg>
    `,
    risk: `
      <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l7 3v6c0 5-3.3 8.5-7 9-3.7-.5-7-4-7-9V6l7-3z" />
        <path d="M9.5 12.5 11 14l3.5-3.5" />
      </svg>
    `,
    remove: `
      <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <rect x="6" y="7" width="12" height="13" rx="2" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    `,
  };
  return icons[action] || "";
}

function accountActionButton({ action, id, label, danger = false, disabled = false }) {
  const classes = danger ? "btn icon-btn danger" : "btn icon-btn";
  return `
    <button
      class="${classes}${disabled ? " disabled" : ""}"
      type="button"
      ${disabled ? "" : `data-action="${action}" data-id="${id}"`}
      title="${label}"
      aria-label="${label}"
      ${disabled ? "disabled" : ""}
    >
      ${accountActionIcon(action)}
    </button>
  `;
}

function renderAccounts() {
  if (!state.accounts.length) {
    ui.accountsBody.innerHTML = "<tr><td colspan='11'>No accounts added yet.</td></tr>";
    return;
  }

  ui.accountsBody.innerHTML = state.accounts
    .map((acc) => {
      const statusClass = acc.status === "error" ? "pill error" : "pill";
      const roleClass = acc.role === "leader" ? "pill leader" : "pill";
      const brokerType = normalizeBrokerType(acc.brokerType);
      const supportsAuthUrl = brokerType === "upstox";
      const actions = [
        accountActionButton({
          action: "auth",
          id: acc.id,
          label: supportsAuthUrl ? "Open Auth URL" : "Auth URL not supported for this broker",
          disabled: !supportsAuthUrl,
        }),
        accountActionButton({ action: "login", id: acc.id, label: "Manual Login" }),
        accountActionButton({ action: "leader", id: acc.id, label: "Set as Leader" }),
        accountActionButton({ action: "risk", id: acc.id, label: "Edit Risk Rules" }),
        accountActionButton({
          action: "remove",
          id: acc.id,
          label: "Remove Account",
          danger: true,
        }),
      ].join(" ");
      return `
        <tr>
          <td>${acc.name}</td>
          <td>${acc.userId}</td>
          <td>${acc.brokerLabel || brokerType}</td>
          <td>${acc.brokerUserId || "-"}</td>
          <td><span class="${roleClass}">${acc.role}</span></td>
          <td><span class="${statusClass}">${acc.status}</span></td>
          <td><small>${authFlowText(acc)}</small></td>
          <td><small>${configText(acc)}</small></td>
          <td><small>${riskText(acc.risk)}</small></td>
          <td>${acc.hasSession ? "Yes" : "No"}</td>
          <td><div class="account-actions">${actions}</div></td>
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
    .map((item) => {
      const favorite = isFavoriteInstrument(item.instrumentKey);
      return `
      <div class="item">
        <div>
          <strong>${item.tradingSymbol || item.symbol}</strong><br />
          <small>${item.exchange} | ${item.segment || "-"} | ${item.type || "-"} | lot ${item.lotSize || "-"}</small><br />
          <small>${item.instrumentKey}</small>
        </div>
        <div class="item-actions">
          <button class="btn" data-action="pick-instrument" data-key="${item.instrumentKey}" data-symbol="${item.tradingSymbol || item.symbol}" data-lot-size="${item.lotSize || 1}">
            Use
          </button>
          <button class="btn" data-action="toggle-favorite" data-key="${item.instrumentKey}">
            ${favorite ? "Unfav" : "Fav"}
          </button>
        </div>
      </div>
    `
    })
    .join("");
}

function renderFavorites() {
  if (!state.favorites.length) {
    ui.favoritesList.innerHTML = "<div class='item'><span>No favorites saved.</span></div>";
    return;
  }

  ui.favoritesList.innerHTML = state.favorites
    .map(
      (item) => `
      <div class="item">
        <div>
          <strong>${item.tradingSymbol || item.symbol}</strong><br />
          <small>${item.exchange || "-"} | ${item.segment || "-"} | ${item.type || "-"} | lot ${item.lotSize || "-"}</small><br />
          <small>${item.instrumentKey}</small>
        </div>
        <div class="item-actions">
          <button class="btn" data-action="pick-favorite" data-key="${item.instrumentKey}" data-symbol="${item.tradingSymbol || item.symbol}" data-lot-size="${item.lotSize || 1}">
            Use
          </button>
          <button class="btn danger" data-action="remove-favorite" data-key="${item.instrumentKey}">
            Remove
          </button>
        </div>
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
            <strong>${order.symbol}</strong><br />
            <small>${order.instrumentKey}</small><br />
            <small>${order.side} x ${order.quantity}${order.lotSize ? ` (${order.lots || 1} lot x ${order.lotSize})` : ""} | Leader: ${order.leaderUserId}</small><br />
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
    ui.dashboardBody.innerHTML = "<tr><td colspan='8'>No dashboard data available.</td></tr>";
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
      const detail =
        entry.reason ||
        (entry.userId ? `user ${entry.userId}` : entry.leaderOrderId ? `order ${entry.leaderOrderId}` : "");
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
  state.auditLogs = await call("audit:getRecent", { limit: 100 });
  renderAuditLogs();
}

async function refreshAll() {
  await refreshSystemStatus();
  await refreshAccounts();
  await refreshOrders();
  await refreshDashboard();
  await refreshAudit();
}

function stopAuthPolling(accountId) {
  if (!authPollers.has(accountId)) {
    return;
  }
  clearInterval(authPollers.get(accountId));
  authPollers.delete(accountId);
}

function startAuthPolling(accountId) {
  stopAuthPolling(accountId);
  const timer = setInterval(async () => {
    try {
      const status = await call("accounts:getAuthFlowStatus", { id: accountId });
      if (status.status === "success") {
        stopAuthPolling(accountId);
        showToast("Auto login successful");
        await refreshAll();
        return;
      }
      if (["error", "timed_out", "cancelled"].includes(status.status)) {
        stopAuthPolling(accountId);
        showToast(`Auto auth ${status.status}: ${status.message || "no details"}`, true);
        await refreshAll();
      }
    } catch (_error) {
      stopAuthPolling(accountId);
    }
  }, 2000);
  authPollers.set(accountId, timer);
}

async function promptAndUpdateRisk(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found for risk update");
  }

  const qtyMultiplier = await promptInput({
    title: "Risk: Quantity Multiplier",
    message: `Qty multiplier for ${account.userId}`,
    defaultValue: String(account.risk.qtyMultiplier),
    placeholder: "e.g. 1 or 1.5",
    okLabel: "Next",
  });
  if (qtyMultiplier === null) {
    return false;
  }
  const quantityMode = await promptInput({
    title: "Risk: Quantity Mode",
    message: `Quantity mode for ${account.userId} (multiplier/fixed)`,
    defaultValue: String(account.risk.quantityMode || "multiplier"),
    placeholder: "multiplier or fixed",
    okLabel: "Next",
  });
  if (quantityMode === null) {
    return false;
  }
  const fixedQuantity = await promptInput({
    title: "Risk: Fixed Quantity",
    message: `Fixed quantity when mode=fixed (${account.userId})`,
    defaultValue: String(account.risk.fixedQuantity || 1),
    okLabel: "Next",
  });
  if (fixedQuantity === null) {
    return false;
  }
  const maxOrderQty = await promptInput({
    title: "Risk: Max Order Qty",
    message: `Max order qty (0 for no limit) for ${account.userId}`,
    defaultValue: String(account.risk.maxOrderQty),
    okLabel: "Next",
  });
  if (maxOrderQty === null) {
    return false;
  }
  const maxDailyLoss = await promptInput({
    title: "Risk: Max Daily Loss",
    message: `Max daily loss INR (0 for no limit) for ${account.userId}`,
    defaultValue: String(account.risk.maxDailyLoss),
    okLabel: "Next",
  });
  if (maxDailyLoss === null) {
    return false;
  }
  const minAvailableFunds = await promptInput({
    title: "Risk: Min Funds",
    message: `Minimum available funds INR for margin guard (${account.userId})`,
    defaultValue: String(account.risk.minAvailableFunds),
    okLabel: "Next",
  });
  if (minAvailableFunds === null) {
    return false;
  }
  const marketPriceFallback = await promptInput({
    title: "Risk: Market Fallback",
    message: `Market order fallback price per unit (${account.userId})`,
    defaultValue: String(account.risk.marketPriceFallback),
    okLabel: "Next",
  });
  if (marketPriceFallback === null) {
    return false;
  }
  const marginGuardEnabled = await confirmAction({
    title: "Risk: Margin Guard",
    message: `Enable margin guard for ${account.userId}?`,
    okLabel: "Enable",
    cancelLabel: "Disable",
  });

  state.accounts = await call("accounts:updateRisk", {
    id: account.id,
    risk: {
      quantityMode:
        String(quantityMode).toLowerCase() === "fixed" ? "fixed" : "multiplier",
      qtyMultiplier: toNumber(qtyMultiplier, account.risk.qtyMultiplier),
      fixedQuantity: toNumber(fixedQuantity, account.risk.fixedQuantity),
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

function parseLoginHint(hint, brokerType = "upstox") {
  const raw = String(hint || "").trim();
  if (!raw) {
    return {};
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (_error) {
      // continue to fallback parsing
    }
  }
  const normalizedBroker = normalizeBrokerType(brokerType);
  if (normalizedBroker === "kotakneo" && raw.includes("|")) {
    const [accessToken, tradingSid, serverId] = raw.split("|").map((item) => item.trim());
    return {
      accessToken: accessToken || "",
      tradingSid: tradingSid || "",
      serverId: serverId || "",
    };
  }
  if (normalizedBroker !== "upstox") {
    return { accessToken: raw };
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return { redirectedUrl: raw };
  }
  if (raw.includes("code=")) {
    return { authCode: raw };
  }
  if (raw.length > 80) {
    return { accessToken: raw };
  }
  return { authCode: raw };
}

function restoreAccountFormFocus() {
  setTimeout(() => {
    window.focus();
    if (state.activeTab === "accounts" && ui.accName) {
      ui.accName.focus({ preventScroll: true });
      return;
    }
    if (state.activeTab === "audit" && ui.clearLogsBtn) {
      ui.clearLogsBtn.focus({ preventScroll: true });
      return;
    }
    const activeTabBtn = ui.topTabNav?.querySelector(`button[data-tab="${state.activeTab}"]`);
    if (activeTabBtn) {
      activeTabBtn.focus({ preventScroll: true });
    }
  }, 0);
}

ui.modalOkBtn.addEventListener("click", () => {
  if (!modalState.resolver) {
    return;
  }
  if (modalState.mode === "prompt") {
    closeModalWithResult(ui.modalInput.value);
    return;
  }
  if (modalState.mode === "form") {
    closeModalWithResult(collectModalFormFields());
    return;
  }
  closeModalWithResult(true);
});

ui.modalCancelBtn.addEventListener("click", () => {
  if (!modalState.resolver) {
    return;
  }
  closeModalWithResult(
    modalState.mode === "prompt" || modalState.mode === "form" ? null : false
  );
});

ui.modalOverlay.addEventListener("click", () => {
  if (!modalState.resolver) {
    return;
  }
  closeModalWithResult(
    modalState.mode === "prompt" || modalState.mode === "form" ? null : false
  );
});

ui.modalRoot.addEventListener("keydown", (event) => {
  if (!modalState.resolver) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeModalWithResult(
      modalState.mode === "prompt" || modalState.mode === "form" ? null : false
    );
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    if (event.target === ui.modalCancelBtn) {
      return;
    }
    event.preventDefault();
    if (modalState.mode === "prompt") {
      closeModalWithResult(ui.modalInput.value);
      return;
    }
    if (modalState.mode === "form") {
      closeModalWithResult(collectModalFormFields());
      return;
    }
    closeModalWithResult(true);
  }
});

function buildSearchPayload() {
  return {
    query: String(ui.searchQuery.value || "").trim(),
    exchanges: String(ui.searchExchanges.value || "").trim(),
    segments: String(ui.searchSegments.value || "").trim(),
    instrumentTypes: String(ui.searchTypes.value || "").trim(),
    expiry: String(ui.searchExpiry.value || "").trim(),
  };
}

function hasSearchCriteria(payload) {
  return Object.values(payload).some((value) => Boolean(value));
}

function setSearchResults(results) {
  state.searchResults = results;
  state.searchResults.forEach((item) => {
    if (item.instrumentKey) {
      state.instrumentByKey.set(item.instrumentKey, item);
    }
  });
  renderSearchResults();
}

async function performInstrumentSearch() {
  const payload = buildSearchPayload();
  const requestSeq = ++searchRequestSeq;
  if (!hasSearchCriteria(payload)) {
    setSearchResults([]);
    return;
  }

  try {
    const results = await call("instruments:search", payload);
    if (requestSeq !== searchRequestSeq) {
      return;
    }
    setSearchResults(results);
  } catch (error) {
    if (requestSeq !== searchRequestSeq) {
      return;
    }
    showToast(error.message, true);
  }
}

function scheduleInstrumentSearch() {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    performInstrumentSearch();
  }, SEARCH_DEBOUNCE_MS);
}

ui.accBrokerType.addEventListener("change", () => {
  applyBrokerFieldVisibility();
});

ui.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const brokerType = normalizeBrokerType(ui.accBrokerType.value);
    const credentials = readCredentialsFromForm();
    const accessToken =
      brokerType === "aliceblue"
        ? credentials.sessionId
        : brokerType === "kotakneo"
          ? credentials.accessToken
          : credentials.accessToken;

    state.accounts = await call("accounts:add", {
      name: ui.accName.value,
      userId: ui.accUser.value,
      brokerType,
      credentials,
      accessToken,
      role: ui.accRole.value,
      risk: {
        quantityMode: ui.accQtyMode.value,
        qtyMultiplier: toNumber(ui.accMultiplier.value, 1),
        fixedQuantity: toNumber(ui.accFixedQty.value, 1),
        maxOrderQty: toNumber(ui.accMaxQty.value, 0),
        maxDailyLoss: toNumber(ui.accMaxLoss.value, 0),
        minAvailableFunds: toNumber(ui.accMinFunds.value, 0),
        marketPriceFallback: toNumber(ui.accFallback.value, 100),
        marginGuardEnabled: ui.accMarginGuard.checked,
      },
    });
    renderAccounts();
    ui.accountForm.reset();
    resetBrokerInputs();
    ui.accBrokerType.value = "upstox";
    applyBrokerFieldVisibility();
    ui.accQtyMode.value = "multiplier";
    ui.accMultiplier.value = "1";
    ui.accFixedQty.value = "1";
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
  if (!action || !id) {
    return;
  }
  try {
    if (action === "auth") {
      await call("accounts:startAuthFlow", { id, openBrowser: true });
      startAuthPolling(id);
      showToast("Browser opened. Waiting for callback...");
      return;
    }

    if (action === "login") {
      const selectedAccount = state.accounts.find((item) => item.id === id);
      const brokerType = normalizeBrokerType(selectedAccount?.brokerType);
      let loginPayload = { id };

      if (brokerType === "aliceblue") {
        const aliceDetails = await promptAliceLoginDetails(selectedAccount);
        if (aliceDetails === null) {
          return;
        }
        loginPayload = {
          ...loginPayload,
          ...aliceDetails,
        };
      } else {
        const messageByBroker = {
          upstox:
            "Paste auth code, full redirect URL, or access token. Keep blank to reuse saved token.",
          kotakneo:
            "Paste JSON (accessToken,tradingSid,serverId,consumerKey) or token|sid|serverId. Keep blank to reuse saved credentials.",
        };
        const hint = await promptInput({
          title: "Manual Login Input",
          message: messageByBroker[brokerType] || messageByBroker.upstox,
          defaultValue: "",
          okLabel: "Login",
        });
        if (hint === null) {
          return;
        }
        loginPayload = {
          ...loginPayload,
          ...parseLoginHint(hint, brokerType),
        };
      }
      state.accounts = await call("accounts:login", loginPayload);
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

ui.topTabNav.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-tab]");
  if (!btn) {
    return;
  }
  const tab = btn.dataset.tab;
  applyActiveTab(tab);
  saveActiveTab(tab);
});

ui.topTabNav.addEventListener("keydown", (event) => {
  const tabs = availableTabs();
  const currentIndex = tabs.indexOf(state.activeTab);
  if (currentIndex < 0) {
    return;
  }
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const tab = tabs[nextIndex];
  applyActiveTab(tab, true);
  saveActiveTab(tab);
});

ui.searchQuery.addEventListener("input", scheduleInstrumentSearch);
ui.searchExpiry.addEventListener("input", scheduleInstrumentSearch);
ui.searchExchanges.addEventListener("change", scheduleInstrumentSearch);
ui.searchSegments.addEventListener("change", scheduleInstrumentSearch);
ui.searchTypes.addEventListener("change", scheduleInstrumentSearch);

ui.searchResults.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) {
    return;
  }
  const action = btn.dataset.action;
  const instrumentKey = String(btn.dataset.key || "").trim();

  if (action === "pick-instrument") {
    ui.ordInstrumentKey.value = instrumentKey;
    ui.ordSymbol.value = btn.dataset.symbol;
    setOrderLotSize(btn.dataset.lotSize);
    showToast("Instrument copied to order form");
    return;
  }

  if (action === "toggle-favorite") {
    if (!instrumentKey) {
      return;
    }
    if (isFavoriteInstrument(instrumentKey)) {
      if (removeFavoriteInstrument(instrumentKey)) {
        showToast("Removed from favorites");
      }
      return;
    }
    const known = findKnownInstrument(instrumentKey);
    if (addFavoriteInstrument(known)) {
      showToast("Added to favorites");
    } else {
      showToast("Unable to add favorite", true);
    }
  }
});

ui.favoritesList.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) {
    return;
  }

  const action = btn.dataset.action;
  const instrumentKey = String(btn.dataset.key || "").trim();
  if (!instrumentKey) {
    return;
  }

  if (action === "pick-favorite") {
    const favorite = findKnownInstrument(instrumentKey);
    if (!favorite) {
      showToast("Favorite instrument not found", true);
      return;
    }
    ui.ordInstrumentKey.value = favorite.instrumentKey;
    ui.ordSymbol.value = favorite.tradingSymbol || favorite.symbol || favorite.instrumentKey;
    setOrderLotSize(favorite.lotSize || 1);
    showToast("Favorite copied to order form");
    return;
  }

  if (action === "remove-favorite") {
    if (removeFavoriteInstrument(instrumentKey)) {
      showToast("Favorite removed");
    }
  }
});

ui.ordQty.addEventListener("input", () => {
  updateOrderLotIndicator();
});

ui.ordInstrumentKey.addEventListener("change", () => {
  applyLotSizeFromSelectedInstrument();
});

ui.orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const lots = toWholeNumber(ui.ordQty.value, 1);
    const lotSize = toWholeNumber(ui.ordLotSize.value, 1);
    const finalQuantity = lots * lotSize;
    const link = await call("orders:placeLeader", {
      instrumentKey: ui.ordInstrumentKey.value,
      symbol: ui.ordSymbol.value,
      side: ui.ordSide.value,
      quantity: finalQuantity,
      lots,
      lotSize,
      orderType: ui.ordType.value,
      price: Number(ui.ordPrice.value),
      productType: ui.ordProduct.value,
      targetSpread: Number(ui.ordTarget.value),
      stoplossSpread: Number(ui.ordStoploss.value),
    });
    showToast(`Leader order ${link.leaderOrderId} processed (${lots} lot x ${lotSize} = ${finalQuantity})`);
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

ui.clearLogsBtn.addEventListener("click", async () => {
  try {
    const confirmed = await confirmAction({
      title: "Clear Audit Logs",
      message: "Clear all audit logs?",
      okLabel: "Clear",
      cancelLabel: "Keep",
      danger: true,
    });
    if (!confirmed) {
      restoreAccountFormFocus();
      return;
    }
    await call("audit:clear");
    await refreshAudit();
    showToast("Audit logs cleared");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    restoreAccountFormFocus();
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
      const reasonInput = await promptInput({
        title: "Emergency Stop",
        message: "Reason for emergency stop (optional)",
        defaultValue: "Manual emergency stop",
        okLabel: "Stop Followers",
        cancelLabel: "Cancel",
      });
      if (reasonInput === null) {
        return;
      }
      reason = String(reasonInput || "").trim() || null;
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
applyActiveTab(getSavedActiveTab());
applyBrokerFieldVisibility();
state.favorites = loadFavorites();
state.favorites.forEach((item) => {
  if (item.instrumentKey) {
    state.instrumentByKey.set(item.instrumentKey, item);
  }
});
renderFavorites();
setOrderLotSize(ui.ordLotSize.value || 1);

refreshAll().catch((error) => {
  showToast(error.message, true);
});
