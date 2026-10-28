/**
 * Friendly messages when a request is blocked, so the page never fails silently.
 *
 * A company firewall or proxy (Zscaler and similar) usually shows up as one of:
 * a fetch that rejects with TypeError (connection reset, CORS on a redirect to
 * the proxy), a 403 or 407, an HTML block page where JSON or a zip was due,
 * a redirect to another host, or a request that hangs until it times out.
 *
 * Browser + Node.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterNet = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TRY_ELSEWHERE = "Try another network.";

  function hostOf(url, base) {
    try {
      return new URL(String(url), base || "http://localhost/").host;
    } catch (err) {
      return "";
    }
  }

  function isAbort(err) {
    return !!err && err.name === "AbortError";
  }

  function isTimeout(err) {
    return !!err && (err.name === "TimeoutError" || err.timeout === true);
  }

  /** A fetch that never got a response: TypeError "Failed to fetch" and kin. */
  function isNetworkError(err) {
    if (!err || isAbort(err) || isTimeout(err)) return false;
    if (err.name === "TypeError") return true;
    return /failed to fetch|networkerror|network request failed|load failed/i.test(String(err.message || ""));
  }

  function contentType(res) {
    try {
      return String((res && res.headers && res.headers.get && res.headers.get("content-type")) || "").toLowerCase();
    } catch (err) {
      return "";
    }
  }

  /**
   * Why a response looks like a firewall or proxy, or "" when it does not.
   * expectHost is the host the request was sent to. Gateway statuses
   * (502, 504, 408) and a plain 404 are left to the callers' own handling.
   */
  function responseBlockKind(res, expectHost) {
    if (!res) return "";
    const status = +res.status || 0;
    if (status === 407) return "proxy-auth";
    if (status === 403 || status === 451) return "forbidden";
    if (expectHost && res.redirected && res.url) {
      const got = hostOf(res.url);
      if (got && got !== expectHost) return "redirect";
    }
    if (status === 502 || status === 503 || status === 504 || status === 408 || status === 404) return "";
    if (/text\/html/.test(contentType(res))) return "html";
    return "";
  }

  function stepText(step) {
    const s = String(step || "The request");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** The one-line status for a blocked step. kind: network, timeout, forbidden, proxy-auth, html, redirect, offline. */
  function blockedMessage(step, host, kind) {
    const who = stepText(step);
    const site = host || "the server";
    if (kind === "offline") return who + " failed: this device looks offline. Check the connection and try again.";
    if (kind === "timeout") {
      return who + " timed out reaching " + site + ". A company firewall or proxy may be blocking it. " + TRY_ELSEWHERE;
    }
    if (kind === "proxy-auth") {
      return who + " was stopped by a proxy that wants a sign-in (407 from " + site + "). " + TRY_ELSEWHERE;
    }
    if (kind === "forbidden" || kind === "html" || kind === "redirect") {
      return (
        who + " was blocked: " + site + " returned a firewall or proxy page instead of data. " +
        "Try another network, or ask IT to allow " + site + "."
      );
    }
    return who + " could not reach " + site + ". A company firewall or proxy may be blocking it. " + TRY_ELSEWHERE;
  }

  /**
   * A reply that is not the JSON the page expected (a gateway or proxy page,
   * an empty 5xx). It may be a firewall, so the network hint stays.
   */
  function unexpectedReplyMessage(step, host, status) {
    const code = +status > 0 ? " (" + status + ")" : "";
    return (
      stepText(step) + " got an unexpected reply from " + (host || "the server") + code +
      ". A company firewall or proxy may be in the way. Try again, or try another network."
    );
  }

  function blockedError(step, host, kind, cause) {
    const err = new Error(blockedMessage(step, host, kind));
    err.blocked = true;
    err.kind = kind;
    err.step = step;
    err.host = host;
    err.noRetry = true;
    if (cause) err.cause = cause;
    return err;
  }

  function offline(nav) {
    const n = nav || (typeof navigator !== "undefined" ? navigator : null);
    return !!(n && n.onLine === false);
  }

  /**
   * fetch with the block checks. Throws a blocked error (err.blocked, noRetry)
   * for a network failure, a timeout, or a block response. A user abort is
   * rethrown unchanged. Other responses come back as-is for the caller.
   * opts.step names the step ("Search", "Export"...).
   * opts.fetch and opts.base are for tests.
   */
  async function guardedFetch(url, init, opts) {
    const o = opts || {};
    const f = o.fetch || (typeof fetch === "function" ? fetch : null);
    const base = o.base || (typeof location !== "undefined" ? location.href : "http://localhost/");
    const host = hostOf(url, base);
    const step = o.step || "The request";
    let res;
    try {
      res = await f(url, init);
    } catch (err) {
      if (isAbort(err)) {
        const sig = init && init.signal;
        const reason = sig && sig.reason;
        if (reason && isTimeout(reason)) throw blockedError(step, host, "timeout", err);
        throw err;
      }
      if (isTimeout(err)) throw blockedError(step, host, "timeout", err);
      if (isNetworkError(err)) throw blockedError(step, host, offline(o.navigator) ? "offline" : "network", err);
      throw err;
    }
    const kind = responseBlockKind(res, host);
    if (kind) throw blockedError(step, host, kind);
    return res;
  }

  const FALLBACK_KEY = "openclutter.apiSameOrigin";

  /**
   * Export calls with an optional API host in front of the page's own /api.
   * opts.base is that host ("https://api.example.com"), or "" for same-origin
   * only. A connection-level failure on the base host (no HTTP answer: reset,
   * closed, DNS, timeout) retries the same path on the page's own host and
   * remembers that for the session. An HTTP answer from the base host,
   * even an error, is the answer. If the page's host fails too, the message
   * names both hosts.
   */
  function createApiRoute(opts) {
    const o = opts || {};
    const base = String(o.base || "").replace(/\/+$/, "");
    const storage = o.storage || null;
    const pageBase = o.pageBase || (typeof location !== "undefined" ? location.href : "http://localhost/");
    let sameOrigin = !base;
    if (!sameOrigin && storage) {
      try {
        sameOrigin = storage.getItem(FALLBACK_KEY) === "1";
      } catch (err) {}
    }
    function remember() {
      sameOrigin = true;
      if (!storage) return;
      try {
        storage.setItem(FALLBACK_KEY, "1");
      } catch (err) {}
    }
    async function routeFetch(path, init, fopts) {
      const f = Object.assign({}, fopts || {}, { fetch: o.fetch, base: pageBase, navigator: o.navigator });
      if (sameOrigin) return guardedFetch(path, init, f);
      try {
        return await guardedFetch(base + path, init, f);
      } catch (err) {
        if (!err || !err.blocked || (err.kind !== "network" && err.kind !== "timeout")) throw err;
        remember();
        if (typeof o.onFallback === "function") o.onFallback(err);
        try {
          return await guardedFetch(path, init, f);
        } catch (err2) {
          if (err2 && err2.blocked && (err2.kind === "network" || err2.kind === "timeout")) {
            const own = hostOf(path, pageBase);
            throw blockedError(f.step, err.host + " or " + own, err2.kind, err2);
          }
          throw err2;
        }
      }
    }
    return {
      fetch: routeFetch,
      get sameOrigin() {
        return sameOrigin;
      },
      url(path) {
        return sameOrigin ? path : base + path;
      },
    };
  }

  /**
   * Watches a tile layer's tileerror and tileload events. After a batch with
   * errors and no loads (ignoring zooms listed in skip), onBlocked runs once.
   * A later good tile calls onRecovered once.
   */
  function createTileWatch(opts) {
    const o = opts || {};
    const minErrors = o.minErrors > 0 ? o.minErrors : 3;
    let errors = 0;
    let loads = 0;
    let shown = false;
    let recovered = false;
    return {
      error(z) {
        if (typeof o.skipZoom === "function" && o.skipZoom(z)) return false;
        errors += 1;
        if (!shown && errors >= minErrors && loads === 0) {
          shown = true;
          if (o.onBlocked) o.onBlocked();
          return true;
        }
        return false;
      },
      load() {
        loads += 1;
        if (shown && !recovered) {
          recovered = true;
          if (o.onRecovered) o.onRecovered();
        }
      },
      /** Called on the layer's "loading": a new batch starts counting. */
      batch() {
        errors = 0;
        loads = 0;
      },
      get shown() {
        return shown;
      },
    };
  }

  return {
    hostOf,
    isNetworkError,
    isTimeout,
    responseBlockKind,
    blockedMessage,
    unexpectedReplyMessage,
    blockedError,
    guardedFetch,
    createApiRoute,
    createTileWatch,
  };
});
