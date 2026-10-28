"use strict";

/**
 * The two GitHub calls the feedback function makes: open an issue, and store
 * a private screenshot as a file in the private feedback repo. The token is
 * only ever sent in the Authorization header.
 */

const API = "https://api.github.com";

async function ghFetch(path, init, opts) {
  const o = opts || {};
  const doFetch = o.fetch || fetch;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs || 10000) : null;
  try {
    return await doFetch(API + path, {
      method: init.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + o.token,
        "content-type": "application/json",
        "user-agent": "OpenClutter-feedback",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(init.body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ghError(what, res) {
  const err = new Error(what + ": GitHub answered " + res.status);
  err.githubStatus = res.status;
  return err;
}

/** POST /repos/{repo}/issues. Retries once without labels on 422. */
async function createIssue(issue, opts) {
  const path = "/repos/" + opts.repo + "/issues";
  let res = await ghFetch(path, { method: "POST", body: issue }, opts);
  if (res.status === 422 && issue.labels && issue.labels.length) {
    res = await ghFetch(path, { method: "POST", body: { title: issue.title, body: issue.body } }, opts);
  }
  if (!res.ok) throw ghError("create issue", res);
  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

/**
 * PUT /repos/{repo}/contents/{path}. Used only for the private repo, so the
 * screenshot is visible to people with access to that repo and nobody else.
 * Returns a URL that renders inside the private issue.
 */
async function putPrivateFile(filePath, buf, opts) {
  const safe = String(filePath).split("/").map(encodeURIComponent).join("/");
  const res = await ghFetch(
    "/repos/" + opts.repo + "/contents/" + safe,
    { method: "PUT", body: { message: "Feedback screenshot", content: Buffer.from(buf).toString("base64") } },
    opts
  );
  if (!res.ok) throw ghError("store screenshot", res);
  const data = await res.json();
  const html = data && data.content && data.content.html_url;
  if (!html) throw new Error("store screenshot: no file URL");
  return html + "?raw=true";
}

module.exports = { createIssue, putPrivateFile };
