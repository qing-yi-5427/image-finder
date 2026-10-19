import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceAuthentication,
  type AuthSession,
} from "../src/core/source-auth.js";

// Synthetic session only: these tests never use Electron's user partition or the network.
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const json = (authenticated = true) =>
  new Response(
    JSON.stringify({
      lang: "zh",
      services: {},
      userData: authenticated
        ? { id: "12345", name: "Synthetic account" }
        : null,
    }),
    { headers: { "content-type": "application/json" } },
  );
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

for (const action of ["logout", "close"] as const)
  for (const outcome of ["success", "failure"] as const)
    test(`cookie read ${outcome} arriving after ${action} preserves the complete latest snapshot and starts no GET`, async () => {
      const read = deferred<Array<{ value: string }>>();
      let held = false,
        fetches = 0;
      const auth = new SourceAuthentication(
        {
          cookies: {
            get: () =>
              held
                ? read.promise
                : Promise.resolve([{ value: "synthetic-session" }]),
          },
          fetch: async () => {
            fetches++;
            return json();
          },
        },
        { now: () => 123456, timeoutMs: 100 },
      );
      try {
        assert.equal((await auth.verify()).authState, "authenticated");
        held = true;
        const stale = auth.verify();
        if (action === "logout") auth.loggedOut();
        else auth.close();
        const latest = auth.snapshot();
        if (outcome === "success")
          read.resolve([{ value: "obsolete-session" }]);
        else read.reject(new Error("synthetic late cookie failure"));
        assert.deepEqual(await stale, latest);
        assert.deepEqual(auth.snapshot(), latest);
        assert.equal(
          fetches,
          1,
          "obsolete cookie reads must not issue a replacement verification",
        );
        if (action === "close") {
          assert.deepEqual(await auth.verify(), latest);
          assert.equal(fetches, 1);
        }
      } finally {
        auth.close();
      }
    });

test("same cookie renewal and cookie ordering storms neither invalidate an in-flight verification nor create another request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferred<Response>();
  let fetches = 0,
    cookieReads = 0,
    reversed = false;
  let signal: AbortSignal | null | undefined;
  const auth = new SourceAuthentication(
    {
      cookies: {
        get: async () => {
          cookieReads++;
          return (reversed ? ["same-b", "same-a"] : ["same-a", "same-b"]).map(
            (value) => ({ value }),
          );
        },
      },
      fetch: async (_url, options) => {
        fetches++;
        signal = options.signal;
        return response.promise;
      },
    },
    { debounceMs: 10, timeoutMs: 1000, ttlMs: 0 },
  );
  try {
    const check = auth.verify();
    await flush();
    assert.equal(fetches, 1);
    const checking = auth.snapshot();
    for (let i = 0; i < 30; i++) {
      reversed = !reversed;
      auth.cookieChanged();
    }
    await flush();
    assert.equal(cookieReads, 31);
    assert.equal(signal?.aborted, false);
    assert.deepEqual(auth.snapshot(), checking);
    t.mock.timers.tick(20);
    await flush();
    assert.equal(fetches, 1);
    response.resolve(json());
    await check;
    const verified = auth.snapshot();
    for (let i = 0; i < 30; i++) auth.cookieChanged();
    await flush();
    t.mock.timers.tick(20);
    await flush();
    assert.equal(fetches, 1);
    assert.deepEqual(auth.snapshot(), verified);
  } finally {
    response.resolve(json());
    auth.close();
  }
});

for (const outcome of ["success", "failure"] as const)
  test(`old fetch ${outcome} during a new cookie generation cannot publish or clear that generation's in-flight deduplication`, async () => {
    const old = deferred<Response>(),
      current = deferred<Response>();
    let cookie = "old",
      fetches = 0;
    const signals: Array<AbortSignal | null | undefined> = [];
    const auth = new SourceAuthentication(
      {
        cookies: { get: async () => [{ value: cookie }] },
        fetch: async (_url, options) => {
          signals.push(options.signal);
          fetches++;
          return fetches === 1 ? old.promise : current.promise;
        },
      },
      { now: () => 5000, timeoutMs: 500 },
    );
    try {
      const obsolete = auth.verify();
      await flush();
      assert.equal(fetches, 1);
      cookie = "new";
      await auth.syncSession();
      assert.equal(signals[0]?.aborted, true);
      const latest = auth.verify();
      await flush();
      assert.equal(fetches, 2);
      const checking = auth.snapshot();
      if (outcome === "success") old.resolve(json());
      else old.reject(new Error("synthetic stale fetch failure"));
      await obsolete;
      assert.deepEqual(auth.snapshot(), checking);
      const joined = auth.verify(true);
      await flush();
      assert.equal(
        fetches,
        2,
        "old finally must not clear the new pending request",
      );
      current.resolve(json(false));
      await Promise.all([latest, joined]);
      assert.deepEqual(auth.snapshot(), {
        sessionPresent: true,
        authenticationVerified: false,
        authState: "unauthenticated",
        checkedAt: 5000,
        error: null,
      });
    } finally {
      old.resolve(json());
      current.resolve(json(false));
      auth.close();
    }
  });

