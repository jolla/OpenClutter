/**
 * How the page treats an export response.
 *
 * A gateway timeout (empty 504 or 408) and an empty 5xx are a slow export
 * the platform closed before the function answered. A thrown fetch error is
 * the same kind of miss. Try again while the status line stays
 * "Export is still working." A later zip is the export. A 400 or 413 is the
 * request itself and is not retried. The page does not report that wait as
 * an area that is too large.
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
    const recoverable = !blocked;
    return {
      message: serverMessage || (blocked ? "Export failed (" + status + ")." : ""),
      retry: recoverable,
      gateway: gateway,
      attempts: recoverable ? 3 : 1,
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
   * A recoverable miss gets three tries. A later success is the zip.
   * A thrown error with no attempt budget is recoverable too.
   */
  async function runExportAttempts(attemptFn) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await attemptFn(attempt);
      } catch (e) {
        lastErr = e;
        if (e && e.noRetry) break;
        const allowed = e && e.attempts > 0 ? e.attempts : 3;
        if (attempt >= allowed) break;
      }
    }
    throw lastErr;
  }

  return {
    exportFailure: exportFailure,
    failureError: failureError,
    runExportAttempts: runExportAttempts,
  };
});
