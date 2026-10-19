import type { TypedImageFinderClient } from "../api.js";
const { contextBridge, ipcRenderer } = require("electron");
const client: TypedImageFinderClient = {
  onAppEvent: (callback) => {
    if (typeof callback !== "function") throw new Error("Callback required");
    const listener = (_event:unknown, value:any) => {
      if (value?.type === "navigate" && ["tasks","settings"].includes(value.page)) callback(value);
      else if(value?.type === "power" && typeof value.status?.enabled === "boolean" && typeof value.status?.active === "boolean" && (value.status.error === null || typeof value.status.error === "string")) callback(value);
    };
    ipcRenderer.on("image-finder:app-event", listener);
    return () => ipcRenderer.removeListener("image-finder:app-event",listener);
  },
  invoke: (method, payload) =>
    ipcRenderer.invoke("image-finder:invoke", method, payload),
  onProgress: (callback) => {
    if (typeof callback !== "function") throw new Error("Callback required");
    const listener = (
      _event: unknown,
      status: Parameters<
        Parameters<TypedImageFinderClient["onProgress"]>[0]
      >[0],
    ) => callback(status);
    ipcRenderer.on("image-finder:progress", listener);
    return () => ipcRenderer.removeListener("image-finder:progress", listener);
  },
};
contextBridge.exposeInMainWorld("imageFinder", client);