test("late fetch failure after logout cannot alter auth state, timestamp, session flag or error", async () => {
  const response = deferred<Response>();
  let fetches = 0,
    signal: AbortSignal | null | undefined;
  const auth = new SourceAuthentication(
    {
      cookies: { get: async () => [{ value: "old" }] },
      fetch: async (_url, options) => {
        fetches++;
        signal = options.signal;
        return response.promise;
      },
    },
    { now: () => 42, timeoutMs: 100 },
  );
  try {
    const work = auth.verify();
    await flush();
    auth.loggedOut();
    const loggedOut = auth.snapshot();
    assert.equal(signal?.aborted, true);
    response.reject(new Error("synthetic late response"));
    assert.deepEqual(await work, loggedOut);
    assert.deepEqual(auth.snapshot(), loggedOut);
    assert.equal(fetches, 1);
  } finally {
    response.resolve(json());
    auth.close();
  }
});

test("TTL boundary is exact, snapshot polling is read-only, and force bypasses TTL but joins an existing request", async () => {
  let now = 1000,
    fetches = 0,
    reads = 0;
  const slow = deferred<Response>();
  let hold = false;
  const session: AuthSession = {
    cookies: {
      get: async () => {
        reads++;
        return [{ value: "same" }];
      },
    },
    fetch: async () => {
      fetches++;
      return hold ? slow.promise : json();
    },
  };
  const auth = new SourceAuthentication(session, {
    now: () => now,
    ttlMs: 100,
    timeoutMs: 1000,
  });
  try {
    await auth.verify(false);
    assert.equal(fetches, 1);
    const beforePoll = { reads, fetches };
    for (let i = 0; i < 100; i++) auth.snapshot();
    assert.deepEqual({ reads, fetches }, beforePoll);
    now = 1099;
    await auth.verify(false);
    assert.equal(fetches, 1);
    now = 1100;
    await auth.verify(false);
    assert.equal(fetches, 2);
    now = 1101;
    await auth.verify(true);
    assert.equal(fetches, 3);
    hold = true;
    const forced = auth.verify(true);
    await flush();
    assert.equal(fetches, 4);
    const automatic = auth.verify(false),
      secondForced = auth.verify(true);
    await flush();
    assert.equal(fetches, 4);
    slow.resolve(json());
    await Promise.all([forced, automatic, secondForced]);
    assert.equal(auth.snapshot().authState, "authenticated");
    assert.equal(auth.snapshot().checkedAt, 1101);
  } finally {
    slow.resolve(json());
    auth.close();
  }
});

for (const outcome of ["authenticated", "unauthenticated", "failure"] as const)
  test(`a new-cookie event with a delayed cookie read blocks publication of the old fetch ${outcome}`, async () => {
    const nextCookies = deferred<Array<{ value: string }>>(),
      response = deferred<Response>();
    let reads = 0,
      fetches = 0;
    const auth = new SourceAuthentication(
      {
        cookies: {
          get: () =>
            ++reads === 1
              ? Promise.resolve([{ value: "old-cookie" }])
              : nextCookies.promise,
        },
        fetch: async () => {
          fetches++;
          return response.promise;
        },
      },
      { debounceMs: 60000, timeoutMs: 500 },
    );
    const obsolete = auth.verify();
    try {
      await flush();
      assert.equal(fetches, 1);
      assert.equal(auth.snapshot().authState, "checking");
      // The browser has already announced a new cookie, but reading its current
      // value is delayed. The preceding request must not publish in this gap.
      auth.cookieChanged();
      assert.equal(reads, 2);
      const afterEvent = auth.snapshot();
      if (outcome === "failure")
        response.reject(new Error("synthetic old-session network failure"));
      else response.resolve(json(outcome === "authenticated"));
      await flush();
      await flush();
      assert.deepEqual(
        auth.snapshot(),
        afterEvent,
        "a cookie-change read barrier must precede the final generation check and publication",
      );
      nextCookies.resolve([{ value: "new-cookie" }]);
      await obsolete;
      await flush();
      assert.equal(auth.snapshot().authState, "unknown");
      assert.equal(auth.snapshot().authenticationVerified, false);
      assert.equal(auth.snapshot().error, null);
    } finally {
      auth.close();
      nextCookies.resolve([{ value: "new-cookie" }]);
      response.resolve(json());
      await obsolete;
    }
  });
