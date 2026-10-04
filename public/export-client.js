/**
 * How the page treats an export response.
 *
 * A gateway timeout (empty 504 or 408) is a slow export the platform closed
 * before the function answered. Try it again while the status line stays
 * "Export is still working." A 400 or 413 is the request itself and is not
 * retried. The page does not report that timeout as an area that is too large.
 *
 * Browser + Node.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterExport = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function exportFailure(status, data) {
    const gateway = status === 504 || status === 408;
    const blocked = status === 400 || status === 413;
    const serverMessage = data && data.error ? String(data.error) : "";
    return {
      message: serverMessage || "Export failed. Retry.",
      retry: !blocked,
      gateway: gateway,
      attempts: blocked ? 1 : gateway ? 3 : 2,
    };
  }

  function failureError(status, data) {
    const failure = exportFailure(status, data);
    const err = new Error(failure.message);
    err.noRetry = !failure.retry;
    err.attempts = failure.attempts;
    err.gateway = failure.gateway;
    return err;
  }

  /**
   * Run the export until it returns or the failure says to stop.
   * attemptFn throws a failureError. A gateway timeout gets three tries.
   */
  async function runExportAttempts(attemptFn) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await attemptFn(attempt);
      } catch (e) {
        lastErr = e;
        const allowed = e && e.attempts > 0 ? e.attempts : 1;
        if (attempt >= allowed) break;
      }
    }
    throw lastErr || new Error("Export failed. Retry.");
  }

  return {
    exportFailure: exportFailure,
    failureError: failureError,
    runExportAttempts: runExportAttempts,
  };
});
