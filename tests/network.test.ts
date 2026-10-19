import { test } from "node:test";
import assert from "node:assert/strict";
import {
  officialArtworkURL,
  validateProxySettings,
} from "../src/core/network-contract.js";
import { validateInvocation } from "../src/bridge.js";
test("official transport URL is restricted and proxy settings never accept credentials", () => {
  assert.equal(
    officialArtworkURL("https://www.pixiv.net/ajax/illust/81470181?lang=zh"),
    true,
  );
  for (const url of [
    "http://www.pixiv.net/ajax/illust/81470181",
    "https://www.pixiv.net.evil.com/ajax/illust/81470181",
    "https://www.pixiv.net/ajax/illust/81470181?cookie=secret",
    "https://user:pass@www.pixiv.net/ajax/illust/81470181",
    "file:///C:/secret",
  ])
    assert.equal(officialArtworkURL(url), false);
  validateProxySettings({ mode: "system" });
  validateProxySettings({
    mode: "custom",
    proxyRules: "http://127.0.0.1:7890",
  });
  for (const config of [
    { mode: "custom", proxyRules: "http://user:pass@localhost:7890" },
    { mode: "custom", proxyRules: "localhost:99999" },
    { mode: "direct", proxyRules: "localhost:80" },
    { mode: "pac", proxyRules: "file:///x" },
  ])
    assert.throws(() => validateProxySettings(config));
  assert.throws(() =>
    validateInvocation("network.configure", {
      mode: "custom",
      proxyRules: "http://user:secret@localhost:8080",
    }),
  );
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceHost } from "../src/electron/service-host.js";
test("worker requests official source through injected host transport without exposing cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-broker-"));
  let requests = 0;
  const host = new ServiceHost(dir, async (url) => {
    assert.equal(officialArtworkURL(url), true);
    requests++;
    return {
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        error: false,
        body: {
          id: "81470181",
          illustTitle: "Mock",
          userId: "1",
          userName: "Author",
          pageCount: 1,
          tags: { tags: [{ tag: "original" }] },
        },
      }),
    };
  });
  try {
    await host.invoke("jobs.enqueue", { artworkIds: ["81470181"] });
    await host.invoke("jobs.resume");
    const deadline = Date.now() + 8000;
    let done = false;
    while (Date.now() < deadline) {
      const jobs = await host.invoke("jobs.list");
      if (jobs.items[0]?.status === "done") {
        done = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(done, true);
    assert.equal(requests, 1);
    await host.invoke("jobs.pause");
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
