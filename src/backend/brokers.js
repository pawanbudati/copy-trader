const BROKER_TYPES = {
  UPSTOX: "upstox",
  ALICE_BLUE: "aliceblue",
  KOTAK_NEO: "kotakneo",
};

function normalizeBrokerType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === BROKER_TYPES.ALICE_BLUE || raw === "alice_blue" || raw === "alice") {
    return BROKER_TYPES.ALICE_BLUE;
  }
  if (raw === BROKER_TYPES.KOTAK_NEO || raw === "kotak_neo" || raw === "kotak") {
    return BROKER_TYPES.KOTAK_NEO;
  }
  return BROKER_TYPES.UPSTOX;
}

function brokerLabel(type) {
  const normalized = normalizeBrokerType(type);
  if (normalized === BROKER_TYPES.ALICE_BLUE) {
    return "Alice Blue";
  }
  if (normalized === BROKER_TYPES.KOTAK_NEO) {
    return "Kotak Neo";
  }
  return "Upstox";
}

module.exports = {
  BROKER_TYPES,
  normalizeBrokerType,
  brokerLabel,
};
