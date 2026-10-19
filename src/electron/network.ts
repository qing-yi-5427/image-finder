import { BrowserWindow, session, type Session } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  officialArtworkURL,
  validateProxySettings,
  type ProxySettings,
  type SourceReply,
  type SourceNetworkStatus,
} from "../core/network-contract.js";
import { SourceAuthentication } from "../core/source-auth.js";
export class SourceNetwork {
  readonly session: Session;
  private proxy: ProxySettings = { mode: "system" };
  private authWindow: BrowserWindow | undefined;
  private authentication: SourceAuthentication;
  private closing = false;
  private loggingOut = false;
  private initialized = false;
  private cookieListener: (
    _event: Electron.Event,
    cookie: Electron.Cookie,
  ) => void;
  constructor(
    private dataDir: string,
    partition = "persist:image-finder-pixiv",
  ) {
    this.session = session.fromPartition(partition);
    this.authentication = new SourceAuthentication(this.session);
    this.cookieListener = (_event, cookie) => {
      if (
        !this.closing &&
        !this.loggingOut &&
        cookie.name === "PHPSESSID" &&
        /(^|\.)pixiv\.net$/.test(cookie.domain ?? "")
      )
        this.authentication.cookieChanged();
    };
    this.session.cookies.on("changed", this.cookieListener);
    this.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    this.session.setPermissionCheckHandler(() => false);
  }
  async initialize() {
    try {
      const value = JSON.parse(
        await readFile(join(this.dataDir, "network.json"), "utf8"),
      );
      validateProxySettings(value);
      await this.configure(value);
    } catch {
      await this.session.setProxy({ mode: "system" });
    }
    this.initialized = true;
    await this.authentication.initialize();
  }
  async configure(value: unknown) {
    validateProxySettings(value);
    await this.session.setProxy(
      value.mode === "custom"
        ? { mode: "fixed_servers", proxyRules: value.proxyRules }
        : { mode: value.mode },
    );
    await this.session.closeAllConnections();
    this.proxy = { ...value };
    await writeFile(
      join(this.dataDir, "network.json"),
      JSON.stringify(this.proxy),
    );
    if (this.initialized) {
      this.authentication.reset();
      if (this.authentication.snapshot().sessionPresent)
        this.authentication.schedule();
    }
    return this.status();
  }
  async status(): Promise<SourceNetworkStatus> {
    return {
      proxy: { ...this.proxy },
      ...this.authentication.snapshot(),
      loginWindowOpen: !!this.authWindow,
    };
  }
  async verify() {
    await this.authentication.verify(true);
    return this.status();
  }
  async close() {
    this.closing = true;
    this.session.cookies.removeListener("changed", this.cookieListener);
    this.authentication.close();
    this.authWindow?.close();
    await this.session.cookies.flushStore();
    await this.session.closeAllConnections();
  }
  async logout() {
    this.loggingOut = true;
    this.authentication.reset();
    try {
      this.authWindow?.close();
      await this.session.clearStorageData({
        storages: [
          "cookies",
          "localstorage",
          "indexdb",
          "serviceworkers",
          "cachestorage",
        ],
      });
      await this.session.cookies.flushStore();
      this.authentication.loggedOut();
    } catch {
      this.authentication.reset();
      await this.authentication.syncSession().catch(() => {});
      throw new Error("Pixiv 退出登录未完成，请重新验证会话状态。");
    } finally {
      this.loggingOut = false;
    }
    return this.status();
  }
  async connect() {
    if (this.authWindow) {
      this.authWindow.focus();
      return { opened: true };
    }
    const window = new BrowserWindow({
      width: 900,
      height: 760,
      title: "连接 Pixiv",
      webPreferences: {
        session: this.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.authWindow = window;
    const allowed = (value: string) => {
      try {
        const u = new URL(value);
        return (
          u.protocol === "https:" &&
          ["accounts.pixiv.net", "www.pixiv.net", "pixiv.net"].includes(
            u.hostname,
          ) &&
          !u.username &&
          !u.password
        );
      } catch {
        return false;
      }
    };
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    const verifyAfterNavigation = () => {
      if (!this.closing && !this.loggingOut) this.authentication.schedule();
    };
    window.webContents.on("did-finish-load", verifyAfterNavigation);
    window.webContents.on("did-navigate", verifyAfterNavigation);
    window.webContents.on("did-navigate-in-page", verifyAfterNavigation);
    window.on("closed", () => {
      this.authWindow = undefined;
      void this.session.cookies.flushStore();
      verifyAfterNavigation();
    });
    await window.loadURL("https://accounts.pixiv.net/login");
    return { opened: true };
  }
  async request(url: string): Promise<SourceReply> {
    if (!officialArtworkURL(url)) throw new Error("Source URL denied");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.session.fetch(url, {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const reader = response.body?.getReader();
      let body = "",
        bytes = 0;
      const decoder = new TextDecoder();
      if (reader)
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 4000000) throw new Error("Source response too large");
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          void reader.cancel().catch(() => {});
        }
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body,
      };
    } catch {
      throw new Error("Official source request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
