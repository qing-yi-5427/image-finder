import { requestSauce } from "../core/sauce-request.js";
import { safeStorage } from "electron";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
/** Credentials never enter the service worker or status DTOs. */
export class SauceNetwork {
  private key = "";
  private filename: string;
  constructor(dataDir: string) {
    this.filename = join(dataDir, "saucenao-key.encrypted");
  }
  async initialize() {
    try {
      if (safeStorage.isEncryptionAvailable())
        this.key = safeStorage.decryptString(await readFile(this.filename));
    } catch {
      this.key = "";
    }
  }
  status() {
    return { configured: !!this.key };
  }
  async configure(apiKey: string) {
    if (!apiKey) {
      this.key = "";
      await rm(this.filename, { force: true });
      return this.status();
    }
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(apiKey))
      throw new Error("SAUCE_INVALID_KEY");
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统密钥加密不可用");
    const tmp = this.filename + ".tmp";
    await writeFile(tmp, safeStorage.encryptString(apiKey));
    await rename(tmp, this.filename);
    this.key = apiKey;
    return this.status();
  }
  async request(preview: Uint8Array) {
    if (!this.key) throw new Error("SAUCE_NOT_CONFIGURED");
    if (
      !(preview instanceof Uint8Array) ||
      preview.byteLength < 10 ||
      preview.byteLength > 1024 * 1024
    )
      throw new Error("SAUCE_INVALID_PREVIEW");
    return requestSauce(this.key, preview);
  }
}
