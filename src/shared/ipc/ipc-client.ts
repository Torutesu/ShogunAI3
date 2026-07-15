import { mockTransport as runMockTransport } from "@/shared/ipc/transports/mock";

(function initIpcClient(global: any) {
  const DEFAULT_TIMEOUT_MS = 8000;

  function createError(code: string, message: string, details?: any) {
    const err: any = new Error(message);
    err.code = code;
    err.details = details || null;
    return err;
  }

  function tauriInvokeFn() {
    // Tauri v2: invoke lives under window.__TAURI_INTERNALS__.
    // Tauri v1 kept it at window.__TAURI__.core.invoke — supported as a fallback
    // so this code still works if the runtime is downgraded.
    if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === "function") {
      return global.__TAURI_INTERNALS__.invoke;
    }
    if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function") {
      return global.__TAURI__.core.invoke;
    }
    return null;
  }

  function hasTauriInvoke() {
    return tauriInvokeFn() !== null;
  }

  const HTTP_BACKEND_BASE_LS = "shogun.hifi.backend.baseUrl.v1";
  const HTTP_BACKEND_TOKEN_LS = "shogun.hifi.backend.token.v1";

  function readHttpBackendBase() {
    try {
      if (typeof global.SHOGUN_HTTP_BACKEND_BASE === "string") {
        const s = global.SHOGUN_HTTP_BACKEND_BASE.trim();
        if (s) return s.replace(/\/+$/, "");
      }
      if (!global.localStorage) return "";
      const raw = global.localStorage.getItem(HTTP_BACKEND_BASE_LS);
      const s = String(raw || "").trim();
      return s ? s.replace(/\/+$/, "") : "";
    } catch (_) {
      return "";
    }
  }

  function readHttpBackendToken() {
    try {
      if (typeof global.SHOGUN_HTTP_BACKEND_TOKEN === "string") {
        const s = global.SHOGUN_HTTP_BACKEND_TOKEN.trim();
        if (s) return s;
      }
      if (!global.localStorage) return "";
      return String(global.localStorage.getItem(HTTP_BACKEND_TOKEN_LS) || "").trim();
    } catch (_) {
      return "";
    }
  }

  async function tauriTransport(command: string, payload: any) {
    const invoke = tauriInvokeFn();
    if (!invoke) {
      throw createError("TRANSPORT_UNAVAILABLE", "Tauri invoke is unavailable");
    }
    // Rust side uniformly uses `fn shogun_*(payload: Value)` (see
    // src-tauri/src/commands.rs), so args must be wrapped as { payload: X }
    // for Tauri's named-argument deserializer. Commands with no user args
    // still accept this — the extra key is ignored.
    return invoke(command, { payload: payload || {} });
  }

  async function httpTransport(command: string, payload: any, timeoutMs: number) {
    const base = readHttpBackendBase();
    if (!base) {
      throw createError("TRANSPORT_UNAVAILABLE", "HTTP backend base URL is missing");
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
      : null;
    const token = readHttpBackendToken();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-shogun-token"] = token;
    try {
      const res = await fetch(base + "/ipc/invoke", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: command, payload: payload || {} }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) {
        throw createError("HTTP_ERROR", "HTTP transport failed: " + res.status, { status: res.status });
      }
      const json = await res.json();
      if (!json || json.ok !== true) {
        throw createError(
          "HTTP_BACKEND_ERROR",
          (json && json.error && json.error.message) || "HTTP backend returned an error",
          json && json.error ? json.error : null,
        );
      }
      return json.data;
    } catch (err: any) {
      if (err && err.name === "AbortError") {
        throw createError("TIMEOUT", "HTTP request timed out");
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function mockTransport(command: string, payload: any) {
    return runMockTransport(command, payload, { global, createError });
  }
  function withTimeout(promise: Promise<any>, timeoutMs: number) {
    let timer: any;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(createError("TIMEOUT", "IPC request timed out"));
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function createIpcClient(options?: any) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const autoTransport = hasTauriInvoke() ? "tauri" : (readHttpBackendBase() ? "http" : "mock");
    const transport = opts.transport || autoTransport;

    async function invoke(command: string, payload?: any, invokeOpts?: any) {
      if (!command) {
        throw createError("INVALID_COMMAND", "command is required");
      }

      const request = {
        command: command,
        payload: payload || {},
      };

      const perTimeoutMs =
        invokeOpts && typeof invokeOpts.timeoutMs === "number"
          ? invokeOpts.timeoutMs
          : timeoutMs;

      try {
        const raw = transport === "tauri"
          ? await withTimeout(tauriTransport(command, payload), perTimeoutMs)
          : transport === "http"
            ? await withTimeout(httpTransport(command, payload, perTimeoutMs), perTimeoutMs)
          : await withTimeout(mockTransport(command, payload), perTimeoutMs);
        return { ok: true, data: raw, request: request };
      } catch (error: any) {
        return {
          ok: false,
          error: {
            code: error.code || "IPC_ERROR",
            message: error.message || "Unknown IPC error",
            details: error.details || null,
          },
          request: request,
        };
      }
    }

    return {
      invoke: invoke,
      transport: transport,
      hasTauriInvoke: hasTauriInvoke,
    };
  }

  // Desktop Tauri runtime: bridge native events → DOM CustomEvents so React
  // can subscribe without relying on deprecated __TAURI__.event globals.
  if (global.__TAURI_INTERNALS__) {
    // @ts-ignore — @tauri-apps/api is only present in the Tauri desktop build
    import("@tauri-apps/api/event").then(function (mod: any) {
      mod.listen("shogun-capture-state-changed", function () {
        try {
          global.dispatchEvent(new CustomEvent("shogun-settings-refresh"));
        } catch (_) {
          /* ignore */
        }
      });
      const bridges: Array<[string, string]> = [
        ["video-meeting-started", "shogun-video-meeting-started"],
        ["video-meeting-auto-started", "shogun-video-meeting-auto-started"],
        ["meeting-stopped", "shogun-meeting-stopped"],
        ["meeting-auto-stopped", "shogun-meeting-auto-stopped"],
        ["shogun-app-navigate", "shogun-app-navigate"],
        ["shogun-action-layer-refresh", "shogun-action-layer-refresh"],
        ["shogun-capture-ax-not-trusted", "shogun-capture-ax-not-trusted"],
        ["integration-security-audit", "shogun-integration-security-audit"],
        ["credentials-imported", "shogun-credentials-imported"],
        ["historical-sync-progress", "shogun-historical-sync-progress"],
        ["shogun-meetings-changed", "shogun-meetings-changed"],
        ["shogun-memory-index-changed", "shogun-memory-index-changed"],
        ["memory-embed-backfill-progress", "shogun-memory-embed-backfill-progress"],
        ["shogun-agents-runs-changed", "shogun-agents-runs-changed"],
      ];
      bridges.forEach(function (pair) {
        const tauriEvent = pair[0];
        const domEvent = pair[1];
        mod.listen(tauriEvent, function (event: any) {
          try {
            global.dispatchEvent(
              new CustomEvent(domEvent, { detail: (event && event.payload) || {} }),
            );
          } catch (_) {
            /* ignore */
          }
        });
      });
    }).catch(function () {
      /* ignore — Tauri APIs may not be available in all build targets */
    });
  }

  global.ShogunIpcClient = { createIpcClient: createIpcClient };
})(typeof window !== 'undefined' ? window : globalThis);

export const ShogunIpcClient: { createIpcClient: (options?: any) => any } =
  (typeof window !== 'undefined' ? (window as any) : (globalThis as any)).ShogunIpcClient;
