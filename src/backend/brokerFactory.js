const { RealUpstoxClient } = require("./upstoxClient");
const { RealAliceBlueClient } = require("./aliceBlueClient");
const { RealKotakNeoClient } = require("./kotakNeoClient");
const { MockBrokerClient } = require("./mockBrokerClient");
const { BROKER_TYPES, normalizeBrokerType } = require("./brokers");

function createBrokerClient(account) {
  const useMock = process.env.USE_MOCK_BROKER == "true";
  if (useMock) {
    return new MockBrokerClient(account);
  }

  const brokerType = normalizeBrokerType(account?.brokerType);
  if (brokerType === BROKER_TYPES.ALICE_BLUE) {
    return new RealAliceBlueClient(account);
  }
  if (brokerType === BROKER_TYPES.KOTAK_NEO) {
    return new RealKotakNeoClient(account);
  }
  return new RealUpstoxClient(account);
}

module.exports = {
  createBrokerClient,
};
