/* upload.js — Data Source control, upload workflow, notifications and UX
 * helpers for the Smart Dynamic Pricing dashboard.
 *
 * - CSV / Excel upload with progress, preview (first 10 rows), column
 *   detection, auto column mapping, and validation messages
 * - toasts, loading overlay and the reset/refresh plumbing shared by panels
 *
 * Exposes window.PricingUI.
 */
(function (root) {
  "use strict";

  var P = null;

  function css() {
    var s = document.createElement("style");
    s.textContent = `
    .ds-select{width:auto;min-width:150px;margin:0;padding:8px 12px;font-size:13px;cursor:pointer}
    .ds-badge{font-size:12.5px;color:var(--ok-fg);background:var(--ok-bg);border:1px solid var(--ok-bg);
      border-radius:999px;padding:5px 12px;font-weight:600;display:none;align-items:center;gap:6px;
      max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .toast-wrap{position:fixed;bottom:18px;right:18px;z-index:99999;display:flex;flex-direction:column;
      gap:10px;max-width:340px}
    .toast{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);
      border-radius:12px;padding:12px 15px;box-shadow:var(--shadow);font-size:13px;
      animation:toastIn .18s ease}
    .toast.ok{border-left-color:var(--ok-fg)} .toast.err{border-left-color:var(--bad-fg)}
    .toast.warn{border-left-color:var(--warn-fg)}
    .toast b{display:block;font-size:13.5px;color:var(--ink);margin-bottom:2px}
    .toast span{color:var(--muted);font-size:12.5px;line-height:1.5;display:block}
    @keyframes toastIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
    .px-overlay{position:fixed;inset:0;background:rgba(43,33,24,.45);z-index:99990;
      display:none;align-items:center;justify-content:center}
    .px-overlay.show{display:flex}
    .px-spinner{width:44px;height:44px;border-radius:50%;border:4px solid var(--border);
      border-top-color:var(--accent);animation:pxspin .8s linear infinite}
    @keyframes pxspin{to{transform:rotate(360deg)}}
    .px-modal{position:fixed;inset:0;z-index:99995;display:none;align-items:flex-start;
      justify-content:center;background:rgba(43,33,24,.45);padding:40px 16px;overflow:auto}
    .px-modal.show{display:flex}
    .px-modal-box{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
      box-shadow:var(--shadow);width:100%;max-width:760px;padding:24px;position:relative}
    .px-modal-box h3{margin:0 0 6px;font-size:22px}
    .px-modal-box .sub{font-size:13px;color:var(--muted);margin:0 0 16px}
    .px-x{position:absolute;top:12px;right:14px;background:none;border:0;color:var(--muted);
      font-size:22px;cursor:pointer;width:44px;height:44px;min-height:44px;padding:0;border-radius:999px}
    .px-x:hover{color:var(--accent);background:var(--bg)}
    .px-drop{border:2px dashed var(--border);border-radius:12px;padding:30px 20px;text-align:center;
      color:var(--muted);font-size:13.5px;cursor:pointer;background:var(--bg)}
    .px-drop:hover,.px-drop.over{border-color:var(--accent);color:var(--ink)}
    .px-drop b{color:var(--accent)}
    .px-progress{display:none;margin-top:14px}
    .px-progress.show{display:block}
    .px-progress .mb{display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);
      margin-bottom:6px}
    .bar{height:8px;border-radius:999px;background:var(--bg);overflow:hidden}
    .bar i{display:block;height:100%;background:var(--accent)}
    .px-preview{display:none;margin-top:16px}
    .px-preview.show{display:block}
    .px-preview table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
    .px-preview th,.px-preview td{border:1px solid var(--border);padding:7px 9px;text-align:left;
      max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .px-preview th{background:var(--bg);color:var(--muted);font-size:11.5px;text-transform:uppercase;
      letter-spacing:.4px}
    .px-preview td{color:var(--ink)}
    .px-mapgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:16px}
    .px-mapgrid label{font-size:12px;margin:0 0 4px}
    .px-mapgrid label b{color:var(--ink)} .px-mapgrid label.need{color:var(--bad-fg)}
    .px-mapgrid select{padding:8px 10px;font-size:13px}
    .px-error{margin-top:14px;padding:12px 14px;border-radius:12px;background:var(--bad-bg);
      border:1px solid var(--bad-bg);color:var(--bad-fg);font-size:13px;display:none;line-height:1.6}
    .px-error.show{display:block}
    .px-error button{margin-top:10px;min-height:44px;padding:0 18px}
    .px-modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
    .px-modal-actions button{width:auto;margin:0}
    @media (prefers-reduced-motion:reduce){ *{animation:none !important;transition:none !important} }
    `;
    document.head.appendChild(s);
  }

  /* ---------- toasts ---------- */
  function ensureToasts() {
    var w = document.getElementById("toast-wrap");
    if (!w) { w = document.createElement("div"); w.id = "toast-wrap"; w.className = "toast-wrap"; document.body.appendChild(w); }
    return w;
  }
  function toast(title, detail, type) {
    var w = ensureToasts();
    var t = document.createElement("div");
    t.className = "toast " + (type || "");
    t.innerHTML = "<b>" + esc(title) + "</b>" + (detail ? "<span>" + esc(detail) + "</span>" : "");
    w.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 4200);
    setTimeout(function () { t.remove(); }, 4600);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]);
    });
  }

  /* ---------- overlay ---------- */
  function overlayEl() {
    var o = document.getElementById("px-overlay");
    if (!o) { o = document.createElement("div"); o.id = "px-overlay"; o.className = "px-overlay"; o.innerHTML = '<div class="px-spinner"></div>'; document.body.appendChild(o); }
    return o;
  }
  function spinner(show) { overlayEl().classList.toggle("show", !!show); }

  /* ---------- modal & upload flow ---------- */
  var state = { headers: [], rows: [], mapping: {}, fileName: "", applied: false };

  function openModal() {
    var m = document.getElementById("px-modal");
    m.classList.add("show");
    m.querySelector(".px-drop").style.display = "";
    resetModalBody();
  }
  function closeModal() {
    var m = document.getElementById("px-modal");
    m.classList.remove("show");
    resetModalBody();
  }
  function resetModalBody() {
    var m = document.getElementById("px-modal");
    ["px-progress", "px-preview", "px-error"].forEach(function (id) {
      var el = m.querySelector("#" + id); if (el) el.classList.remove("show");
    });
    state.headers = []; state.rows = []; state.mapping = {};
  }

  function modalEl() {
    var m = document.getElementById("px-modal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "px-modal"; m.className = "px-modal";
    m.innerHTML =
      '<div class="px-modal-box">' +
      '<button class="px-x" id="px-close" title="Close">&times;</button>' +
      '<h3>Upload Dataset</h3>' +
      '<p class="sub">Upload a CSV file. It is sent to the backend ML pipeline, which validates it, profiles it, trains and compares models, and returns structured results.</p>' +
      '<div class="px-drop" id="px-drop"><b>Choose a file</b> or drag &amp; drop here<br/><span style="font-size:12px">Accepted: .csv</span></div>' +
      '<input type="file" id="px-file" accept=".csv,text/csv" hidden/>' +
      '<div class="px-progress" id="px-progress"><div class="mb"><span id="px-progress-label">Reading file…</span><b id="px-progress-pct">0%</b></div><div class="bar"><i id="px-progress-fill" style="width:0%"></i></div></div>' +
      '<div class="px-error" id="px-error"></div>' +
      '<div class="px-preview" id="px-preview"><b style="font-size:13px">Preview</b> <span style="color:var(--faint);font-size:12px" id="px-preview-meta"></span><div style="overflow:auto;max-height:240px"><table><thead id="px-preview-head"></thead><tbody id="px-preview-body"></tbody></table></div>' +
      '<div class="px-mapgrid" id="px-mapgrid"><div class="px-mapgrid-title" style="grid-column:1/-1;font-size:13px;font-weight:700;margin-top:6px">Column mapping <span style="font-weight:400;color:var(--faint);font-size:12px">— required fields are highlighted</span></div></div></div>' +
      '<div class="px-modal-actions">' +
      '<button id="px-cancel" class="btn-secondary">Cancel</button>' +
      '<button id="px-apply" disabled>Analyze &amp; Use Dataset</button>' + +
      '</div></div>';
    document.body.appendChild(m);
    m.querySelector("#px-close").onclick = closeModal;
    m.querySelector("#px-cancel").onclick = closeModal;
    var drop = m.querySelector("#px-drop");
    var fileInput = m.querySelector("#px-file");
    drop.onclick = function () { if (fileInput) fileInput.click(); };
    drop.onkeydown = function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (fileInput) fileInput.click(); }
    };
    drop.setAttribute("role", "button");
    drop.setAttribute("tabindex", "0");
    if (fileInput) fileInput.onchange = function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = function () { drop.classList.remove("over"); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
    m.querySelector("#px-apply").onclick = applyDataset;
    return m;
  }

  function setProgress(pct, label) {
    var m = document.getElementById("px-modal");
    m.querySelector("#px-progress").classList.add("show");
    m.querySelector("#px-progress-fill").style.width = pct + "%";
    m.querySelector("#px-progress-pct").textContent = pct + "%";
    m.querySelector("#px-progress-label").textContent = label || "Reading file…";
  }

  function handleFile(file) {
    state.fileName = file.name;
    state.applied = false;
    var isExcel = /\.(xlsx|xls)$/i.test(file.name) || file.type.indexOf("spreadsheet") >= 0;
    var isCsv = /\.(csv)$/i.test(file.name) || file.type.indexOf("csv") >= 0 || file.type.indexOf("text") >= 0;
    var m = document.getElementById("px-modal");
    m.querySelector("#px-apply").disabled = true;
    m.querySelector(".px-drop").style.display = "none";
    setProgress(5, "Reading " + file.name + "…");

    if (isCsv) {
      var reader = new FileReader();
      var step = setInterval(function () { var p = m.querySelector("#px-progress-pct"); if (p) p.textContent = Math.min(92, +p.textContent.replace("%", "") + 11) + "%"; }, 120);
      reader.onload = function (e) {
        clearInterval(step);
        setProgress(100, "Parsing CSV…");
        setTimeout(function () {
          var parsed = P.parseCSV(String(e.target.result));
          onParsed(parsed, file.name);
        }, 60);
      };
      reader.readAsText(file);
    } else if (isExcel) {
      var step2 = setInterval(function () { var p = m.querySelector("#px-progress-pct"); if (p) p.textContent = Math.min(92, +p.textContent.replace("%", "") + 9) + "%"; }, 150);
      P.parseExcelFile(file, function (err, parsed) {
        clearInterval(step2);
        if (err) {
          setProgress(100, "Failed");
          showError(String(err && err.message ? err.message : err));
          return;
        }
        setProgress(100, "Parsing spreadsheet…");
        setTimeout(function () { onParsed(parsed, file.name); }, 60);
      });
    } else {
      showError("Unsupported file type. Please upload a CSV (.csv) or Excel (.xlsx / .xls) file.");
      m.querySelector(".px-drop").style.display = "";
    }
  }

  function onParsed(parsed, fileName) {
    if (!parsed.headers.length || !parsed.rows.length) {
      showError("The file has no usable data. Make sure it has a header row followed by sales records.");
      return;
    }
    state.headers = parsed.headers;
    state.rows = parsed.rows;
    state.fileName = fileName;
    state.mapping = P.suggestMapping(parsed.headers);

    renderPreview(parsed);
    renderMapping();
    var btn = document.getElementById("px-apply");
    var needs = validate();
    btn.disabled = !needs.ok;
  }

  function renderPreview(parsed) {
    var m = document.getElementById("px-modal");
    m.querySelector("#px-preview").classList.add("show");
    m.querySelector("#px-progress").classList.remove("show");
    m.querySelector("#px-preview-meta").textContent = parsed.headers.length + " columns · " + parsed.rows.length.toLocaleString("en-IN") + " rows — showing first 10";
    var head = m.querySelector("#px-preview-head");
    var body = m.querySelector("#px-preview-body");
    head.innerHTML = parsed.headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("");
    var sample = parsed.rows.slice(0, 10);
    body.innerHTML = sample.map(function (r) {
      return "<tr>" + parsed.headers.map(function (h) { return "<td>" + esc(r[h]) + "</td>"; }).join("") + "</tr>";
    }).join("") || "<tr><td style='color:var(--faint)'>No rows</td></tr>";
  }

  function renderMapping() {
    var grid = document.getElementById("px-mapgrid");
    var html = '<div class="px-mapgrid-title" style="grid-column:1/-1;font-size:13px;font-weight:700;margin-top:6px">Column mapping <span style="font-weight:400;color:var(--faint);font-size:12px">— required fields are highlighted</span></div>';
    P.REQUIRED_FIELDS.forEach(function (rf) {
      var opts = '<option value="">— not mapped —</option>' +
        state.headers.map(function (h, i) {
          return '<option value="' + i + '"' + (state.mapping[rf.field] === i ? " selected" : "") + ">" + esc(h) + "</option>";
        }).join("");
      html += '<div><label class="' + (rf.hard ? "need" : "") + '">' + esc(rf.label) + (rf.hard ? " <b>*</b>" : "") + '</label>' +
        '<select data-field="' + rf.field + '">' + opts + '</select></div>';
    });
    grid.innerHTML = html;
    grid.querySelectorAll("select").forEach(function (sel) {
      sel.onchange = function () {
        state.mapping[sel.getAttribute("data-field")] = sel.value === "" ? null : +sel.value;
        validate();
      };
    });
  }

  function validate() {
    var v = P.validateColumns(state.headers, state.mapping);
    var err = document.getElementById("px-error");
    var btn = document.getElementById("px-apply");
    if (!v.ok) {
      var names = v.missing.map(function (rf) { return rf.label + " (" + rf.field + ")"; });
      err.innerHTML = "<b>Missing required column" + (names.length > 1 ? "s" : "") + ":</b> " + esc(names.join(", ")) +
        "<br/>Select the right source column in the mapping below, or upload a file that includes these columns.";
      err.classList.add("show");
      btn.disabled = true;
      return { ok: false, missing: v.missing };
    }
    err.classList.remove("show");
    btn.disabled = false;
    return { ok: true };
  }

  function showError(msg) {
    var m = document.getElementById("px-modal");
    var err = m.querySelector("#px-error");
    err.innerHTML = esc(msg);
    err.classList.add("show");
  }

  function applyDataset() {
    var btn = document.getElementById("px-apply");
    btn.disabled = true;
    spinner(true);
    setStackLabel("Sending dataset to backend\u2026");
    setTimeout(function () {
      try {
        /* client mirror: normalise rows as before so the interactive panels
         * (Analytics, Prediction Center, Decision Engine) work on the same data */
        var cleaned = P.normalizeRows(state.rows, state.mapping);
        if (!cleaned.rows.length) throw new Error(cleaned.warnings.join(" ") || "No valid rows could be normalised.");
        var cleaned2 = P.cleanRows(cleaned.rows);
        P.applyUpload(cleaned2.rows, { fileName: state.fileName, headers: state.headers, rowsParsed: state.rows.length, missingValues: cleaned2.missingValues, totalMissing: cleaned2.totalMissing });

        /* rebuild the CSV from the parsed rows; the backend re-validates and
         * detects the relevant columns itself */
        var csvText = P.toCSV(state.headers, state.rows.map(function (r) { return state.headers.map(function (h) { return r[h]; }); }));
        uploadToBackend(csvText);
      } catch (e) {
        spinner(false);
        btn.disabled = false;
        showError(e && e.message ? e.message : String(e));
      }
    }, 30);
  }

  /* POST the dataset, train the models, and surface the structured results. */
  function uploadToBackend(csvText) {
    var fd = new FormData();
    fd.append("file", new Blob(["\uFEFF" + csvText], { type: "text/csv" }), state.fileName.replace(/\.(xlsx|xls)$/i, ".csv"));
    fetch((window.API_BASE || "") + "/api/dataset/upload", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || r.statusText); return j; }); })
      .then(function (profile) {
        setStackLabel("Backend profiling complete \u2014 training models\u2026");
        var target = profile.suggested_target || ((profile.target_candidates && profile.target_candidates[0]) ? profile.target_candidates[0].column : null);
        return fetch((window.API_BASE || "") + "/api/pipeline/train", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset_id: profile.dataset_id, target: target }),
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || r.statusText); return { profile: profile, train: j }; }); });
      })
      .then(function (res) {
        root.PricingBackend = {
          profile: res.profile, train: res.train,
          datasetId: res.profile.dataset_id, fileName: state.fileName, offline: false,
        };
        state.applied = true;
        finishBackendFlow("ok");
        toast("Backend ML ready",
          state.fileName + " \u2014 best model: " + res.train.best.name + " (R\u00B2 " + res.train.best.r2 + ", RMSE " + res.train.best.rmse + " units).", "ok");
      })
      .catch(function (e) {
        root.PricingBackend = { profile: null, train: null, datasetId: null, fileName: state.fileName, offline: true };
        spinner(false);
        var applyBtn = document.getElementById("px-apply");
        if (applyBtn) { applyBtn.disabled = false; applyBtn.style.display = "none"; }
        var err = document.getElementById("px-error");
        if (err) {
          err.innerHTML = "<b>The backend could not be reached, so no model was trained.</b><br/>" +
            esc(e && e.message ? e.message : "Is the server running?") +
            '<br/><button type="button" id="px-retry">Retry</button>';
          err.classList.add("show");
          var retry = err.querySelector("#px-retry");
          if (retry) retry.onclick = function () { err.classList.remove("show"); uploadToBackend(csvText); };
        }
        toast("Backend unreachable",
          "Nothing was predicted. Fix the connection and press Retry.", "err");
      });
  }

  function finishBackendFlow(how) {
    spinner(false);
    state.applied = true;
    setStackLabel("");
    closeModal();
    setDataSourceUI("upload", state.fileName);
    refreshEverything(P.analytics());
    if (how === "ok") document.getElementById("health").textContent = "Connected";
  }

  function setStackLabel(label) {
    var s = document.getElementById("ml-stack-label");
    if (s) s.textContent = label || "";
  }

  /* ---------- cross-module refresh ---------- */
  function refreshEverything(a) {
    if (root.PricingAnalytics) { root.PricingAnalytics.render(); }
    if (root.PricingPredict) { root.PricingPredict.render();
      if (root.PricingPredict.renderPortfolio) root.PricingPredict.renderPortfolio(); }
    if (root.PricingDashboard && root.PricingDashboard.refreshAll) { root.PricingDashboard.refreshAll(); }
    if (root.PricingML) { root.PricingML.render(); }
    if (root.PricingDashboard) { root.PricingDashboard.refreshAll(); }
    if (root.fillProducts) root.fillProducts();
  }

  function setDataSourceUI(kind, fileName) {
    var badge = document.getElementById("ds-badge");
    if (badge) {
      badge.classList.toggle("show", kind === "upload");
      if (kind === "upload") badge.textContent = "● " + fileName;
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    P = root.PricingData;
    if (!P) return;
    css();
    modalEl();
    ensureToasts();

    var btn = document.getElementById("data-source");
    if (btn) btn.onclick = openModal;
  }

  root.PricingUI = {
    boot: boot, toast: toast, spinner: spinner,
    openModal: openModal, closeModal: closeModal,
    setDataSourceUI: setDataSourceUI, refreshEverything: refreshEverything,
    onReset: null,
  };
})(typeof window !== "undefined" ? window : globalThis);
