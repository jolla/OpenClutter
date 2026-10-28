/*
 * Feedback form. The "Feedback" link by the version opens a small dialog:
 * type, message, screenshots (paste, drop, pick a file, or attach the map
 * view), optional email, and Send. Reports go privately to the OpenClutter
 * team (an issue in a private repo). Screenshots are re-drawn on a canvas and saved as
 * WebP or JPEG, which drops photo metadata (EXIF, GPS) and keeps each one
 * small enough for the function.
 */
(function () {
  "use strict";

  var MAX_IMAGES = 3;
  var MAX_SIDE = 1600;
  var TARGET_BYTES = 500 * 1024;
  var HARD_BYTES = 600 * 1024;

  /** Width and height scaled so the longer side is at most max. */
  function fitSize(w, h, max) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    var s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  /** Decoded size of a base64 data URL. */
  function dataUrlBytes(url) {
    var i = String(url).indexOf(",");
    if (i < 0) return 0;
    var b64 = String(url).slice(i + 1);
    var pad = b64.slice(-2) === "==" ? 2 : b64.slice(-1) === "=" ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
  }

  /** The JSON body the server expects. Pure, so tests can check it. */
  function buildPayload(s) {
    var body = {
      type: s.type || "bug",
      message: String(s.message || ""),
      email: String(s.email || "").trim(),
      version: s.version || "",
      images: (s.images || []).slice(0, MAX_IMAGES),
      website: s.website || "",
      elapsedMs: s.elapsedMs,
    };
    if (s.includeContext) {
      body.context = { viewport: s.viewport || null };
      if (s.bounds) body.context.bounds = s.bounds;
    }
    return body;
  }

  var api = { fitSize: fitSize, dataUrlBytes: dataUrlBytes, buildPayload: buildPayload, MAX_IMAGES: MAX_IMAGES };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  window.OpenClutterFeedback = api;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var dlg = $("feedback");
  var link = $("feedback-link");
  if (!dlg || !link || typeof dlg.showModal !== "function") {
    if (link) link.hidden = true;
    return;
  }
  var form = $("fb-form");
  var msg = $("fb-message");
  var email = $("fb-email");
  var ctxBox = $("fb-context");
  var ctxLabel = $("fb-context-label");
  var shots = $("fb-shots");
  var drop = $("fb-drop");
  var fileIn = $("fb-file");
  var mapBtn = $("fb-mapshot");
  var sendBtn = $("fb-send");
  var errEl = $("fb-error");
  var doneEl = $("fb-done");
  var hp = $("fb-website");

  var config = null;
  var images = [];
  var openedAt = 0;
  var sending = false;
  var mapCaptureBroken = false;

  api.isOpen = function () {
    return !!dlg.open;
  };

  function hooks() {
    return window.OpenClutterFeedbackHooks || {};
  }

  function currentBounds() {
    try {
      return hooks().bounds ? hooks().bounds() : null;
    } catch (e) {
      return null;
    }
  }

  function showError(text) {
    // Clearing an error keeps the not set up notice while the form cannot send.
    if (!text && config && !config.configured) text = config.blocked || "Feedback is not set up yet.";
    errEl.textContent = text || "";
    errEl.hidden = !text;
  }

  function syncContext() {
    ctxLabel.textContent = currentBounds() ? "Include my drawn area and browser" : "Include browser info";
  }

  function syncShots() {
    shots.textContent = "";
    images.forEach(function (img, i) {
      var li = document.createElement("li");
      var im = document.createElement("img");
      im.src = img;
      im.alt = "Screenshot " + (i + 1);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "fb-x";
      x.setAttribute("aria-label", "Remove screenshot " + (i + 1));
      x.textContent = "\u00d7";
      x.addEventListener("click", function () {
        images.splice(i, 1);
        syncShots();
      });
      li.appendChild(im);
      li.appendChild(x);
      shots.appendChild(li);
    });
    shots.hidden = !images.length;
    var full = images.length >= MAX_IMAGES;
    drop.classList.toggle("fb-full", full);
    fileIn.disabled = full;
    mapBtn.disabled = full;
    mapBtn.hidden = mapCaptureBroken || !hooks().map;
  }

  function canvasToDataUrl(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(
          function (blob) {
            if (!blob) return reject(new Error("encode failed"));
            var r = new FileReader();
            r.onload = function () {
              resolve({ url: r.result, type: blob.type });
            };
            r.onerror = reject;
            r.readAsDataURL(blob);
          },
          type,
          q
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Re-encode a drawable to WebP (or JPEG) under the size target. */
  async function encode(source, w, h) {
    var size = fitSize(w, h, MAX_SIDE);
    for (var round = 0; round < 6; round++) {
      var c = document.createElement("canvas");
      c.width = size.w;
      c.height = size.h;
      var g = c.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(source, 0, 0, c.width, c.height);
      var quals = [0.85, 0.72, 0.6];
      for (var qi = 0; qi < quals.length; qi++) {
        var out = await canvasToDataUrl(c, "image/webp", quals[qi]);
        // Browsers without WebP encoding hand back PNG; use JPEG there.
        if (out.type !== "image/webp") out = await canvasToDataUrl(c, "image/jpeg", quals[qi]);
        var bytes = dataUrlBytes(out.url);
        if (bytes <= TARGET_BYTES || (round === 5 && bytes <= HARD_BYTES)) return out.url;
      }
      size = fitSize(size.w * 0.75, size.h * 0.75, MAX_SIDE);
    }
    throw new Error("That screenshot is too large.");
  }

  function loadImage(src, cors) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      if (cors) im.crossOrigin = "anonymous";
      im.onload = function () {
        resolve(im);
      };
      im.onerror = function () {
        reject(new Error("load failed"));
      };
      im.src = src;
    });
  }

  async function addFiles(list) {
    showError("");
    var files = Array.prototype.slice.call(list || []).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
    if (!files.length && list && list.length) {
      showError("Only images can be attached.");
      return;
    }
    for (var i = 0; i < files.length; i++) {
      if (images.length >= MAX_IMAGES) {
        showError("Up to " + MAX_IMAGES + " screenshots.");
        break;
      }
      var url = URL.createObjectURL(files[i]);
      try {
        var im = await loadImage(url, false);
        images.push(await encode(im, im.naturalWidth, im.naturalHeight));
      } catch (e) {
        showError("That image could not be read. Try a PNG or JPEG.");
      } finally {
        URL.revokeObjectURL(url);
      }
      syncShots();
    }
  }

  /**
   * Draw the visible map tiles and the draw outline onto one canvas. The
   * tiles are fetched again with CORS, so a tile host that does not allow it
   * taints the canvas; then the button hides instead of failing every time.
   */
  async function captureMap() {
    var m = hooks().map && hooks().map();
    if (!m) throw new Error("no map");
    var box = m.getContainer();
    var r0 = box.getBoundingClientRect();
    var c = document.createElement("canvas");
    c.width = Math.round(r0.width);
    c.height = Math.round(r0.height);
    var g = c.getContext("2d");
    g.fillStyle = "#0e1116";
    g.fillRect(0, 0, c.width, c.height);
    var tiles = Array.prototype.slice.call(box.querySelectorAll("img.leaflet-tile-loaded"));
    var loads = tiles.map(function (t) {
      var r = t.getBoundingClientRect();
      if (r.right < r0.left || r.left > r0.right || r.bottom < r0.top || r.top > r0.bottom) return null;
      return loadImage(t.src, true).then(
        function (im) {
          return { im: im, r: r };
        },
        function () {
          return null;
        }
      );
    });
    var got = await Promise.all(loads);
    got.forEach(function (x) {
      if (x) g.drawImage(x.im, x.r.left - r0.left, x.r.top - r0.top, x.r.width, x.r.height);
    });
    var base = document.createElement("canvas");
    base.width = c.width;
    base.height = c.height;
    base.getContext("2d").drawImage(c, 0, 0);
    // The draw outline is SVG. Some browsers taint a canvas for any SVG
    // image, so the outline is tried on a copy and dropped if it taints.
    var svgs = Array.prototype.slice.call(box.querySelectorAll(".leaflet-overlay-pane svg"));
    for (var i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      var rs = s.getBoundingClientRect();
      if (!rs.width || !rs.height) continue;
      var clone = s.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(rs.width));
      clone.setAttribute("height", String(rs.height));
      clone.style.transform = "";
      var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      try {
        var svgIm = await loadImage(url, false);
        g.drawImage(svgIm, rs.left - r0.left, rs.top - r0.top, rs.width, rs.height);
      } catch (e) {
        /* Outline is optional. */
      }
    }
    function stamp(canvas) {
      var cg = canvas.getContext("2d");
      cg.font = "11px system-ui, sans-serif";
      var t = "Imagery: Esri";
      var w = cg.measureText(t).width + 10;
      cg.fillStyle = "rgba(14,17,22,0.75)";
      cg.fillRect(canvas.width - w, canvas.height - 18, w, 18);
      cg.fillStyle = "#c9d1d9";
      cg.fillText(t, canvas.width - w + 5, canvas.height - 5);
      return canvas;
    }
    try {
      return await encode(stamp(c), c.width, c.height);
    } catch (e) {
      return encode(stamp(base), base.width, base.height);
    }
  }

  // A firewall or proxy that blocks /api/feedback gets the same plain message as the rest of the page.
  function feedbackFetch(init) {
    var net = window.OpenClutterNet;
    if (net && net.guardedFetch) return net.guardedFetch("/api/feedback", init, { step: "Feedback" });
    return fetch("/api/feedback", init);
  }

  var SEND_FAILED = "Sorry, the report could not be sent. Try again later, or try another network.";

  /** A sentence from the function is shown as-is; a non-JSON or empty reply may be a proxy. */
  function sendFailure(status, data) {
    if (data && data.error) return String(data.error);
    var net = window.OpenClutterNet;
    if (!data && net && net.unexpectedReplyMessage) return net.unexpectedReplyMessage("Feedback", location.host, status);
    return SEND_FAILED;
  }

  async function loadConfig() {
    if (config && config.configured) return config;
    try {
      var r = await feedbackFetch({ cache: "no-store" });
      config = r.ok ? await r.json() : { configured: false };
    } catch (e) {
      config = { configured: false, blocked: e && e.blocked ? e.message : "" };
    }
    return config;
  }

  function resetForm() {
    form.reset();
    images = [];
    syncShots();
    showError("");
    doneEl.hidden = true;
    doneEl.textContent = "";
    form.hidden = false;
    sending = false;
    sendBtn.disabled = false;
  }

  async function open() {
    if (doneEl.hidden === false) resetForm();
    openedAt = Date.now();
    syncContext();
    syncShots();
    dlg.showModal();
    msg.focus();
    var cfg = await loadConfig();
    if (!cfg.configured) {
      showError(cfg.blocked || "Feedback is not set up yet.");
      sendBtn.disabled = true;
    } else if (!sending) {
      sendBtn.disabled = false;
      if (/not set up|^Feedback (was|could|timed)/.test(errEl.textContent)) showError("");
    }
  }

  function close() {
    dlg.close();
    link.focus();
  }

  async function send(ev) {
    ev.preventDefault();
    if (sending) return;
    showError("");
    var text = msg.value.trim();
    if (text.length < 5) {
      showError("Please tell us a little more.");
      msg.focus();
      return;
    }
    var payload = buildPayload({
      type: (form.querySelector("input[name=fb-type]:checked") || {}).value,
      message: text,
      email: email.value,
      version: window.OPENCLUTTER_VERSION || "",
      images: images,
      website: hp.value,
      elapsedMs: Date.now() - openedAt,
      includeContext: ctxBox.checked,
      bounds: ctxBox.checked ? currentBounds() : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
    sending = true;
    sendBtn.disabled = true;
    var label = sendBtn.textContent;
    sendBtn.textContent = "Sending...";
    try {
      var r = await feedbackFetch({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = null;
      try {
        data = await r.json();
      } catch (e) {
        data = null;
      }
      if (!r.ok || !data || !data.ok) throw new Error(sendFailure(r.status, data));
      form.hidden = true;
      doneEl.textContent = "";
      var p = document.createElement("p");
      p.textContent = "Thanks! Your report was sent privately to the OpenClutter team.";
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Close";
      b.addEventListener("click", close);
      doneEl.appendChild(p);
      doneEl.appendChild(b);
      doneEl.hidden = false;
      b.focus();
    } catch (e) {
      showError(e.message || SEND_FAILED);
      sendBtn.disabled = false;
    } finally {
      sending = false;
      sendBtn.textContent = label;
    }
  }

  link.addEventListener("click", open);
  $("fb-close").addEventListener("click", close);
  dlg.addEventListener("click", function (ev) {
    if (ev.target === dlg) close();
  });
  form.addEventListener("submit", send);
  fileIn.addEventListener("change", function () {
    addFiles(fileIn.files).then(function () {
      fileIn.value = "";
    });
  });
  mapBtn.addEventListener("click", async function () {
    showError("");
    mapBtn.disabled = true;
    var old = mapBtn.textContent;
    mapBtn.textContent = "Capturing...";
    try {
      images.push(await captureMap());
    } catch (e) {
      mapCaptureBroken = true;
      showError("The map view could not be captured here. You can paste or choose a screenshot instead.");
    } finally {
      mapBtn.textContent = old;
      syncShots();
    }
  });
  dlg.addEventListener("paste", function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
    }
    if (files.length) {
      ev.preventDefault();
      addFiles(files);
    }
  });
  ["dragenter", "dragover"].forEach(function (t) {
    dlg.addEventListener(t, function (ev) {
      ev.preventDefault();
      drop.classList.add("fb-over");
    });
  });
  ["dragleave", "drop"].forEach(function (t) {
    dlg.addEventListener(t, function (ev) {
      ev.preventDefault();
      if (t === "dragleave" && dlg.contains(ev.relatedTarget)) return;
      drop.classList.remove("fb-over");
    });
  });
  dlg.addEventListener("drop", function (ev) {
    addFiles(ev.dataTransfer && ev.dataTransfer.files);
  });
})();
