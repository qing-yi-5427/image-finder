import { createHash } from "node:crypto";
import {
  PIXIV_AUTH_URL,
  type SourceNetworkStatus,
} from "./network-contract.js";
type AuthState = Pick<
  SourceNetworkStatus,
  | "sessionPresent"
  | "authenticationVerified"
  | "authState"
  | "checkedAt"
  | "error"
>;
export interface AuthSession {
  cookies: {
    get(filter: {
      domain: string;
      name: string;
    }): Promise<Array<{ value: string }>>;
  };
  fetch(url: string, options: RequestInit): Promise<Response>;
}
class VerificationFailure extends Error {
  constructor(
    readonly code: NonNullable<SourceNetworkStatus["error"]>["code"],
    message: string,
  ) {
    super(message);
  }
}
/** Cached authentication status. Only explicit/triggered verify performs an HTTP request. */
export class SourceAuthentication {
  private state: AuthState = {
    sessionPresent: false,
    authenticationVerified: false,
    authState: "unknown",
    checkedAt: null,
    error: null,
  };
  private generation = 0;
  private checkedGeneration = -1;
  private fingerprint: string | undefined;
  private pending: {
    generation: number;
    controller: AbortController;
    promise: Promise<AuthState>;
  } | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private cookieReads = new Set<Promise<void>>();
  constructor(
    private session: AuthSession,
    private options: {
      timeoutMs?: number;
      ttlMs?: number;
      debounceMs?: number;
      now?: () => number;
    } = {},
  ) {}
  snapshot(): AuthState {
    return {
      ...this.state,
      error: this.state.error ? { ...this.state.error } : null,
    };
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private invalidate() {
    this.generation++;
    this.pending?.controller.abort();
    this.state = {
      ...this.state,
      authenticationVerified: false,
      authState: "unknown",
      checkedAt: null,
      error: null,
    };
  }
  private async readSession() {
    const generation = this.generation;
    const cookies = await this.session.cookies.get({
      domain: ".pixiv.net",
      name: "PHPSESSID",
    });
    if (this.closed || generation !== this.generation) return null;
    const fingerprint = createHash("sha256")
      .update(
        cookies
          .map((cookie) => cookie.value)
          .sort()
          .join("\0"),
      )
      .digest("hex");
    const changed =
      this.fingerprint !== undefined
        ? fingerprint !== this.fingerprint
        : this.state.sessionPresent !== cookies.length > 0;
    if (this.fingerprint !== undefined && changed) this.invalidate();
    this.fingerprint = fingerprint;
    this.state.sessionPresent = cookies.length > 0;
    return { changed };
  }
  async initialize() {
    await this.readSession();
    if (this.state.sessionPresent) this.schedule();
  }
  async syncSession() {
    await this.readSession();
    return this.snapshot();
  }
  cookieChanged() {
    if (this.closed) return;
    const generation = this.generation;
    const read = this.readSession()
      .then((result) => {
        if (result?.changed && !this.closed) this.schedule();
      })
      .catch(() => {
        if (!this.closed && generation === this.generation) {
          this.invalidate();
          this.state = {
            ...this.state,
            authState: "network_error",
            checkedAt: this.now(),
            error: {
              code: "network",
              message: "无法重新读取来源会话，请稍后验证。",
            },
          };
        }
      })
      .finally(() => this.cookieReads.delete(read));
    this.cookieReads.add(read);
  }
  private async waitForCookieReads(
    controller: AbortController,
    deadline: number,
  ) {
    while (
      this.cookieReads.size &&
      !this.closed &&
      !controller.signal.aborted
    ) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            cleanup();
            reject(
              new VerificationFailure(
                "timeout",
                "来源会话验证超时，现有会话已保留。",
              ),
            );
          },
          Math.max(1, deadline - Date.now()),
        );
        const aborted = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", aborted);
        };
        controller.signal.addEventListener("abort", aborted, { once: true });
        void Promise.allSettled([...this.cookieReads]).then(() => {
          cleanup();
          resolve();
        });
      });
    }
  }
  schedule() {
    if (this.closed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.verify(false).catch(() => {});
    }, this.options.debounceMs ?? 500);
    this.debounce.unref?.();
  }
  reset() {
    this.invalidate();
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }
  loggedOut() {
    this.reset();
    this.state = {
      sessionPresent: false,
      authenticationVerified: false,
      authState: "unauthenticated",
      checkedAt: this.now(),
      error: null,
    };
    this.checkedGeneration = this.generation;
    this.fingerprint = undefined;
  }
  async verify(force = true): Promise<AuthState> {
    if (this.closed) return this.snapshot();
    const entryGeneration = this.generation;
    try {
      const result = await this.readSession();
      if (!result) return this.snapshot();
    } catch {
      if (!this.closed && this.generation === entryGeneration)
        this.state = {
          ...this.state,
          authenticationVerified: false,
          authState: "network_error",
          checkedAt: this.now(),
          error: {
            code: "network",
            message: "无法读取本地来源会话，请稍后重试。",
          },
        };
      return this.snapshot();
    }
    if (this.closed) return this.snapshot();
    const generation = this.generation;
    if (this.pending?.generation === generation) return this.pending.promise;
    if (
      !force &&
      this.checkedGeneration === generation &&
      this.state.checkedAt !== null &&
      this.now() - this.state.checkedAt < (this.options.ttlMs ?? 8000)
    )
      return this.snapshot();
    this.state = {
      ...this.state,
      authState: "checking",
      authenticationVerified: false,
      error: null,
    };
    const controller = new AbortController();
    const deadline = Date.now() + (this.options.timeoutMs ?? 15000);
    const request = {
      generation,
      controller,
      promise: Promise.resolve(this.snapshot()),
    };
    request.promise = this.check(controller)
      .then(async (authState) => {
        await this.waitForCookieReads(controller, deadline);
        if (!this.closed && this.generation === generation) {
          this.checkedGeneration = generation;
          this.state = {
            ...this.state,
            authState,
            authenticationVerified: authState === "authenticated",
            checkedAt: this.now(),
            error: null,
          };
        }
        return this.snapshot();
      })
      .catch(async (error: unknown) => {
        try {
          await this.waitForCookieReads(controller, deadline);
        } catch (failure) {
          error = failure;
        }
        if (!this.closed && this.generation === generation) {
          const failure =
            error instanceof VerificationFailure
              ? error
              : new VerificationFailure(
                  "network",
                  "无法连接 Pixiv，现有会话已保留。",
                );
          this.checkedGeneration = generation;
          this.state = {
            ...this.state,
            authState: "network_error",
            authenticationVerified: false,
            checkedAt: this.now(),
            error: { code: failure.code, message: failure.message },
          };
        }
        return this.snapshot();
      })
      .finally(() => {
        if (this.pending === request) this.pending = null;
      });
    this.pending = request;
    return request.promise;
  }
  private async check(
    controller: AbortController,
  ): Promise<"authenticated" | "unauthenticated"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new VerificationFailure(
            "timeout",
            "Pixiv 验证超时，现有会话已保留。",
          ),
        );
      }, this.options.timeoutMs ?? 15000);
    });
    const work = (async () => {
      const response = await this.session.fetch(PIXIV_AUTH_URL, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Referer: "https://www.pixiv.net/",
        },
      });
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location) {
            try {
              const url = new URL(location, PIXIV_AUTH_URL);
              if (
                url.protocol === "https:" &&
                url.hostname === "accounts.pixiv.net" &&
                url.pathname === "/login"
              )
                return "unauthenticated" as const;
            } catch {}
          }
          throw new VerificationFailure(
            "invalid_response",
            "Pixiv 返回了未识别的验证跳转，现有会话已保留。",
          );
        }
        if (response.status === 403)
          throw new VerificationFailure(
            "challenge",
            "Pixiv 暂时拒绝了验证请求，可能需要在登录窗口完成网站验证；现有会话已保留。",
          );
        if (response.status !== 200)
          throw new VerificationFailure(
            "http",
            `Pixiv 验证暂不可用（HTTP ${response.status}），现有会话已保留。`,
          );
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("application/json")
        )
          throw new VerificationFailure(
            "invalid_response",
            "Pixiv 未返回可识别的登录状态，现有会话已保留。",
          );
        const reader = response.body?.getReader();
        let bytes = 0,
          text = "";
        const decoder = new TextDecoder();
        try {
          while (reader) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 65536)
              throw new VerificationFailure(
                "invalid_response",
                "Pixiv 验证响应超出限制，现有会话已保留。",
              );
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          void reader?.cancel().catch(() => {});
        }
        let value: any;
        try {
          value = JSON.parse(text);
        } catch {
          throw new VerificationFailure(
            "invalid_response",
            "Pixiv 返回了无法识别的验证响应，现有会话已保留。",
          );
        }
        // Validate the own-session bootstrap schema; never treat a public user's page as login proof.
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof value.lang === "string" &&
          value.services &&
          typeof value.services === "object" &&
          Object.hasOwn(value, "userData")
        ) {
          if (value.userData === null) return "unauthenticated" as const;
          if (
            value.userData &&
            typeof value.userData === "object" &&
            !Array.isArray(value.userData) &&
            typeof value.userData.id === "string" &&
            /^[1-9]\d{0,19}$/.test(value.userData.id) &&
            typeof value.userData.name === "string"
          )
            return "authenticated" as const;
        }
        throw new VerificationFailure(
          "invalid_response",
          "Pixiv 登录状态格式暂不可识别，现有会话已保留。",
        );
      } finally {
        if (response.body && !response.body.locked)
          void response.body.cancel().catch(() => {});
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  close() {
    this.closed = true;
    this.generation++;
    if (this.debounce) clearTimeout(this.debounce);
    this.pending?.controller.abort();
  }
}
