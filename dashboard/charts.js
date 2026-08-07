/* charts.js — professional canvas charting for the Smart Dynamic Pricing dashboard.
 *
 * Lightweight, dependency-free line/bar charts with:
 *   - smooth (Catmull-Rom → bezier) lines and gradient area fills
 *   - confidence bands (shaded upper/lower)
 *   - interactive tooltips, wheel zoom, drag pan, double-click reset
 *   - grid lines, axis labels (left + optional right), legends, titles
 *   - automatic highest/lowest markers with value annotations
 *   - responsive re-render with device-pixel-ratio crispness
 *
 * Exposes window.PricingCharts = { Chart, Palette }.
 */
(function () {
  "use strict";

  var Palette = [
    "#5b8cff", "#8b5cf6", "#34d399", "#fbbf24", "#f87171",
    "#22d3ee", "#f472b6", "#a3e635", "#fb923c", "#e879f9",
  ];

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return "rgba(91,140,255," + a + ")";
    var n = parseInt(m[1], 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function smoothPath(ctx, pts) {
    if (pts.length < 3) {
      pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      return;
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length - 1; i++) {
      var xc = (pts[i].x + pts[i + 1].x) / 2;
      var yc = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  /* Anchor for tooltips — avoids depending on page-level CSS ids. */
  function ensureTooltipHost() {
    var host = document.getElementById("pc-tooltip-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "pc-tooltip-host";
      host.style.cssText =
        "position:fixed;pointer-events:none;z-index:9999;font-family:Inter,'Segoe UI',system-ui,sans-serif;" +
        "font-size:12px;line-height:1.5;color:#e8edf7;background:rgba(12,18,34,.95);border:1px solid #22304e;" +
        "border-radius:10px;padding:9px 12px;box-shadow:0 10px 26px rgba(0,0,0,.45);max-width:280px;" +
        "display:none;opacity:0;transition:opacity .08s;white-space:nowrap";
      document.body.appendChild(host);
    }
    return host;
  }

  function Chart(canvas, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.o = opts || {};
    this.series = (this.o.series || []).map(function (s, i) {
      return {
        name: s.name || ("Series " + (i + 1)),
        color: s.color || Palette[i % Palette.length],
        type: s.type || "line",
        axis: s.axis || "left",
        smooth: !!s.smooth,
        area: !!s.area,
        dash: !!s.dash,
        data: s.data || [],
      };
    });
    this.bands = (this.o.bands || []).map(function (b) {
      return { name: b.name || "band", color: b.color || "#34d399", lower: b.lower || [], upper: b.upper || [] };
    });
    this.refLines = (this.o.refLines || []).map(function (r) {
      return { value: r.value, label: r.label || "", color: r.color || "#64748a", dash: r.dash !== false };
    });
    this.xLabels = this.o.xLabels || [];
    this.yFmt = this.o.yFmt || function (v) { return v == null ? "" : String(Math.round(v)); };
    this.yFmtRight = this.o.yFmtRight || this.yFmt;
    this.legend = this.o.legend !== false;
    this.markers = this.o.markers !== false;
    this.showValues = this.o.showValues || false; // 'bars' | 'maxmin' | false
    this.title = this.o.title || "";

    this.viewStart = 0;
    this.viewEnd = Math.max(0, this.pointCount() - 1);
    this.hover = null;
    this._padL = 46; this._padR = this.series.some(function (s) { return s.axis === "right"; }) ? 46 : 14;
    this._padT = this.title ? 30 : 10;
    this._padB = 26;

    this._bind();
    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(this.render.bind(this)) : null;
    if (this._ro) this._ro.observe(canvas);
    this.render();
  }

  Chart.prototype.pointCount = function () {
    var n = 0;
    this.series.forEach(function (s) { if (s.data.length > n) n = s.data.length; });
    this.bands.forEach(function (b) { if (b.upper.length > n) n = b.upper.length; });
    return n;
  };

  Chart.prototype.destroy = function () {
    if (this._ro) this._ro.disconnect();
    if (this._tip) { this._tip.parentNode && this._tip.parentNode.removeChild(this._tip); this._tip = null; }
    this.cv.onmousemove = this.cv.onmouseleave = this.cv.onwheel = this.cv.ondblclick = null;
    this.cv.onmousedown = this.cv.onmouseup = null;
  };

  Chart.prototype._bind = function () {
    var self = this;
    var dragging = false, lastX = 0;
    this.cv.onmousemove = function (e) {
      var rect = self.cv.getBoundingClientRect();
      var x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (dragging) {
        var dx = x - lastX;
        lastX = x;
        self._panBy(-dx);
        return;
      }
      self._hover(x, y);
    };
    this.cv.onmouseleave = function () { self.hover = null; self._hideTip(); self.render(); };
    this.cv.onmousedown = function (e) { dragging = true; lastX = e.clientX; e.preventDefault(); };
    this.cv.onmouseup = function () { dragging = false; };
    this.cv.onwheel = function (e) {
      e.preventDefault();
      var rect = self.cv.getBoundingClientRect();
      var fx = (e.clientX - rect.left - self._padL) / Math.max(1, self._plotW());
      self._zoomAt(fx, e.deltaY > 0 ? 1.25 : 0.8);
    };
    this.cv.ondblclick = function () { self.resetView(); };
  };

  Chart.prototype.resetView = function () {
    this.viewStart = 0;
    this.viewEnd = Math.max(0, this.pointCount() - 1);
    this.render();
  };

  Chart.prototype._plotW = function () {
    var w = this.cv.clientWidth || this.cv.width;
    return w - this._padL - this._padR;
  };
  Chart.prototype._plotH = function () {
    var h = this.cv.clientHeight || this.cv.height;
    return h - this._padT - this._padB;
  };

  Chart.prototype._zoomAt = function (fx, factor) {
    var total = Math.max(1, this.pointCount() - 1);
    var span = (this.viewEnd - this.viewStart) * factor;
    span = Math.max(5, Math.min(total, span));
    var center = this.viewStart + fx * (this.viewEnd - this.viewStart);
    var half = span / 2;
    var s = Math.max(0, center - half);
    var e = Math.min(total, center + half);
    if (e - s < 5) { s = Math.max(0, e - 5); }
    this.viewStart = s; this.viewEnd = e;
    this.render();
  };

  Chart.prototype._panBy = function (dx) {
    var total = Math.max(1, this.pointCount() - 1);
    var span = this.viewEnd - this.viewStart;
    if (span >= total) return;
    var step = (dx / Math.max(1, this._plotW())) * span;
    var s = this.viewStart - step, e = this.viewEnd - step;
    if (s < 0) { e -= s; s = 0; }
    if (e > total) { s -= e - total; e = total; }
    this.viewStart = Math.max(0, s); this.viewEnd = Math.min(total, e);
    this.render();
  };

  Chart.prototype._scales = function (view) {
    var lo = Infinity, hi = -Infinity, has = false;
    var loR = Infinity, hiR = -Infinity, hasR = false;
    var i;
    for (i = 0; i < this.series.length; i++) {
      var s = this.series[i], d = s.data;
      for (var j = 0; j < d.length; j++) {
        if (j < view[0] || j > view[1] || d[j] == null || isNaN(d[j])) continue;
        has = true;
        if (s.axis === "right") { if (d[j] < loR) loR = d[j]; if (d[j] > hiR) hiR = d[j]; }
        else { if (d[j] < lo) lo = d[j]; if (d[j] > hi) hi = d[j]; }
      }
    }
    for (i = 0; i < this.bands.length; i++) {
      var b = this.bands[i];
      for (var k = 0; k < b.upper.length; k++) {
        if (k < view[0] || k > view[1]) continue;
        var u = b.upper[k], l = b.lower[k];
        if (u != null && !isNaN(u)) { has = true; if (u < lo) lo = u; if (u > hi) hi = u; }
        if (l != null && !isNaN(l)) { if (l < lo) lo = l; if (l > hi) hi = l; }
      }
    }
    this.refLines.forEach(function (r) { has = true; if (r.value < lo) lo = r.value; if (r.value > hi) hi = r.value; });
    if (!has) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    var L = { lo: lo, hi: hi };
    if (hasR) {
      if (loR === hiR) { loR -= 1; hiR += 1; }
      var padR = (hiR - loR) * 0.08; loR -= padR; hiR += padR;
    }
    return { left: L, right: hasR ? { lo: loR, hi: hiR } : null };
  };

  Chart.prototype._xPos = function (i, total) {
    var span = this.viewEnd - this.viewStart || 1;
    var t = (i - this.viewStart) / span;
    return this._padL + t * this._plotW();
  };

  Chart.prototype.render = function () {
    var self = this;
    var dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    var cssW = this.cv.clientWidth || 320, cssH = this.cv.clientHeight || 220;
    if (cssW !== this._cw || cssH !== this._ch) {
      this.cv.width = Math.max(1, Math.round(cssW * dpr));
      this.cv.height = Math.max(1, Math.round(cssH * dpr));
      this._cw = cssW; this._ch = cssH;
    }
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var total = Math.max(1, this.pointCount() - 1);
    var v = [Math.round(this.viewStart), Math.round(this.viewEnd)];
    var sc = this._scales(v);
    var W = this._plotW(), H = this._plotH();
    var yOf = function (val, axis) {
      var s = axis === "right" ? sc.right : sc.left;
      if (!s) s = sc.left;
      return self._padT + H - (val - s.lo) / (s.hi - s.lo) * H;
    };

    if (this.title) {
      ctx.font = "600 12.5px Inter, 'Segoe UI', sans-serif";
      ctx.fillStyle = "#c8d3ea";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(this.title, this._padL, 12);
    }

    this._drawGrid(ctx, v, sc, W, H, yOf);

    // bands first (under everything)
    for (var bi = 0; bi < this.bands.length; bi++) {
      var b = this.bands[bi];
      ctx.beginPath();
      var started = false;
      for (var i2 = v[0]; i2 <= v[1]; i2++) {
        var up = b.upper[i2], lo = b.lower[i2];
        if (up == null || lo == null || isNaN(up) || isNaN(lo)) continue;
        var xp = this._xPos(i2, total);
        if (!started) { ctx.moveTo(xp, yOf(up, "left")); started = true; }
        else ctx.lineTo(xp, yOf(up, "left"));
      }
      for (var i3 = v[1]; i3 >= v[0]; i3--) {
        var l2 = b.lower[i3];
        if (l2 == null || isNaN(l2)) continue;
        ctx.lineTo(this._xPos(i3, total), yOf(l2, "left"));
      }
      ctx.closePath();
      ctx.fillStyle = hexToRgba(b.color, 0.16);
      ctx.fill();
    }

    // bars
    var barSeries = this.series.filter(function (s) { return s.type === "bar"; });
    var barW = 0;
    if (barSeries.length) {
      var slot = W / Math.max(1, (v[1] - v[0] + 1));
      barW = Math.min(38, slot * 0.72);
    }
    for (var bs = 0; bs < barSeries.length; bs++) {
      var barS = barSeries[bs];
      var nSeries = barSeries.length;
      var off = (bs - (nSeries - 1) / 2) * (barW / Math.max(1, nSeries));
      var bw = barW / Math.max(1, nSeries);
      for (var j2 = v[0]; j2 <= v[1]; j2++) {
        var val = barS.data[j2];
        if (val == null || isNaN(val)) continue;
        var bx = this._xPos(j2, total) + off - bw / 2;
        var by = yOf(val, barS.axis);
        var zeroY = yOf(0, barS.axis);
        ctx.beginPath();
        if (by < zeroY) ctx.rect(bx, by, bw, zeroY - by);
        else ctx.rect(bx, zeroY, bw, by - zeroY);
        ctx.fillStyle = hexToRgba(barS.color, 0.85);
        ctx.fill();
        if (this.showValues === "bars") {
          ctx.fillStyle = "#cdd7f0"; ctx.font = "10.5px Inter, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = by < zeroY ? "bottom" : "top";
          var vlab = this.yFmt(val);
          if (String(vlab).length <= 6) ctx.fillText(vlab, bx + bw / 2, by < zeroY ? by - 3 : by + 12);
        }
      }
    }

    // reference lines
    for (var ri = 0; ri < this.refLines.length; ri++) {
      var r = this.refLines[ri];
      var ry = yOf(r.value, "left");
      ctx.setLineDash(r.dash ? [5, 4] : []);
      ctx.strokeStyle = r.color; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(this._padL, ry); ctx.lineTo(this._padL + W, ry); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = r.color; ctx.font = "600 10.5px Inter, sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText(r.label, this._padL + W, ry - 2);
    }

    // line series
    for (var ls = 0; ls < this.series.length; ls++) {
      var s2 = this.series[ls];
      if (s2.type === "bar") continue;
      var pts = [];
      for (var p = v[0]; p <= v[1]; p++) {
        var yv = s2.data[p];
        if (yv == null || isNaN(yv)) continue;
        pts.push({ x: this._xPos(p, total), y: yOf(yv, s2.axis), v: yv });
      }
      if (!pts.length) continue;
      if (s2.area) {
        var grad = ctx.createLinearGradient(0, this._padT, 0, this._padT + H);
        grad.addColorStop(0, hexToRgba(s2.color, 0.34));
        grad.addColorStop(1, hexToRgba(s2.color, 0));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, this._padT + H);
        smoothPath(ctx, pts);
        ctx.lineTo(pts[pts.length - 1].x, this._padT + H);
        ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
      }
      ctx.beginPath();
      ctx.strokeStyle = s2.color; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.lineCap = "round";
      if (s2.dash) ctx.setLineDash([6, 4]);
      if (s2.smooth) smoothPath(ctx, pts);
      else pts.forEach(function (q, i) { if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      ctx.stroke();
      ctx.setLineDash([]);

      // max/min markers
      if (this.markers && v[1] - v[0] <= 95 && s2.data.length >= 3) {
        var vi = this._visibleIndices(s2.data, v);
        if (vi.length) {
          var maxI = vi[0], minI = vi[0];
          vi.forEach(function (idx) {
            if (s2.data[idx] > s2.data[maxI]) maxI = idx;
            if (s2.data[idx] < s2.data[minI]) minI = idx;
          });
          if (maxI !== minI) {
            this._marker(ctx, this._xPos(maxI, total), yOf(s2.data[maxI], s2.axis), s2.data[maxI], s2.color, "max", W);
            this._marker(ctx, this._xPos(minI, total), yOf(s2.data[minI], s2.axis), s2.data[minI], s2.color, "min", W);
          }
        }
      } else if (this.markers && s2.data.length >= 3) {
        // zoomed: annotate only the visible extremes
        var vv = this._visibleIndices(s2.data, v);
        if (vv.length) {
          var mI = vv[0], nI = vv[0];
          vv.forEach(function (idx) { if (s2.data[idx] > s2.data[mI]) mI = idx; if (s2.data[idx] < s2.data[nI]) nI = idx; });
          if (mI !== nI) {
            this._marker(ctx, this._xPos(mI, total), yOf(s2.data[mI], s2.axis), s2.data[mI], s2.color, "max", W);
            this._marker(ctx, this._xPos(nI, total), yOf(s2.data[nI], s2.axis), s2.data[nI], s2.color, "min", W);
          }
        }
      }
    }

    this._drawXLabels(ctx, v, total);
    this._drawLegend(ctx, cssW);

    // hover tooltip
    if (this.hover && this.hover.x != null) this._drawHoverCrosshair(ctx, v, total, yOf);
  };

  Chart.prototype._visibleIndices = function (data, v) {
    var out = [];
    for (var i = v[0]; i <= v[1]; i++) if (data[i] != null && !isNaN(data[i])) out.push(i);
    return out;
  };

  Chart.prototype._marker = function (ctx, x, y, val, color, kind, W) {
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#0b1020";
    ctx.stroke();
    var label = (kind === "max" ? "Highest " : "Lowest ") + this.yFmt(val);
    ctx.font = "600 10.5px Inter, sans-serif";
    var tw = ctx.measureText(label).width + 10;
    var lx = x - tw / 2;
    lx = Math.max(this._padL + 2, Math.min(this._padL + W - tw - 2, lx));
    var ly = kind === "max" ? y - 22 : y + 14;
    if (ly < 6) ly = y + 14;
    ctx.fillStyle = hexToRgba(color, 0.14);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, tw, 17, 5) : ctx.rect(lx, ly, tw, 17);
    ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, lx + tw / 2, ly + 9);
  };

  Chart.prototype._drawGrid = function (ctx, v, sc, W, H, yOf) {
    ctx.font = "10px Inter, sans-serif";
    var niceTicks = function (lo, hi) {
      var span = hi - lo;
      var step = Math.pow(10, Math.floor(Math.log10(span || 1)));
      var frac = span / step;
      var mult = frac < 3 ? 0.5 : frac < 5 ? 1 : 2;
      step *= mult;
      var out = [], x = Math.ceil(lo / step) * step;
      for (var i = 0; i <= 6 && x <= hi + step * 0.001; i++) { out.push(x); x += step; }
      return out;
    };
    var ticks = niceTicks(sc.left.lo, sc.left.hi);
    for (var t = 0; t < ticks.length; t++) {
      var ty = yOf(ticks[t], "left");
      ctx.strokeStyle = "#22304e"; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this._padL, ty); ctx.lineTo(this._padL + W, ty); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#6b7a99"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(this.yFmt(ticks[t]), this._padL - 6, ty);
    }
    if (sc.right) {
      var ticksR = niceTicks(sc.right.lo, sc.right.hi);
      for (var t2 = 0; t2 < ticksR.length; t2++) {
        var ry = yOf(ticksR[t2], "right");
        ctx.fillStyle = "#6b7a99"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(this.yFmtRight(ticksR[t2]), this._padL + W + 6, ry);
      }
    }
    // vertical grid (sparse)
    var total = Math.max(1, this.pointCount() - 1);
    var span = v[1] - v[0] + 1;
    var step = Math.max(1, Math.ceil(span / 7));
    for (var vi = Math.ceil(v[0] / step) * step; vi <= v[1]; vi += step) {
      var vx = this._xPos(vi, total);
      ctx.strokeStyle = "#22304e"; ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(vx, this._padT); ctx.lineTo(vx, this._padT + H); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  Chart.prototype._drawXLabels = function (ctx, v, total) {
    var span = v[1] - v[0] + 1;
    var step = Math.max(1, Math.ceil(span / 6));
    ctx.font = "10px Inter, sans-serif";
    ctx.fillStyle = "#6b7a99";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var i = Math.ceil(v[0] / step) * step; i <= v[1]; i += step) {
      var lab = this.xLabels[i];
      if (lab == null) continue;
      ctx.fillText(String(lab), this._xPos(i, total), this._padT + this._plotH() + 8);
    }
  };

  Chart.prototype._drawLegend = function (ctx, cssW) {
    var items = [];
    var self = this;
    this.series.forEach(function (s) {
      items.push({ label: s.name, color: s.color, dash: s.type === "line" });
    });
    if (!items.length) return;
    ctx.font = "600 10.5px Inter, sans-serif";
    var x = this._padL;
    var y = this.title ? 28 : 4;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var w = ctx.measureText(it.label).width + 22;
      if (x + w > cssW - 10) break;
      if (it.dash) {
        ctx.strokeStyle = it.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(x + 12, y + 6); ctx.stroke();
      } else {
        ctx.fillStyle = it.color;
        ctx.fillRect(x, y + 2, 12, 8);
      }
      ctx.fillStyle = "#93a0ba"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(it.label, x + 16, y + 6);
      x += w;
    }
  };

  Chart.prototype._hover = function (mx, my) {
    var total = Math.max(1, this.pointCount() - 1);
    if (mx < this._padL || mx > this._padL + this._plotW() || my < this._padT || my > this._padT + this._plotH()) {
      this.hover = null; this._hideTip(); this.render(); return;
    }
    var span = this.viewEnd - this.viewStart || 1;
    var t = (mx - this._padL) / Math.max(1, this._plotW());
    var idx = Math.round(this.viewStart + t * span);
    idx = Math.max(0, Math.min(this.pointCount() - 1, idx));
    this.hover = { x: mx, y: my, idx: idx };
    this._showTip(idx);
    this.render();
  };

  Chart.prototype._drawHoverCrosshair = function (ctx, v, total, yOf) {
    var h = this.hover;
    var x = this._xPos(h.idx, total);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(148,163,184,.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, this._padT); ctx.lineTo(x, this._padT + this._plotH()); ctx.stroke();
    ctx.setLineDash([]);
    var self = this;
    this.series.forEach(function (s) {
      var val = s.data[h.idx];
      if (val == null || isNaN(val)) return;
      var py = yOf(val, s.axis);
      ctx.beginPath(); ctx.arc(x, py, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = "#0b1020"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = s.color; ctx.stroke();
    });
  };

  Chart.prototype._showTip = function (idx) {
    var tip = ensureTooltipHost();
    var html = "";
    if (this.xLabels[idx] != null) html += "<b>" + this._esc(this.xLabels[idx]) + "</b><br/>";
    this.series.forEach(function (s) {
      var val = s.data[idx];
      if (val == null || isNaN(val)) return;
      html += "<span style='color:" + s.color + "'>●</span> " + this._esc(s.name) + ": <b>" +
        this._esc(this.yFmt(val)) + "</b><br/>";
    }, this);
    this.bands.forEach(function (b) {
      var u = b.upper[idx], l = b.lower[idx];
      if (u == null || l == null || isNaN(u) || isNaN(l)) return;
      html += "<span style='color:" + b.color + "'>●</span> " + this._esc(b.name) + ": " +
        this._esc(this.yFmt(l)) + " – " + this._esc(this.yFmt(u)) + "<br/>";
    }, this);
    if (!html) { this._hideTip(); return; }
    tip.innerHTML = html;
    tip.style.display = "block"; tip.style.opacity = "1";
    var rect = this.cv.getBoundingClientRect();
    var tw = tip.offsetWidth || 180, th = tip.offsetHeight || 60;
    var lx = rect.left + this.hover.x + 14;
    var ly = rect.top + this.hover.y - th / 2;
    if (lx + tw > window.innerWidth - 8) lx = rect.left + this.hover.x - tw - 14;
    if (ly < 8) ly = 8;
    tip.style.left = lx + "px"; tip.style.top = ly + "px";
  };

  Chart.prototype._hideTip = function () {
    var tip = document.getElementById("pc-tooltip-host");
    if (tip) { tip.style.display = "none"; tip.style.opacity = "0"; }
  };

  Chart.prototype._esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]);
    });
  };

  window.PricingCharts = { Chart: Chart, Palette: Palette, hexToRgba: hexToRgba };
})();
