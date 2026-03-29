const { contextBridge, ipcRenderer } = require("electron");

const channels = [
  "accounts:list",
  "accounts:add",
  "accounts:remove",
  "accounts:setLeader",
  "accounts:updateRisk",
  "accounts:login",
  "accounts:loginAll",
  "system:getStatus",
  "system:setEmergencyStop",
  "audit:getRecent",
  "instruments:search",
  "orders:placeLeader",
  "orders:exitLeader",
  "orders:listOpen",
  "dashboard:get",
];

contextBridge.exposeInMainWorld("api", {
  invoke: (channel, payload) => {
    if (!channels.includes(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, payload);
  },
});
