import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceAuthentication,
  type AuthSession,
} from "../src/core/source-auth.js";
import { PIXIV_AUTH_URL } from "../src/core/network-contract.js";
import { validateInvocation } from "../src/bridge.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const account = { id: "912345678909", name: "Private Fixture Name" };
const json = (userData: unknown) =>
  new Response(
    JSON.stringify({
      lang: "zh",
      services: {},
      userData,
      token: "private-token-fixture",
    }),
    { headers: { "content-type": "application/json" } },
  );
function fixture(
  fetcher?: (url: string, options: RequestInit) => Promise<Response>,
  options: any = {},
) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  let value = "private-cookie-fixture";
  const session: AuthSession = {
    cookies: { get: async () => (value ? [{ value }] : []) },
    fetch: async function (url, options) {
      assert.equal(this, session);
      calls.push({ url, options });
      return fetcher ? fetcher(url, options) : json(account);
    },
  };
  const auth = new SourceAuthentication(session, {
    debounceMs: 60000,
    ...options,
  });
  return {
    auth,
    calls,
    setCookie: (cookie: string) => {
      value = cookie;
    },
  };
}
test("same isolated session verifies the fixed own-session endpoint and never exports private data", async () => {
  const f = fixture();
  try {
    await f.auth.initialize();
    assert.equal(f.auth.snapshot().authState, "unknown");
    for (let i = 0; i < 20; i++) f.auth.snapshot();
    assert.equal(f.calls.length, 0);
    const status = await f.auth.verify();
    assert.equal(status.authState, "authenticated");
    assert.equal(status.authenticationVerified, true);
    assert.equal(status.sessionPresent, true);
    assert.equal(f.calls[0].url, PIXIV_AUTH_URL);
    assert.equal(f.calls[0].options.credentials, "include");
    assert.equal(f.calls[0].options.method, "GET");
    const serialized = JSON.stringify(status);
    for (const value of [
      account.id,
      account.name,
      "private-token-fixture",
      "private-cookie-fixture",
    ])
      assert.equal(serialized.includes(value), false);
    assert.ok(status.checkedAt);
  } finally {
    f.auth.close();
  }
});
test("manual refresh does a real check inside TTL while automatic verification coalesces", async () => {
  const f = fixture();
  try {
    await f.auth.verify();
    await f.auth.verify(false);
    assert.equal(f.calls.length, 1);
    await f.auth.verify(true);
    assert.equal(f.calls.length, 2);
  } finally {
    f.auth.close();
  }
});
test("anonymous refresh and expired saved sessions use explicit own-session userData:null", async () => {
  const f = fixture(async () => json(null));
  try {
    f.setCookie("");
    const anonymous = await f.auth.verify();
    assert.equal(f.calls.length, 1);
    assert.equal(anonymous.authState, "unauthenticated");
    assert.equal(anonymous.sessionPresent, false);
    f.setCookie("expired-fixture-cookie");
    const expired = await f.auth.verify();
    assert.equal(expired.authState, "unauthenticated");
    assert.equal(expired.sessionPresent, true);
    assert.equal(expired.error, null);
  } finally {
    f.auth.close();
  }
});
test("HTTP failures, challenges, HTML, oversized and public-user responses never claim session expiration", async () => {
  for (const response of [
    new Response("blocked", {
      status: 403,
      headers: { "content-type": "text/html" },
    }),
    new Response("unauthorized", { status: 401 }),
    new Response("limited", { status: 429 }),
    new Response("<html>Login challenge</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response(
      JSON.stringify({ error: false, body: { userId: account.id } }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const f = fixture(async () => response);
    try {
      const result = await f.auth.verify();
      assert.equal(result.authState, "network_error");
      assert.equal(result.authenticationVerified, false);
      assert.equal(result.sessionPresent, true);
      assert.ok(result.error);
      assert.equal(JSON.stringify(result).includes("Login challenge"), false);
    } finally {
      f.auth.close();
    }
  }
});
test("concurrent refresh is deduplicated and publishes checking while the real request is in flight", async () => {
  let release!: (response: Response) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    const a = f.auth.verify();
    const b = f.auth.verify();
    await sleep(0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.auth.snapshot().authState, "checking");
    release(json(account));
    assert.equal((await a).authState, "authenticated");
    assert.equal((await b).authState, "authenticated");
  } finally {
    f.auth.close();
  }
});
test("bounded timeout preserves session and differs from unauthenticated", async () => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 25 });
  try {
    const started = Date.now();
    const status = await f.auth.verify();
    assert.equal(status.authState, "network_error");
    assert.equal(status.error?.code, "timeout");
    assert.equal(status.sessionPresent, true);
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.calls[0].options.signal?.aborted, true);
  } finally {
    f.auth.close();
  }
});
test("a cookie generation change and logout reject stale authentication success", async () => {
  const releases: Array<(response: Response) => void> = [];
  const f = fixture(() => new Promise((resolve) => releases.push(resolve)));
  try {
    const old = f.auth.verify();
    await sleep(0);
    f.setCookie("new-session-cookie");
    f.auth.cookieChanged();
    await sleep(0);
    const current = f.auth.verify();
    await sleep(0);
    assert.equal(f.calls.length, 2);
    releases[0](json(account));
    await old;
    assert.notEqual(f.auth.snapshot().authState, "authenticated");
    releases[1](json(null));
    await current;
    assert.equal(f.auth.snapshot().authState, "unauthenticated");
    const later = f.auth.verify();
    await sleep(0);
    f.auth.loggedOut();
    releases[2](json(account));
    await later;
    assert.equal(f.auth.snapshot().authState, "unauthenticated");
    assert.equal(f.auth.snapshot().sessionPresent, false);
  } finally {
    f.auth.close();
  }
});
test("same-value renewal does not trigger a verification loop, actual changes debounce once", async () => {
  const f = fixture(undefined, { debounceMs: 15, ttlMs: 0 });
  try {
    await f.auth.verify();
    f.auth.cookieChanged();
    f.auth.cookieChanged();
    await sleep(40);
    assert.equal(f.calls.length, 1);
    f.setCookie("different");
    f.auth.cookieChanged();
    f.auth.cookieChanged();
    await sleep(50);
    assert.equal(f.calls.length, 2);
    for (let i = 0; i < 20; i++) f.auth.snapshot();
    assert.equal(f.calls.length, 2);
  } finally {
    f.auth.close();
  }
});
test("closing during an asynchronous cookie read prevents a new HTTP request", async () => {
  let release!: () => void;
  let calls = 0;
  const auth = new SourceAuthentication({
    cookies: {
      get: () =>
        new Promise((resolve) => {
          release = () => resolve([{ value: "cookie" }]);
        }),
    },
    fetch: async () => {
      calls++;
      return json(account);
    },
  });
  const work = auth.verify();
  auth.close();
  release();
  await work;
  assert.equal(calls, 0);
});
test("verify IPC accepts no arbitrary URL, identity or credentials", () => {
  validateInvocation("network.verify", {});
  for (const payload of [
    { url: "https://example.com" },
    { cookie: "secret" },
    { userId: "123" },
  ])
    assert.throws(() => validateInvocation("network.verify", payload));
});
test("late cookie reads cannot overwrite logout or start verification for a newer generation", async () => {
  for (const fail of [true, false]) {
    let release!: (cookies: Array<{ value: string }>) => void;
    let reject!: (error: Error) => void;
    let calls = 0;
    const auth = new SourceAuthentication({
      cookies: {
        get: () =>
          new Promise((resolve, fail) => {
            release = resolve;
            reject = fail;
          }),
      },
      fetch: async () => {
        calls++;
        return json(account);
      },
    });
    const work = auth.verify();
    auth.loggedOut();
    if (fail) reject(new Error("late read failure"));
    else release([{ value: "old-session" }]);
    await work;
    assert.equal(auth.snapshot().authState, "unauthenticated");
    assert.equal(auth.snapshot().sessionPresent, false);
    assert.equal(calls, 0);
    auth.close();
  }
});
