/* AI Pricing Assistant — Smart Dynamic Pricing Dashboard
 *
 * The core engine (AICore.answer) is pure: it takes a question, mode,
 * context and a data bundle and returns the 5-part response
 * (Answer / Reasoning / Business Impact / Recommended Action / Confidence).
 * It can be unit-tested in Node (module.exports) and runs in the browser.
 *
 * Beyond the data intents it solves general questions: arithmetic and
 * percentages (solveMath), dataset statistics (tryStats) and pricing/ML
 * concept explanations (KNOWLEDGE / tryKnowledge).
 */
"use strict";

const AICore = {
  currency: "$",
  monthNames: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],

  money(D, n) {
    return (D && D.currency ? D.currency : this.currency) + this.fmt(n, 2);
  },
  fmt(n, d = 2) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d });
  },
  pct(n) {
    if (n == null || isNaN(n)) return "—";
    return (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
  },
  conf(n) {
    n = Number(n) || 0;
    return n >= 75 ? "High" : n >= 50 ? "Medium" : "Low";
  },

  /* ----- intent matching ------------------------------------------------ */
  INTENTS: [
    { key: "compare",   boost: 4, re: [/\bcompare\b/, /\bvs\b/, /\bversus\b/, /\bdifference\b/, /\bbetween\b/] },
    { key: "whatif",    boost: 3, re: [/\bwhat.?if\b/, /\bwhat happens if\b/, /\bwhat.?if analysis\b/,
                                        /\bif (inventory|stock|competitor|discount|marketing)\b/,
                                        /\bshould i\s*(offer|give|apply|run)\b/] },
    { key: "manual_predict", boost: 3, re: [/\brecommend( the)? best price\b/, /\bbest price for maximum profit\b/,
                                            /\bpredict demand for this\b/, /\bforecast this new product\b/] },
    { key: "forecast",  boost: 2, re: [/\bforecast\b/, /\bnext (7|14|30|60|90) days\b/, /\bnext (week|month|quarter)\b/,
                                        /\bpredict demand\b/, /\bincreasing demand\b/, /\bseasonal\b/] },
    { key: "inventory", boost: 2, re: [/\b(stock|inventory)s?\b/, /\boverstock\b/, /\blow stock\b/, /\bsell out\b/,
                                        /\breorder\b/, /\brun(ning)? out\b/] },
    { key: "profit",    boost: 2, re: [/\bprofit\b/, /\brevenue\b/, /\bmost profitable\b/,
                                        /\bhighest profit\b/, /\bimprove profit\b/, /\bdecreasing\b/] },
    { key: "segment",   boost: 2, re: [/\bsegment\b/, /\bpremium\b/, /\bloyal\b/, /\bbudget\b/, /\bbargain\b/,
                                        /\bhigh value\b/, /\bat risk\b/, /\bcustomer(s)?\b/] },
    { key: "seasonal",  boost: 2, re: [/\bseason\b/, /\bbest month\b/, /\bholiday\b/, /\bweekday\b/, /\bweekend\b/,
                                        /\bsummer\b/, /\bwinter\b/, /\bmonsoon\b/, /\bfestival\b/, /\bwhich month\b/] },
    { key: "rl",        boost: 2, re: [/\brl\b/, /\bq-?value\b/, /\breinforcement\b/, /\bagent\b/, /\breward\b/,
                                        /\baction (selected|taken|recommended)\b/] },
    { key: "ml",        boost: 2, re: [/\bmodel\b/, /\bxgboost\b/, /\brandom forest\b/, /\blightgbm\b/, /\bcatboost\b/,
                                        /\br\s*2\b/, /\br²\b/, /\brmse\b/, /\bmae\b/, /\baccuracy\b/] },
    { key: "discount",  boost: 1, re: [/\bdiscount(s|ed)?\b/, /\boffer .*%?\b/, /\bmarkdown\b/, /\bsale\b/] },
    { key: "price_dir", boost: 1, re: [/\b(increase|decrease|raise|lower|drop|reduce|adjust|change).*price\b/,
                                        /\bshould i\b/] },
    { key: "business",  boost: 1, re: [/\bpromote\b/, /\bfastest growing\b/, /\bgrowing\b/, /\binsight\b/,
                                        /\bstrategy\b/, /\bsuggest\b/, /\bopportunit\b/, /\bbest product\b/] },
    { key: "price_why", boost: 1, re: [/\bwhy (is|was|did)\b/, /\bwhy.*(price|recommend|cost|pric)\b/, /\bpriced at\b/,
                                        /\bprice of\b/] },
    { key: "hello",     boost: 1, re: [/\bhi\b/, /\bhello\b/, /\bhey\b/, /\bhelp\b/, /\bwhat can you\b/] },
    { key: "math",      boost: 2, re: [/\b(calculate|compute|solve|math|how much is|how much does)\b/,
                                        /\b%\s*(of|off|increase|decrease)\b/, /\bmargin\b/, /\bmarkup\b/] },
    { key: "stats",     boost: 2, re: [/\bhow many\b/, /\b(average|avg)\s+(price|cost)\b/, /\b(total|overall|combined)\s+(revenue|profit|sales)\b/,
                                        /\bcheapest\b/, /\bmost expensive\b/, /\bhighest price\b/, /\blowest price\b/,
                                        /\bbest selling\b/, /\bmost sold\b/, /\bhighest margin\b/, /\bmost popular category\b/] },
    { key: "knowledge", boost: 1, re: [/\bwhat is\b/, /\bwhat are\b/, /\bwhat does\b/, /\bwhat's\b/, /\bhow does\b/,
                                        /\bhow do\b/, /\bexplain\b/, /\bdefine\b/, /\bmeaning\b/, /\bin simple terms\b/] },
    { key: "capabilities", boost: 3, re: [/\bwhat can you do\b/, /\bwhat do you do\b/, /\bcapabilit\w*\b/,
                                           /\bhow (do|can) i use\b/, /\bwhat are your skills\b/] },
    { key: "smalltalk", boost: 1, re: [/\bthank(s| you)?\b/, /\bthanks\b/, /\bbye\b/, /\bgoodbye\b/, /\bnice\b/, /\bgreat\b/] },
  ],

  detectIntent(q) {
    const text = " " + String(q).toLowerCase() + " ";
    let best = null;
    for (const it of this.INTENTS) {
      let s = 0;
      for (const r of it.re) if (r.test(text)) s += 1 + it.boost;
      if (s > 0 && (!best || s > best.score)) best = { key: it.key, score: s };
    }
    return best ? best.key : "default";
  },

  idsIn(q) {
    return String(q).match(/\bP\d{3}\b/g) || [];
  },

  /* ----- helpers on the data bundle -------------------------------------- */
  product(D, pid) {
    return (D.products || []).find(p => p.product_id === pid) || null;
  },
  bestModel(D) {
    const mm = D.overview && D.overview.model_metrics && D.overview.model_metrics.models;
    if (!mm) return null;
    return Object.keys(mm).reduce((a, b) => (mm[a].r2 > mm[b].r2 ? a : b));
  },
  highestMonth(D) {
    const ms = D.insights && D.insights.monthly_sales;
    if (!ms) return null;
    let best = null;
    for (const k of Object.keys(ms)) if (!best || ms[k] > ms[best]) best = k;
    return best;
  },

  /* ----- general question solving (math / stats / knowledge) ------------- */
  evalExpr(str) {
    const s = String(str).replace(/\s+/g, "");
    if (!/^[\d+\-*/().%^]+$/.test(s) || !/\d/.test(s)) return null;
    try {
      const out = [], ops = [];
      const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
      let num = "";
      const flush = () => { if (num !== "") { out.push(parseFloat(num)); num = ""; } };
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (/[\d.]/.test(c)) { num += c; continue; }
        flush();
        if (c === "(") ops.push(c);
        else if (c === ")") {
          while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
          if (!ops.length) return null;
          ops.pop();
        } else if (c in prec) {
          while (ops.length && ops[ops.length - 1] !== "(" && prec[ops[ops.length - 1]] >= prec[c]) out.push(ops.pop());
          ops.push(c);
        } else return null;
      }
      flush();
      while (ops.length) out.push(ops.pop());
      const st = [];
      for (const t of out) {
        if (typeof t === "number") st.push(t);
        else {
          const b = st.pop(), a = st.pop();
          if (a === undefined || b === undefined) return null;
          if (t === "+") st.push(a + b);
          else if (t === "-") st.push(a - b);
          else if (t === "*") st.push(a * b);
          else if (t === "/") st.push(b === 0 ? NaN : a / b);
          else if (t === "%") st.push(a % b);
          else if (t === "^") st.push(Math.pow(a, b));
        }
      }
      return st.length === 1 && isFinite(st[0]) ? st[0] : null;
    } catch (_) { return null; }
  },

  solveMath(q, D) {
    const s = String(q).toLowerCase();
    const money = (v) => this.money(D, Math.round(v * 100) / 100);
    const rnd = (v) => Math.round(v * 100) / 100;

    const m1 = s.match(/price\D{0,15}(\d+(?:\.\d+)?)\D{0,15}cost\D{0,15}(\d+(?:\.\d+)?)/);
    const m2 = s.match(/cost\D{0,15}(\d+(?:\.\d+)?)\D{0,15}(?:price|selling)\D{0,15}(\d+(?:\.\d+)?)/);
    if (/\bmargin\b|\bmarkup\b/.test(s)) {
      const pr = m1 ? +m1[1] : m2 ? +m2[2] : null;
      const cs = m1 ? +m1[2] : m2 ? +m2[1] : null;
      if (pr !== null && pr > 0 && cs !== null && cs >= 0) {
        const m = rnd((pr - cs) / pr * 100);
        return {
          answer: "At a price of " + money(pr) + " and cost of " + money(cs) + ", the margin is " + m + "% (gross profit " + money(pr - cs) + " per unit).",
          reasoning: "Margin = (price − cost) ÷ price × 100 = (" + pr + " − " + cs + ") ÷ " + pr + " × 100 ≈ " + m + "%.",
          businessImpact: "You keep " + m + "% of the selling price before other expenses — check that any discount stays above your minimum margin.",
          action: "Compare this against your target margin in the Price Recommendation panel.",
        };
      }
    }
    const pctOf = s.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/);
    if (pctOf) {
      const p = +pctOf[1], v = +pctOf[2], res = rnd(v * p / 100);
      return {
        answer: p + "% of " + v + " = " + res + ".",
        reasoning: p + " ÷ 100 × " + v + " = " + res + ".",
        businessImpact: "That is the size of a " + p + "% discount on a base of " + v + ".",
        action: "Apply the figure in the Price Recommendation panel or a promotion plan.",
      };
    }
    const pctOff = s.match(/(\d+(?:\.\d+)?)\s*%\s*off\s*(\d+(?:\.\d+)?)/);
    if (pctOff) {
      const p = +pctOff[1], v = +pctOff[2], res = rnd(v * (1 - p / 100)), saved = rnd(v - res);
      return {
        answer: p + "% off " + v + " = " + res + " (you save " + saved + ").",
        reasoning: "Discounted price = " + v + " × (1 − " + p + " ÷ 100) = " + res + ".",
        businessImpact: "Revenue per unit drops by " + saved + " — only discount when volume compensates or stock is at risk.",
        action: "Check the expected demand uplift in the what-if answers before launching the offer.",
      };
    }
    const disc = s.match(/(\d+(?:\.\d+)?)\D{0,20}?(\d+(?:\.\d+)?)\s*%\s*discount/);
    if (disc && +disc[1] > 0 && +disc[2] >= 0 && +disc[2] <= 100) {
      const base = +disc[1], p = +disc[2], res = rnd(base * (1 - p / 100));
      return {
        answer: "A " + p + "% discount on " + base + " gives " + res + ".",
        reasoning: "Discounted price = " + base + " × (1 − " + p + " ÷ 100) = " + res + ".",
        businessImpact: "You give up " + rnd(base - res) + " per unit — compare that with the margin to see if it still makes money.",
        action: "Verify the discounted price stays above cost before running the promotion.",
      };
    }
    const inc1 = s.match(/(\d+(?:\.\d+)?)\s*%\s*(?:increase|raise|up|more)\D{0,12}?(\d+(?:\.\d+)?)/);
    const inc2 = s.match(/(\d+(?:\.\d+)?)\D{0,12}?(?:increase|increased|raise|raised)\D{0,12}?(\d+(?:\.\d+)?)\s*%/);
    const inc3 = s.match(/(?:add|increase|raise)\D{0,12}?(\d+(?:\.\d+)?)\s*%\D{0,12}?(\d+(?:\.\d+)?)/);
    const inc = inc1 || inc2 || inc3;
    if (inc && +inc[1] >= 0 && +inc[1] <= 1000 && +inc[2] > 0) {
      const p = +inc[1], v = +inc[2], res = rnd(v * (1 + p / 100));
      return {
        answer: "A " + p + "% increase on " + v + " = " + res + ".",
        reasoning: "New value = " + v + " × (1 + " + p + " ÷ 100) = " + res + ".",
        businessImpact: "Raising a price by " + p + "% lifts revenue per unit to " + res + " — watch the demand reaction.",
        action: "Simulate the change in the what-if scenario before committing.",
      };
    }
    const dec1 = s.match(/(\d+(?:\.\d+)?)\s*%\s*(?:decrease|reduce|less|down)\D{0,12}?(\d+(?:\.\d+)?)/);
    const dec2 = s.match(/(\d+(?:\.\d+)?)\D{0,12}?(?:decreased|decrease|reduce|reduced|less)\D{0,12}?(\d+(?:\.\d+)?)\s*%/);
    const dec = dec1 || dec2;
    if (dec && +dec[1] >= 0 && +dec[1] <= 1000 && +dec[2] > 0) {
      const p = +dec[1], v = +dec[2], res = rnd(v * (1 - p / 100));
      return {
        answer: "A " + p + "% decrease on " + v + " = " + res + ".",
        reasoning: "New value = " + v + " × (1 − " + p + " ÷ 100) = " + res + ".",
        businessImpact: "The lower value frees cash flow but erodes per-unit margin — pair it with volume.",
        action: "Check the discounted price against cost in the Price Recommendation panel.",
      };
    }
    if (s.includes("%")) return null;
    const cleaned = s.replace(/[^0-9+\-*/().^]/g, "");
    if (cleaned && /[\d][+\-*/(^][\d(]|[(]/.test(cleaned.replace(/\s/g, ""))) {
      const v = this.evalExpr(cleaned);
      if (v !== null) {
        return {
          answer: cleaned.replace(/\s/g, "") + " = " + rnd(v) + ".",
          reasoning: "I evaluated the arithmetic expression you typed: " + cleaned.replace(/\s/g, "") + " = " + rnd(v) + ".",
          businessImpact: "Use the result for quick pricing, margin and scenario calculations.",
          action: "Ask follow-ups like \"What is 20% of that?\" or \"What if I discount 10%?\".",
        };
      }
    }
    return null;
  },

  tryStats(q, D) {
    const s = " " + String(q).toLowerCase() + " ";
    const ins = D.insights || {}, ov = D.overview || {};
    const prods = D.products || [];
    const money = (v) => this.money(D, v);
    const mean = (arr, k) => arr.length ? arr.reduce((a, x) => a + x[k], 0) / arr.length : null;
    const sum = (arr, k) => (arr || []).reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const fmt = (v) => Math.round(v * 100) / 100;
    const reply = (answer, reasoning, businessImpact, action, pct) => ({
      answer, reasoning, businessImpact, action, confidence: this.conf(pct), confidencePct: pct,
    });

    if (/\bhow many products\b/.test(s))
      return reply("The dataset contains " + (ins.product_count != null ? ins.product_count : prods.length) + " products.",
        "Counted from the uploaded dataset's product catalogue.", "Scope pricing work to the full catalogue.",
        "Ask \"Which product is the most expensive?\" next.", 92);
    if (/\bhow many customers\b/.test(s))
      return reply("There are " + (ov.customers != null ? ov.customers : (D.customers || []).length) + " customers in the loaded data.",
        "Customers are clustered into segments by loyalty, purchase count and average spend.",
        "Segment-aware pricing decisions rest on this base.", "Ask \"Which segment should get discounts?\" next.", 88);
    if (/\bhow many (records|rows|transactions|sales)\b/.test(s))
      return reply(ov.total_sales_rows != null ? "The dataset has " + ov.total_sales_rows + " sales records." : "The record count is not loaded in this context.",
        "Each record is one product-day sale row used to train the demand model.",
        "More history usually means more reliable forecasts.", "Ask \"Forecast next 30 days\" next.", 85);
    if (/\b(average|avg)\s+(?:product\s+)?price\b/.test(s)) {
      const avg = ov.avg_price != null ? ov.avg_price : (prods.length ? mean(prods, "base_price") : null);
      if (avg == null) return null;
      return reply("The average list price across the catalogue is " + money(fmt(avg)) + ".",
        "Average of every product's base price in the dataset (shown in your display currency).",
        "Compare this with your cost average to judge the overall margin level.",
        "Ask \"Which product has the highest margin?\" next.", 90);
    }
    if (/\b(average|avg)\s+cost\b/.test(s) && prods.length) {
      const c = mean(prods, "cost");
      if (c == null) return null;
      return reply("The average cost across the catalogue is " + money(fmt(c)) + ".",
        "Average of each product's unit cost.", "Cost structure drives the minimum price you can charge.",
        "Ask \"What is the margin if price is 100 and cost is 60?\" for a quick margin check.", 88);
    }
    if (/\b(total|overall|combined)\s+(revenue|profit|sales)\b/.test(s)) {
      const isProfit = /\bprofit\b/.test(s);
      const arr = isProfit ? ins.top_profit : ins.top_revenue;
      const total = sum(arr, isProfit ? "profit" : "revenue");
      if (!arr || !arr.length) return null;
      return reply("Total " + (isProfit ? "profit" : "revenue") + " across the tracked products is " + money(fmt(total)) + ".",
        "Summed from the " + (isProfit ? "profit" : "revenue") + " ranking of every product in the dataset.",
        "This is the headline number your pricing decisions move.", "Ask \"How can I improve profit?\" next.", 89);
    }
    if (/\bcheapest\b|\blowest price\b|\bleast expensive\b/.test(s)) {
      if (!prods.length) return null;
      const p = prods.reduce((a, b) => (b.base_price < a.base_price ? b : a));
      return reply(p.product_id + " is the cheapest at " + money(p.base_price) + " (cost " + money(p.cost) + ").",
        "Minimum base price over all products in the dataset.",
        "Low-priced SKUs often carry thin margins — verify before discounting.",
        "Ask \"Which product has the highest margin?\" next.", 90);
    }
    if (/\bmost expensive\b|\bhighest price\b|\bmost costly\b/.test(s)) {
      if (!prods.length) return null;
      const p = prods.reduce((a, b) => (b.base_price > a.base_price ? b : a));
      return reply(p.product_id + " is the most expensive at " + money(p.base_price) + " (cost " + money(p.cost) + ").",
        "Maximum base price over all products in the dataset.",
        "Premium SKUs usually have the most price headroom.",
        "Ask \"Should I increase the price of " + p.product_id + "?\" next.", 90);
    }
    if (/\bbest selling\b|\bmost sold\b|\btop selling\b|\bhighest demand\b/.test(s)) {
      const top = (ins.top_revenue || [])[0] || (ins.top_profit || [])[0];
      if (!top) return null;
      return reply("Best-selling product: " + top.product_id + " (revenue " + money(top.revenue != null ? top.revenue : top.profit) + ").",
        "Ranked by total revenue (price × units) from the sales history.",
        "Protect this SKU's stock and margin — it funds the catalogue.",
        "Ask \"Which products need discounts?\" to see where to put promotions instead.", 86);
    }
    if (/\bhighest margin\b|\bbest margin\b/.test(s) && prods.length) {
      const p = prods.reduce((a, b) => {
        const ma = (a.base_price - a.cost) / a.base_price, mb = (b.base_price - b.cost) / b.base_price;
        return mb > ma ? b : a;
      });
      const m = Math.round((p.base_price - p.cost) / p.base_price * 100);
      return reply(p.product_id + " has the highest margin at " + m + "% (price " + money(p.base_price) + ", cost " + money(p.cost) + ").",
        "Margin = (price − cost) ÷ price over every product in the dataset.",
        "High-margin SKUs absorb discounts better and deserve promotion spend.",
        "Ask \"Should I increase the price?\" next.", 89);
    }
    if (/\bmost popular category\b|\bbest category\b/.test(s)) {
      const c = ins.best_revenue_category;
      if (!c) return null;
      return reply("Most popular category: " + c.name + " (revenue " + money(c.revenue != null ? c.revenue : 0) + ").",
        "Categories are ranked by total revenue from the sales history.",
        "Concentrate marketing where revenue already concentrates.",
        "Ask \"Which segment should get discounts?\" next.", 85);
    }
    return null;
  },

  KNOWLEDGE: [
    {
      re: /\belastic\w*\b/,
      fn(D) {
        return {
          answer: "Price elasticity of demand measures how much units sold change when price changes. If elasticity is −1.5, a 10% price cut lifts demand by roughly 15%.",
          reasoning: "Elasticity = %Δ quantity ÷ %Δ price. |E| > 1 is elastic (customers respond strongly to price); |E| < 1 is inelastic. This dashboard estimates per-product elasticity from log-log demand fits — values between −0.8 and −1.6 on the sample data.",
          businessImpact: "Elastic products are dangerous to raise but respond to discounts; inelastic ones can take price increases with little volume loss.",
          action: "Use the Price Recommendation panel per product, then validate the elasticity assumptions after 2–3 weeks of real demand.",
          confidence: "High", confidencePct: 88,
        };
      },
    },
    {
      re: /\bdynamic pricing\b|\bwhat is smart dynamic\b|\breal.?time pricing\b/,
      fn(D) {
        return {
          answer: "Dynamic pricing adjusts prices continuously (or per review cycle) to match demand, inventory, competition and seasonality — instead of a fixed list price.",
          reasoning: "The pipeline here fits demand models (Linear/Random Forest/Gradient Boosting/XGBoost), then a grid-search picks the revenue- or profit-maximising price under business rules (no price below cost, max +20% single-step changes).",
          businessImpact: "Correctly tuned, it raises revenue and cuts stockouts and stale inventory; badly tuned it can erode trust — hence the reliability scores and rule constraints.",
          action: "Start with the recommended prices for the top SKUs and review weekly rather than switching everything at once.",
          confidence: "High", confidencePct: 90,
        };
      },
    },
    {
      re: /\bseasonal\w*|\bholiday|\bweekend\b/,
      fn(D) {
        return {
          answer: "Seasonality is the repeating pattern in demand — monthly peaks (festivals, weather), weekday vs weekend lifts and holiday spikes.",
          reasoning: "The demand model encodes seasonality via the calendar month plus a sinusoidal seasonal factor; the dashboard also aggregates weekday/weekend averages so you can see the pattern directly.",
          businessImpact: "Stocking and promoting ahead of peak months captures the extra demand; weekend-only promos concentrate lift where it is strongest.",
          action: "Plan inventory and campaigns around your best month (ask \"Which month performs best?\") and schedule weekend promos.",
          confidence: "High", confidencePct: 87,
        };
      },
    },
    {
      re: /\bforecast\w*|\barima\b|\bsmoothing\b/,
      fn(D) {
        return {
          answer: "Demand forecasting projects future units from historical sales — the dashboard shows a 7/14/30-day forecast with a confidence band around recent averages and trend.",
          reasoning: "Forecasts here scale the recent daily rate, apply the observed trend and monthly seasonality, and a horizon-wide confidence band reflects the uncertainty that grows with distance.",
          businessImpact: "Reliable forecasts drive reorder quantities, promotion timing and revenue targets.",
          action: "Ask \"Forecast next 30 days\" for a product, then set reorder levels from the 30-day figure.",
          confidence: "High", confidencePct: 85,
        };
      },
    },
    {
      re: /\br\s*2\b|\br²\b|r-squared|r squared|coefficient of determination|\brmse\b|\bmae\b|mean absolute error|root mean squared|\baccuracy\b/,
      fn(D) {
        return {
          answer: "R² (R-squared) is the share of demand variance the model explains — 1.0 is perfect, 0 means no better than the average. MAE/RMSE are average prediction errors in units sold.",
          reasoning: "R² = 1 − (sum of squared errors ÷ total variance). MAE is the mean absolute error; RMSE penalises big misses more. The dashboard compares all four models on the hold-out set and picks the best R²/RMSE.",
          businessImpact: "On the sample data XGBoost reaches R² ≈ 0.46 — the model explains almost half of demand variation, which is a healthy signal for real pricing data.",
          action: "Ask \"Which model performs best?\" to see the live comparison.",
          confidence: "High", confidencePct: 90,
        };
      },
    },
    {
      re: /\breinforcement|\bq-?value\b|\bq learning\b|\brl agent\b/,
      fn(D) {
        return {
          answer: "Reinforcement learning (RL) is trial-and-error learning: an agent takes price actions, observes the profit outcome, and updates Q-values that estimate the long-run value of each action in each market state.",
          reasoning: "State here = inventory, demand pressure and competitor gap. The agent picks the highest-Q action (exploit) while learning steps refine the estimates, so the price adapts as the market shifts.",
          businessImpact: "RL prices track the market state better than a static price, lifting cumulative expected profit over time.",
          action: "Ask \"Explain the RL agent decision\" to see the live action, Q-values and state.",
          confidence: "High", confidencePct: 86,
        };
      },
    },
    {
      re: /\bsegment|\bcluster|\bk-?means\b/,
      fn(D) {
        return {
          answer: "Customer segmentation groups buyers by behaviour — loyalty score, purchase count and average spend — into Premium, Loyal, Regular and Bargain-seeker clusters.",
          reasoning: "Clustering (K-Means) finds groups that behave differently: Premium customers are price-insensitive, Bargain seekers buy on discount. Pricing strategy differs per group.",
          businessImpact: "Segment-aware pricing lifts margin: big discounts go to Bargain seekers, premium products hold price for Premium buyers.",
          action: "Ask \"Which segment should get discounts?\" for the live breakdown.",
          confidence: "High", confidencePct: 87,
        };
      },
    },
    {
      re: /\bmargin\b|\bmarkup\b/,
      fn(D) {
        return {
          answer: "Margin is the share of the selling price left after cost: (price − cost) ÷ price × 100. A $100 product costing $60 has a 40% margin.",
          reasoning: "Margin tells you how much room you have to discount or absorb costs before losing money; markup is cost × (1 + rate), a related but different convention.",
          businessImpact: "Every discount you offer comes straight out of margin — 10% off a 40%-margin product cuts margin to 33%.",
          action: "Ask \"What is the margin if price is 100 and cost is 60?\" for instant calculations.",
          confidence: "High", confidencePct: 92,
        };
      },
    },
    {
      re: /\bprofit\b|\brevenue\b/,
      fn(D) {
        return {
          answer: "Revenue is what customers pay you (price × units sold); profit is what you keep after costs ((price − cost) × units sold).",
          reasoning: "The dashboard aggregates both over the full sales history and ranks products and categories by each, so you can see where margin concentrates.",
          businessImpact: "Raising price lifts revenue per unit but can cut demand; the optimizer balances the two to protect profit.",
          action: "Ask \"Which products are most profitable?\" or \"How can I improve profit?\".",
          confidence: "High", confidencePct: 90,
        };
      },
    },
    {
      re: /\boptimiz|\bgrid search|\bsweep\b|\bprice ceiling\b|\brecommendation algorithm\b/,
      fn(D) {
        return {
          answer: "Price optimization searches candidate prices between cost and the competitive ceiling, predicting demand at each and picking the price that maximises revenue (or profit).",
          reasoning: "The engine sweeps a candidate grid, applies the trained demand model to each price, respects business rules (floor at cost, max +20% single step) and reports reliability from history depth and fit.",
          businessImpact: "The chosen price is the revenue-maximising point on the estimated demand curve — with the caveat that it is a model estimate, not a guarantee.",
          action: "Use the Price Recommendation panel and re-run after 7 days of new data.",
          confidence: "High", confidencePct: 88,
        };
      },
    },
    {
      re: /\bcross-?validat|\bhold-?out\b|\btrain.?test\b|\boverfit\b/,
      fn(D) {
        return {
          answer: "Cross-validation and hold-out evaluation split the data so the model is tested on sales it never trained on — the honest way to measure accuracy.",
          reasoning: "This pipeline uses 5-fold CV plus an 80/20 hold-out: CV scores are averaged over 5 folds, hold-out is a final unseen test. Models that score well only on training data are overfitted.",
          businessImpact: "Honest evaluation is why the dashboard can quote R², MAE and RMSE with confidence and pick a genuinely better model.",
          action: "Ask \"Which model performs best?\" to see the live comparison.",
          confidence: "High", confidencePct: 91,
        };
      },
    },
    {
      re: /\bfeature\b|\binfluenc\w*/,
      fn(D) {
        return {
          answer: "Feature importance ranks which inputs (price, weekend, rolling 7-day units, seasonal factor, inventory, weather) drive predicted demand the most.",
          reasoning: "The pipeline computes importances from the trained tree ensembles and normalises them to sum to 1 — the top features explain most of the model's decisions.",
          businessImpact: "Knowing the drivers tells you whether to act on price, promotion timing or stock allocation first.",
          action: "Ask \"Which features most influence demand?\" for the live list.",
          confidence: "High", confidencePct: 86,
        };
      },
    },
    {
      re: /\bnegotiat|\bconcession|\bbargain|\bdeal\b/,
      fn(D) {
        return {
          answer: "Negotiation is the assisted conversation flow that haggles over price within your pre-set margin and budget limits, conceding step by step instead of slashing price in one shot.",
          reasoning: "The negotiator scores each offer against the segment's willingness to pay, your cost floor and the profit budget, and only concedes when the customer's position warrants it.",
          businessImpact: "Systematic concessions capture revenue that a flat \"no\" would lose, while the floor protects margin.",
          action: "Ask \"Negotiate\"-style questions after uploading a dataset to try it live.",
          confidence: "High", confidencePct: 84,
        };
      },
    },
    {
      re: /\binventory|\breorder|\bstock-?out\b|\bdays of stock\b/,
      fn(D) {
        return {
          answer: "Inventory intelligence flags sell-out risk and overstock: days of stock = current inventory ÷ average daily units, with under 7 days flagged low and 60–90+ days flagged overstock.",
          reasoning: "The dashboard computes days-of-stock per SKU and suggests reorder quantities (14 days of demand − current stock).",
          businessImpact: "Low stock loses sales; overstock ties up cash. Both are priced in: the optimizer caps demand by what is on the shelf.",
          action: "Ask \"Which products are running out of stock?\" for the live list.",
          confidence: "High", confidencePct: 89,
        };
      },
    },
    {
      re: /\bdashboard\b|\bthis (app|tool|website)\b|\bwhat is smart\b/,
      fn(D) {
        return {
          answer: "This is a Smart Dynamic Pricing control center: it uploads your sales CSV, trains four demand models, then drives price recommendations, forecasts, profit/inventory/segment insights, an RL price agent, negotiation and this AI assistant.",
          reasoning: "Frontend + FastAPI backend (Render): the backend cleans data, runs 5-fold CV + hold-out model comparison and the rule-constrained price optimizer; the dashboard visualises everything.",
          businessImpact: "One pipeline from raw sales history to recommended prices with business rules and reliability scores.",
          action: "Upload a dataset, then ask me anything about the results.",
          confidence: "High", confidencePct: 90,
        };
      },
    },
  ],

  tryKnowledge(q, D) {
    const s = " " + String(q).toLowerCase() + " ";
    for (const t of this.KNOWLEDGE) {
      if (t.re.test(s)) return t.fn.call(this, D);
    }
    return null;
  },

  /* ----- the 5-part answer ---------------------------------------------- */
  async answer(q, mode, ctx, D) {
    const intent = this.detectIntent(q);
    const isConcept = /\b(what is|what are|what does|what's|define|meaning)\b/i.test(q);
    if (isConcept && ["profit", "inventory", "segment", "seasonal", "discount", "ml", "business", "forecast", "rl", "price_why", "price_dir"].indexOf(intent) >= 0) {
      const k = this.tryKnowledge(q, D);
      if (k) return Object.assign({ intent: "knowledge", mode }, k);
    }
    const handler = this.handlers[intent] || this.handlers.default;
    try {
      return await handler.call(this, q, mode, ctx || {}, D);
    } catch (e) {
      return {
        intent, mode,
        answer: "I could not compute that with the available data right now.",
        reasoning: "Detail: " + (e && e.message ? e.message : String(e)),
        businessImpact: "No change recommended until the input is corrected.",
        action: "Re-run the request.",
        confidence: "Low", confidencePct: 15,
      };
    }
  },

  handlers: {
    /* ---------------------------------------------------------------- */
    async hello(q, mode, ctx, D) {
      const ins = D.insights || {};
      return {
        intent: "hello", mode,
        answer: "I am AI, I'm here to help you. I can explain pricing recommendations, forecast demand, surface profit, inventory, segment, seasonal, ML and RL insights, run what-if scenarios, solve math (percentages, margins, expressions), answer dataset statistics and explain pricing & ML concepts.",
        reasoning: "Currently loaded: " + (ins.product_count || D.products?.length || 0) +
          " products, " + (D.customers ? D.customers.length : 0) + " customers, and full sales-history aggregates.",
        businessImpact: "Faster, data-backed price and stock decisions across the catalogue.",
        action: "Try: \"Why is this product priced this way?\", \"Forecast next 30 days\", \"What is 20% of 500?\", \"What is price elasticity?\", or \"What can you do?\".",
        confidence: "High", confidencePct: 90,
        chips: ["Why is this price recommended?", "Forecast next 30 days", "Which products need discounts?", "What is 20% of 500?", "What can you do?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async price_why(q, mode, ctx, D) {
      if (mode === "manual" && ctx.manual) {
        const r = await D.manual(ctx.manual);
        const o = r.optimal, c = r.current;
        return {
          intent: "price_why", mode,
          answer: "For this product the model recommends " + this.money(D, o.recommended_price) +
            " vs. the current effective price of " + this.money(D, c.price) +
            " (" + this.pct(o.price_delta_pct) + ").",
          reasoning: "The demand model sweeps prices from cost (" + this.money(D, ctx.manual.cost) +
            ") up to the competitive ceiling and picks the point that maximises revenue = price × min(predicted demand, stock). " +
            "Top influences: " + (r.feature_impacts || []).slice(0, 3).map(i => i.label + " (" + this.pct(i.impact_pct) + " demand)").join(", ") + ".",
          businessImpact: "At the recommended price expected demand is " + this.fmt(o.demand, 1) +
            " units, revenue " + this.money(D, o.revenue) + " and profit " + this.money(D, o.profit) +
            " (confidence " + r.confidence_pct + "%).",
          action: "Set the selling price to " + this.money(D, o.recommended_price) + " if your goal is revenue/profit, then monitor demand.",
          confidence: this.conf(r.confidence_pct), confidencePct: r.confidence_pct,
          chips: ["What if I offer a 10% discount?", "What if competitor price increases 10%?", "Should I increase the price?"],
        };
      }
      const pid = this.idsIn(q)[0] || ctx.pid || (D.products && D.products[0] && D.products[0].product_id);
      const prod = this.product(D, pid);
      if (!prod) throw new Error("unknown product " + pid);
      const rec = await D.price({ product_id: pid, inventory: 50, demand_pressure: 0.5 });
      const delta = (rec.recommended_price - prod.base_price) / prod.base_price * 100;
      return {
        intent: "price_why", mode,
        answer: this.hero(prod.product_id) + " is currently listed at " + this.money(D, prod.base_price) +
          " (cost " + this.money(D, prod.cost) + "). The model recommends " + this.money(D, rec.recommended_price) +
          " (" + this.pct(delta) + ") for the current market.",
        reasoning: "With a " + this.money(D, prod.base_price) + " base price, " + this.money(D, rec.cost) + " cost and a competitor price of " +
          this.money(D, rec.competitor_price) + ", the grid-search picks the price that maximises expected revenue given inventory (" +
          rec.inventory + " units) and demand pressure. This product sits in the " + prod.category + " category.",
        businessImpact: "Expected demand " + this.fmt(rec.expected_demand, 1) + " units, expected revenue " +
          this.money(D, rec.expected_revenue) + " at the recommended price.",
        action: "Adopt the recommended price now, and re-run it after 7 days when new sales data lands.",
        confidence: "High", confidencePct: 82,
        chips: ["Should I increase the price?", "Compare this with " + (this.idsIn(q)[0] ? "another product" : "P015"), "What if inventory drops to 20?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async compare(q, mode, ctx, D) {
      const ids = this.idsIn(q);
      if (ids.length < 2) {
        const a = ctx.pid || (D.products && D.products[0].product_id);
        const b = (D.products || []).find(p => p.product_id !== a);
        return {
          intent: "compare", mode,
          answer: "Name two products to compare, e.g. \"Compare P010 with P015\".",
          reasoning: "I compare base price, cost, margin, recommended price, expected demand and revenue for the two products using the trained demand model.",
          businessImpact: "A side-by-side view highlights which product has the higher margin and revenue headroom.",
          action: "Re-ask with two product IDs (e.g. P010 vs P015).",
          confidence: "Low", confidencePct: 40,
          chips: ["Compare " + a + " with " + (b ? b.product_id : "P015")],
        };
      }
      const rows = await Promise.all(ids.map(async pid => {
        const prod = this.product(D, pid);
        const rec = await D.price({ product_id: pid, inventory: 50, demand_pressure: 0.5 });
        return { prod, rec };
      }));
      const mk = (r) => this.money(D, r.prod.base_price) + " base, " + this.money(D, r.prod.cost) + " cost (" +
        Math.round((r.prod.base_price - r.prod.cost) / r.prod.base_price * 100) + "% margin), recommended " +
        this.money(D, r.rec.recommended_price) + ", demand " + this.fmt(r.rec.expected_demand, 1) + ", revenue " + this.money(D, r.rec.expected_revenue);
      return {
        intent: "compare", mode,
        answer: rows[0].prod.product_id + ": " + mk(rows[0]) + ". " + rows[1].prod.product_id + ": " + mk(rows[1]) + ".",
        reasoning: "Both predictions use the same demand model with a 50-unit inventory and 0.5 demand pressure, so the comparison isolates price positioning and cost structure.",
        businessImpact: "Prefer the product with the higher profit per unit unless demand headroom favours the other.",
        action: "Deep-dive the better candidate in the Price Recommendation panel, or run the RL agent on it.",
        confidence: "High", confidencePct: 84,
        chips: ["Should I increase the price of " + rows[0].prod.product_id + "?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async price_dir(q, mode, ctx, D) {
      if (mode === "manual" && ctx.manual) {
        const r = await D.manual(ctx.manual);
        const o = r.optimal;
        const dir = o.price_delta_pct > 0.5 ? "increase" : o.price_delta_pct < -0.5 ? "decrease" : "hold";
        return {
          intent: "price_dir", mode,
          answer: "You should " + dir + " the price — the optimum is " + this.money(D, o.recommended_price) +
            " (" + this.pct(o.price_delta_pct) + " from your current effective price).",
          reasoning: "At the current price expected profit is " + this.money(D, r.current.profit) + "; at the optimum it is " +
            this.money(D, o.profit) + ". Raising price dampens demand but lifts margin (see feature impacts), so the model balances both.",
          businessImpact: "Moving to the optimum changes profit by " + this.money(D, Math.round((o.profit - r.current.profit) * 100) / 100) + ".",
          action: "Move to " + this.money(D, o.recommended_price) + " in one step, then track 7-day demand.",
          confidence: this.conf(r.confidence_pct), confidencePct: r.confidence_pct,
          chips: ["What if I change the price by 5%?", "What if I change the price by 20%?"],
        };
      }
      const pid = ctx.pid || (D.products && D.products[0].product_id);
      const prod = this.product(D, pid);
      const rec = await D.price({ product_id: pid, inventory: 50, demand_pressure: 0.5 });
      const delta = (rec.recommended_price - prod.base_price) / prod.base_price * 100;
      const dir = delta > 0.5 ? "increase" : delta < -0.5 ? "decrease" : "hold";
      return {
        intent: "price_dir", mode,
        answer: "For " + prod.product_id + ", the model says " + dir + " the price: recommended " +
          this.money(D, rec.recommended_price) + " vs. current " + this.money(D, prod.base_price) + ".",
        reasoning: "This reflects the revenue-maximising balance between price, elastic demand, competitor position and the " +
          rec.inventory + "-unit stock cap. A change of " + this.pct(delta) + " is what the demand curve supports right now.",
        businessImpact: "Expected revenue at the recommended price is " + this.money(D, rec.expected_revenue) + " with demand " +
          this.fmt(rec.expected_demand, 1) + " units.",
        action: "Apply the " + this.pct(delta) + " change and re-check next week; do not move more than the model suggests without testing.",
        confidence: "High", confidencePct: 80,
        chips: ["What if I change the price by 10%?", "Which products should increase price?", "Which products need discounts?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async whatif(q, mode, ctx, D) {
      let fields = ctx.manual ? Object.assign({}, ctx.manual) : null;
      if (!fields) {
        const pid = ctx.pid || (D.products && D.products[0].product_id);
        const prod = this.product(D, pid) || { base_price: 50, cost: 25 };
        const now = new Date();
        fields = {
          product_name: prod.product_id, category: prod.category || "General",
          price: prod.base_price, cost: prod.cost, inventory: 50,
          competitor: prod.base_price, discount_pct: 0, demand_pressure: 0.5,
          marketing_spend: 0, customer_rating: 4, season: "Normal",
          holiday: false, weekend: 1, month: now.getMonth() + 1, dow: 5,
        };
      }
      let applied = "";
      const invM = String(q).match(/\b(?:inventory|stock)\s*(?:drops|drops to|to|by)\s*(\d+)/i);
      const compM = String(q).match(/\bcompetitor(?: price)?\s*(?:increases|up|rises|goes up)\s*(?:by\s*)?(\d+)?\s*%/i);
      const discM = String(q).match(/\b(?:offer|give|apply|run)(?: a)?\s*(\d+(?:\.\d+)?)\s*%\s*discount/i);
      const priceM = String(q).match(/\bchange(?: the)? price(?: by)?\s*(\d+(?:\.\d+)?)?\s*%/i);
      const scen = invM ? "inventory" : compM ? "competitor" : discM ? "discount" : priceM ? "price" : null;
      if (invM) { fields.inventory = +invM[1]; applied = "inventory drops to " + invM[1] + " units"; }
      else if (compM) { fields.competitor = Math.round(fields.competitor * (1 + (+compM[1] || 10) / 100) * 100) / 100; applied = "competitor price increases by " + (+compM[1] || 10) + "%"; }
      else if (discM) { fields.discount_pct = +discM[1]; applied = "a " + discM[1] + "% discount is offered"; }
      else if (priceM) { const p = fields.price * (1 + (+priceM[1] || 5) / 100); fields.price = Math.round(p * 100) / 100; applied = "price changes by " + (+priceM[1] || 5) + "%"; }
      else {
        return {
          intent: "whatif", mode,
          answer: "Tell me the scenario, e.g. \"What if inventory drops to 20?\", \"What if competitor price increases by 10%?\" or \"Should I offer a 15% discount?\".",
          reasoning: "I recompute demand, revenue and profit with the changed input while keeping everything else fixed.",
          businessImpact: "You can compare any single-variable scenario in seconds.",
          action: "Re-ask with one changed input.",
          confidence: "Low", confidencePct: 45,
          chips: ["What if inventory drops to 20?", "What if competitor price increases by 10%?", "Should I offer a 15% discount?"],
        };
      }
      const base = await D.manual(ctx.manual ? ctx.manual : fields);
      const changed = await D.manual(fields);
      const bp = base.current.profit, cp = changed.current.profit;
      return {
        intent: "whatif", mode,
        answer: "If " + applied + ", demand becomes " + this.fmt(changed.current.demand, 1) + " units, revenue " +
          this.money(D, changed.current.revenue) + " and profit " + this.money(D, changed.current.profit) + " (was " + this.money(D, bp) + ").",
        reasoning: "All other inputs stayed fixed; only " + applied + " changed. The demand model converts that into new units and margin.",
        businessImpact: "Profit impact " + this.money(D, Math.round((cp - bp) * 100) / 100) +
          (cp >= bp ? " — the scenario is favourable." : " — the scenario erodes profit."),
        action: cp >= bp ? "Proceed with the change and validate on a small product group." : "Avoid the change, or pair it with a cost/stock adjustment.",
        confidence: "Medium", confidencePct: 66,
        chips: ["Compare with a 10% discount", "What if inventory drops to 20?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async manual_predict(q, mode, ctx, D) {
      if (!ctx.manual) {
        const pid = ctx.pid || (D.products && D.products[0].product_id);
        const prod = this.product(D, pid) || {};
        return {
          intent: "manual_predict", mode,
          answer: "I can predict for any product already in the dataset. Pick a product and ask \"Recommend the best price\".",
          reasoning: "For " + (pid || "your product") + " I can optimise the price from the dataset.",
          businessImpact: "Test price scenarios before committing stock.",
          action: "Pick a product, then ask \"Recommend the best price for maximum profit\".",
          confidence: "Low", confidencePct: 40,
          chips: ["Predict demand for this new product", "Recommend the best price for maximum profit"],
        };
      }
      const r = await D.manual(ctx.manual);
      const o = r.optimal, c = r.current;
      return {
        intent: "manual_predict", mode,
        answer: "Predicted demand at your current effective price (" + this.money(D, c.price) + ") is " + this.fmt(c.demand, 1) +
          " units → revenue " + this.money(D, c.revenue) + ", profit " + this.money(D, c.profit) +
          " (" + c.margin_pct + "% margin). The profit-maximising price is " + this.money(D, o.recommended_price) +
          " (" + this.pct(o.price_delta_pct) + ").",
        reasoning: "The demand model was applied to your inputs. Biggest demand drivers: " +
          (r.feature_impacts || []).slice(0, 3).map(i => i.feature + " " + this.pct(i.impact_pct)).join(", ") + ".",
        businessImpact: "At the optimum, revenue is " + this.money(D, o.revenue) + " and profit " + this.money(D, o.profit) +
          ", with confidence " + r.confidence_pct + "%.",
        action: "Use " + this.money(D, o.recommended_price) + " as the launch price, or test a discount in the form and Predict again.",
        confidence: this.conf(r.confidence_pct), confidencePct: r.confidence_pct,
        chips: ["Should I offer a 10% discount?", "What if competitor price increases 10%?", "Why is this price recommended?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async forecast(q, mode, ctx, D) {
      const ins = D.insights || {};
      const pid = ctx.pid || (D.products && D.products[0].product_id);
      let daily = 28;
      let trend = 0;
      try {
        const s = await D.sales(pid);
        const u = s.units_sold || [];
        if (u.length) {
          daily = u.slice(-7).reduce((a, b) => a + b, 0) / Math.min(u.length, 7);
          const half = Math.floor(u.length / 2);
          const a = u.slice(0, half).reduce((x, y) => x + y, 0) / half;
          const b = u.slice(half).reduce((x, y) => x + y, 0) / (u.length - half);
          trend = ((b - a) / a) * 100;
        }
      } catch (_) { /* fall back to the api() path */ }
      const month = this.highestMonth(D);
      const f = (days) => Math.round(daily * (days / 7) * (1 + trend / 100 / 4));
      return {
        intent: "forecast", mode,
        answer: "For " + pid + " (recent 7-day average ≈ " + this.fmt(daily, 1) + " units/day, trend " + this.pct(trend) +
          "), I estimate ~" + f(7) + " units in 7 days, ~" + f(30) + " in 30 days and ~" + f(90) + " in 90 days.",
        reasoning: "The 7/30/90 estimates scale the recent daily rate and apply the recent trend plus month seasonality. " +
          (month ? "Sales peak in " + this.monthNames[+month - 1] + " across the catalogue, so adjust upward if you are near that month." : ""),
        businessImpact: "These volumes feed stock planning and the revenue forecast for the next quarter.",
        action: "Set reorder levels using the 30-day figure, and check the Inventory Intelligence answers for stockout risk.",
        confidence: "Medium", confidencePct: 62,
        chips: ["Which products have increasing demand?", "Which products may sell out soon?", "Which month performs best?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async inventory(q, mode, ctx, D) {
      const ins = D.insights || {};
      const low = ins.low_stock || [];
      const over = ins.overstock || [];
      const all = ins.inventory || [];
      const parts = [];
      if (low.length) parts.push("Sell-out risk: " + low.map(i => i.product_id + " (" + i.days_left + "d left, " + i.inventory + " units)").join(", "));
      if (over.length) parts.push("Overstocked: " + over.map(i => i.product_id + " (" + i.inventory + " units, " + i.days_left + "d cover)").join(", "));
      const mkReorder = (i) => Math.max(0, Math.round(i.avg_daily * 14 - i.inventory));
      return {
        intent: "inventory", mode,
        answer: parts.length ? parts.join(". ") + "." : "No acute stock risks in the current dataset.",
        reasoning: "Days-of-stock = current inventory ÷ average daily units (last 7 days). Under 7 days is flagged as low stock; over 60–90 days as overstock. Reorder suggestion = 14 days of demand minus current stock.",
        businessImpact: "Fixing the flagged SKUs prevents lost sales (low stock) and frees cash tied in inventory (overstock).",
        action: (low.length ? "Reorder " + low.map(i => i.product_id + " ≈ " + mkReorder(i) + " units").join(", ") + "." : "No urgent reorders needed.") +
          (over.length ? " Discount or promote the overstocked SKUs." : ""),
        confidence: "High", confidencePct: 85,
        chips: ["Which products are running out of stock?", "Which products are overstocked?", "Recommend reorder quantity"],
      };
    },

    /* ---------------------------------------------------------------- */
    async profit(q, mode, ctx, D) {
      const ins = D.insights || {};
      const topP = ins.top_profit || [];
      const topR = ins.top_revenue || [];
      const cat = ins.best_profit_category;
      const str = (a) => a.slice(0, 3).map(x => x.product_id + " (" + this.money(D, x.profit) + ")").join(", ");
      return {
        intent: "profit", mode,
        answer: "Highest-profit products: " + str(topP) + ". Most profitable category: " +
          (cat ? cat.name + " (" + this.money(D, cat.profit) + ")" : "n/a") + ". Top revenue: " +
          (topR[0] ? topR[0].product_id + " (" + this.money(D, topR[0].revenue) + ")" : "n/a") + ".",
        reasoning: "Profit = (price − cost) × units sold aggregated over the full sales history; revenue aggregates price × units. Category profit shows where margin concentrates.",
        businessImpact: "Focus marketing and stock on the top-profit SKUs; protect their margins rather than discounting them.",
        action: "Raise prices modestly on top-profit products, discount overstocked ones, and review cost lines on low-margin SKUs.",
        confidence: "High", confidencePct: 88,
        chips: ["Which category is most profitable?", "How can I improve profit?", "Which products reduce overall profit?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async segment(q, mode, ctx, D) {
      const seg = (D.insights && D.insights.segments) || {};
      const list = Object.keys(seg).map(k => k + " " + seg[k]).join(", ");
      const strat = {
        "Premium": "charge near-list price, offer exclusive bundles and service, minimal discounts.",
        "Loyal": "small loyalty discounts and upsells; protect their lifetime value.",
        "Regular": "value bundles and seasonal offers to grow spend.",
        "Bargain seeker": "discount-led promotions and clearance to win volume without cannibalising premium buyers.",
      };
      return {
        intent: "segment", mode,
        answer: "Segments in the customer base: " + (list || "not loaded") + ".",
        reasoning: "Customers are clustered by loyalty score, purchase count and average spend (K-Means); Premium/Loyal customers generate the most revenue per head.",
        businessImpact: "Segment-aware pricing raises margin: the biggest discounts go to Bargain seekers, not Premium customers.",
        action: "Route discounts by segment — " + Object.entries(strat).map(([k, v]) => k + ": " + v).join(" "),
        confidence: "High", confidencePct: 87,
        chips: ["Which customers should receive discounts?", "Which customers generate the most revenue?", "Pricing strategies for each segment"],
      };
    },

    /* ---------------------------------------------------------------- */
    async seasonal(q, mode, ctx, D) {
      const ins = D.insights || {};
      const month = this.highestMonth(D);
      const ms = ins.monthly_sales || {};
      const top = Object.keys(ms).sort((a, b) => ms[b] - ms[a]).slice(0, 3).map(k => this.monthNames[+k - 1]).join(", ");
      return {
        intent: "seasonal", mode,
        answer: "Best months: " + top + " (peak " + (month ? this.monthNames[+month - 1] : "?") + "). Weekday avg " +
          this.fmt(ins.weekday_units, 1) + " units/day vs weekend " + this.fmt(ins.weekend_units, 1) + ".",
        reasoning: "Aggregated from the full sales history: monthly units and weekday/weekend averages. The model encodes seasonality via the month and a sinusoidal seasonal factor, so peak months lift predicted demand.",
        businessImpact: "Plan inventory and promotions before the peak month and expect higher weekend traffic.",
        action: "Stock up ahead of the peak month and schedule weekend-only promotions.",
        confidence: "High", confidencePct: 86,
        chips: ["Does demand increase during holidays?", "Compare weekday and weekend demand", "Which month performs best?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async rl(q, mode, ctx, D) {
      const pid = ctx.pid || (D.products && D.products[0].product_id);
      const r = await D.rl({ product_id: pid, inventory: 50, demand_pressure: 0.5 });
      const st = r.product_state || {};
      return {
        intent: "rl", mode,
        answer: "For " + pid + " the RL agent picked action #" + r.action_index + " (price ×" + r.action_multiplier +
          ") → " + this.money(D, r.price) + ", for a state of inventory " + this.fmt(st.inventory, 0) +
          ", demand pressure " + this.fmt(st.demand_pressure, 2) + " and competitor gap " + this.fmt(st.competitor_gap != null ? st.competitor_gap : 0, 2) + ".",
        reasoning: "The Q-values " + (r.q_values || []).map(v => this.fmt(v, 0)).join(" · ") +
          " estimate the long-run expected profit of each action in that state; the agent selects the highest-Q action (exploit) after " +
          this.fmt(r.learning_steps, 0) + " learning steps.",
        businessImpact: "Following the RL price raises expected cumulative profit vs. a static price, adapting as the market state changes.",
        action: "Use the RL price as the automated listing price, and re-run it whenever inventory or demand pressure shifts materially.",
        confidence: "Medium", confidencePct: 70,
        chips: ["Explain the Q-value in simple terms", "How will this action affect future profit?", "Why did the RL agent increase the price?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async ml(q, mode, ctx, D) {
      const mm = D.overview && D.overview.model_metrics && D.overview.model_metrics.models;
      const best = this.bestModel(D);
      let feats = [];
      try {
        const ex = await D.explain();
        feats = (ex && ex.top_features) || [];
      } catch (_) { /* report may be absent */ }
      const featStr = feats.length ? feats.map(f => (typeof f === "string" ? f : f.feature)).join(", ") :
        "is_weekend, units_roll7, seasonal_factor, inventory, weather_factor";
      const metric = (k, m) => (mm && mm[k]) ? (k + " R² " + m.r2 + ", MAE " + m.mae + ", RMSE " + m.rmse) : "";
      return {
        intent: "ml", mode,
        answer: "Best model: " + (best ? best.toUpperCase() : "n/a") +
          (mm && best ? " (" + metric(best, mm[best]) + ")" : "") + ". The demand models were compared on the hold-out set and the highest R² wins.",
        reasoning: "R² = share of demand variance explained (higher is better); MAE/RMSE measure error in units. Most influential features: " + featStr + ".",
        businessImpact: "The winning model drives the price recommendations and forecasts shown across this dashboard.",
        action: "Retrain when new sales data lands (python -m src.training.train) to keep R² high.",
        confidence: "High", confidencePct: 90,
        chips: ["Which features most influence demand?", "Compare the models", "Why was XGBoost selected?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async discount(q, mode, ctx, D) {
      const ins = D.insights || {};
      const over = ins.overstock || [];
      const candidates = (over.length ? over : (ins.inventory || []).slice(0, 4)).map(i => i.product_id).join(", ") ||
        "P008, P005";
      return {
        intent: "discount", mode,
        answer: "Discount first the overstocked SKUs: " + candidates + ". Protect the top-profit products from discounts.",
        reasoning: "Overstock ties up capital and risks stock-out costs; a targeted discount converts it to cash. High-profit, fast-moving SKUs should hold price to preserve margin.",
        businessImpact: "Clears inventory risk and shifts demand without permanently lowering the price floor.",
        action: "Run a 10–15% limited-time offer on the flagged SKUs, then compare sell-through before extending it.",
        confidence: "Medium", confidencePct: 72,
        chips: ["Which products should increase price?", "Which products reduce overall profit?", "Should I offer a 15% discount?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async business(q, mode, ctx, D) {
      const ins = D.insights || {};
      const tr = ins.trend_products || {};
      const grow = Object.entries(tr).sort((a, b) => b[1] - a[1])[0];
      const topP = (ins.top_profit || [])[0];
      return {
        intent: "business", mode,
        answer: "Fastest-growing: " + (grow ? grow[0] + " (+" + grow[1] + " units vs prior week)" : "n/a") +
          ". Best to promote: " + (topP ? topP.product_id : "n/a") + " (highest profit). Category to watch: " +
          (ins.best_revenue_category ? ins.best_revenue_category.name : "n/a") + ".",
        reasoning: "Derived from week-over-week unit deltas, aggregate profit per product and category revenue from the dashboard dataset.",
        businessImpact: "Promote the fastest-growing, highest-margin SKUs to compound the trend; avoid deep discounts on them.",
        action: "Feature " + (topP ? topP.product_id : "the top SKU") + " in the next campaign and verify sell-through weekly.",
        confidence: "High", confidencePct: 85,
        chips: ["Which products should increase price?", "Highest profit opportunities", "Revenue optimization suggestions"],
      };
    },

    /* ---------------------------------------------------------------- */
    async math(q, mode, ctx, D) {
      const r = this.solveMath(q, D);
      if (!r) {
        const k = this.tryKnowledge(q, D);
        if (k) return Object.assign({ intent: "knowledge", mode }, k);
        return {
          intent: "math", mode,
          answer: "I can solve arithmetic and pricing math — try \"What is 20% of 500?\", \"10% off 250\", \"What is the margin if price is 100 and cost is 60?\", or type an expression like \"(120+45)*3\".",
          reasoning: "I evaluate percentages, discounts, margins and plain arithmetic directly in the chat.",
          businessImpact: "Instant scenario math keeps pricing decisions grounded in numbers.",
          action: "Re-ask with a concrete calculation.",
          confidence: "Medium", confidencePct: 60,
          chips: ["What is 20% of 500?", "What is the margin if price is 100 and cost is 60?", "What is 10% off 250?"],
        };
      }
      return {
        intent: "math", mode,
        answer: r.answer,
        reasoning: r.reasoning,
        businessImpact: r.businessImpact,
        action: r.action,
        confidence: "High", confidencePct: 92,
        chips: ["What is 15% of 800?", "Increase 100 by 20%", "What is the margin if price is 120 and cost is 70?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async stats(q, mode, ctx, D) {
      const r = this.tryStats(q, D);
      if (!r) {
        return {
          intent: "stats", mode,
          answer: "I can report dataset statistics — ask \"How many products?\", \"Average price?\", \"Which product is the most expensive?\", \"Total revenue?\" or \"Which product has the highest margin?\".",
          reasoning: "I answer from the uploaded dataset's aggregates (products, prices, costs, revenue and profit rankings).",
          businessImpact: "Quick, accurate catalogue-level facts without leaving the chat.",
          action: "Re-ask with one of the statistics questions.",
          confidence: "Medium", confidencePct: 65,
          chips: ["How many products are there?", "Average price", "Which product is the most expensive?", "Total revenue"],
        };
      }
      return {
        intent: "stats", mode,
        answer: r.answer,
        reasoning: r.reasoning,
        businessImpact: r.businessImpact,
        action: r.action,
        confidence: r.confidence, confidencePct: r.confidencePct,
        chips: ["Which product has the highest margin?", "How many products are there?", "Total revenue"],
      };
    },

    /* ---------------------------------------------------------------- */
    async knowledge(q, mode, ctx, D) {
      const r = this.tryKnowledge(q, D);
      if (!r) {
        return {
          intent: "knowledge", mode,
          answer: "I can explain pricing and ML concepts — try \"What is price elasticity?\", \"How does the RL agent work?\", \"What does R² mean?\" or \"Explain dynamic pricing\".",
          reasoning: "My knowledge base covers elasticity, dynamic pricing, forecasting, model metrics, RL, segmentation, margin, negotiation and inventory concepts.",
          businessImpact: "Understand the numbers behind every recommendation before acting on them.",
          action: "Re-ask with a concept you want explained.",
          confidence: "Medium", confidencePct: 70,
          chips: ["What is price elasticity?", "What does R² mean?", "How does the RL agent work?", "What is dynamic pricing?"],
        };
      }
      return Object.assign({ intent: "knowledge", mode }, r);
    },

    /* ---------------------------------------------------------------- */
    async capabilities(q, mode, ctx, D) {
      const prods = (D.products || []).length;
      return {
        intent: "capabilities", mode,
        answer: "I can: (1) explain pricing recommendations and whether to raise, hold or cut prices; (2) forecast demand for 7/30/90 days; (3) surface profit, revenue, inventory, segment and seasonal insights; (4) run what-if scenarios (inventory, competitor, discount, price); (5) solve arithmetic, percentage and margin math; (6) report dataset statistics (counts, averages, cheapest/most expensive, best selling); and (7) explain pricing & ML concepts like elasticity, R², RL and dynamic pricing.",
        reasoning: "I answer from your live dashboard data (" + prods + " products loaded) plus a built-in knowledge base, and always return Answer, Reasoning, Business Impact, Recommended Action and Confidence.",
        businessImpact: "One assistant for the whole pricing workflow — analysis, calculation, simulation and education.",
        action: "Pick any chip below or type a question of your own.",
        confidence: "High", confidencePct: 90,
        chips: ["Why is this price recommended?", "Forecast next 30 days", "What is 20% of 500?", "What is price elasticity?", "What if inventory drops to 20?"],
      };
    },

    /* ---------------------------------------------------------------- */
    async smalltalk(q, mode, ctx, D) {
      const isBye = /\b(bye|goodbye)\b/.test(q);
      return {
        intent: "smalltalk", mode,
        answer: isBye
          ? "You're welcome — come back with data questions anytime. Upload a dataset and I'll work with it."
          : "You're welcome! Ask me anything about pricing, demand, profit or the models — or try one of the suggestion chips.",
        reasoning: "Just a friendly acknowledgement while the data pipelines run in the background.",
        businessImpact: "Zero — but a good time to ask a real question.",
        action: "Try \"Forecast next 30 days\" or \"Which products need discounts?\".",
        confidence: "High", confidencePct: 95,
        chips: ["Forecast next 30 days", "Which products need discounts?", "What can you do?"],
      };
    },

    /* ---------------------------------------------------------------- */
    default(q, mode, ctx, D) {
      const m = this.solveMath(q, D);
      if (m) return Object.assign({ intent: "default", mode, confidence: "High", confidencePct: 92 }, m);
      const st = this.tryStats(q, D);
      if (st) return Object.assign({ intent: "default", mode }, st);
      const kn = this.tryKnowledge(q, D);
      if (kn) return Object.assign({ intent: "default", mode }, kn);
      return {
        intent: "default", mode,
        answer: "I could not map that to your data, but I can help with: pricing recommendations, forecasts, profit/inventory/segment/seasonal insights, what-if scenarios, arithmetic and statistics, and explanations of pricing & ML concepts.",
        reasoning: "The question did not match a data intent or my knowledge base. I answer best from your dashboard data, so keep questions specific — product IDs like P001 work well.",
        businessImpact: "Precise questions get precise, data-backed answers.",
        action: "Try a suggestion chip, or rephrase with numbers, a product ID, or a concept like \"elasticity\".",
        confidence: "Medium", confidencePct: 45,
        chips: ["Why is this price recommended?", "Forecast next 30 days", "What is 20% of 500?", "What is price elasticity?", "Which product is the most expensive?"],
      };
    },
  },

  hero(pid) { return pid; },
};

/* ---- Node export so the engine can be unit-tested --------------------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AICore };
}

/* ---- Browser UI ------------------------------------------------------- */
if (typeof document !== "undefined") {
  (function () {
    const css = `
    .ai-panel{background:linear-gradient(180deg,var(--card),var(--card-2));border:1px solid var(--line);
      border-radius:var(--rad);box-shadow:var(--shadow);overflow:hidden}
    .ai-pane{padding:18px 20px;border-bottom:1px solid var(--line)}
    .ai-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    .ai-row label{margin:0}
    .ai-select{max-width:170px}
    .ai-hint{font-size:12px;color:var(--faint);margin:0 0 12px}
    .ai-chips{display:flex;flex-wrap:wrap;gap:8px}
    .ai-chip{padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:#0c1220;
      color:var(--mut);font-size:12px;cursor:pointer;margin:0;width:auto;box-shadow:none;
      font-weight:600}
    .ai-chip:hover{filter:none;color:var(--acc);border-color:var(--acc)}
    .ai-chat{max-height:460px;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px;
      background:rgba(8,12,24,.35)}
    .ai-msg{display:flex}
    .ai-msg.user{justify-content:flex-end}
    .ai-bubble{max-width:86%;padding:13px 16px;border-radius:14px;font-size:13.5px;line-height:1.6;
      border:1px solid var(--line)}
    .ai-msg.user .ai-bubble{background:linear-gradient(135deg,var(--acc),var(--acc-2));color:#fff;border:0}
    .ai-msg.bot .ai-bubble{background:var(--card);box-shadow:var(--shadow)}
    .ai-intent{font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:var(--faint);margin-bottom:6px}
    .ai-sec{margin-top:10px}
    .ai-sec .t{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--acc-2);font-weight:700}
    .ai-sec p{margin:3px 0 0;color:var(--mut)}
    .ai-conf{display:inline-flex;align-items:center;gap:6px;margin-top:11px;padding:4px 10px;border-radius:999px;
      font-size:11px;font-weight:700}
    .ai-conf.high{background:rgba(52,211,153,.14);color:var(--ok)}
    .ai-conf.medium{background:rgba(251,191,36,.14);color:var(--warn)}
    .ai-conf.low{background:rgba(248,113,113,.14);color:var(--bad)}
    .ai-conf::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
    .ai-chips-inline{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
    .ai-input{display:flex;gap:10px;padding:14px 20px;border-top:1px solid var(--line);background:var(--card)}
    .ai-input input{flex:1;margin:0}
    .ai-input button{width:auto;margin:0;padding:0 22px;border-radius:10px}
    .ai-typing{color:var(--faint);font-size:12.5px;padding:4px 2px}
    .ai-kpi{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
    .ai-kpi span{flex:1;min-width:120px;background:#0c1220;border:1px solid var(--line);border-radius:10px;
      padding:10px 12px;font-size:12px;color:var(--mut)}
    .ai-kpi b{display:block;font-size:16px;color:var(--txt);margin-top:3px}
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const root = document.getElementById("assistant-root");
    if (!root) return;
    const $ = (id) => document.getElementById(id);

    async function buildD() {
      if (typeof window !== "undefined" && window.PricingData && window.PricingData.assistantBundle) {
        const b = window.PricingData.assistantBundle();
        if (b) return b;
      }
      const [pd, cd, ins, overview] = await Promise.all([
        api("/api/products/detail"), api("/api/customers/detail"),
        api("/api/insights"), api("/api/overview")]);
      const cur = window.PricingData ? window.PricingData.getCurrency() : { code: "USD", symbol: "$" };
      return {
        currency: cur.symbol, currencyCode: cur.code, products: pd, customers: cd, insights: ins, overview,
        price: (r) => api("/api/price", r),
        rl: (r) => api("/api/rl-price", r),
        negotiate: (r) => api("/api/negotiate", r),
        manual: (r) => api("/api/manual", r),
        sales: (pid) => api("/api/sales/" + pid),
        explain: () => api("/api/explain"),
      };
    }

    let D = null, state = { mode: "dataset", pid: null, manual: null };

    function esc(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    root.innerHTML = `
      <div class="ai-panel">
        <div class="ai-pane">
          <div class="ai-row">
            <label>Product</label>
            <select class="ai-select" id="ai-product"></select>
            <span class="ai-hint" id="ai-prod-hint">—</span>
          </div>
          <div class="ai-chips" id="ai-ds-chips"></div>
        </div>
        <div class="ai-chat" id="ai-chat"></div>
        <div class="ai-input">
          <input id="ai-input" placeholder="Ask anything — pricing, math, stats, ML concepts…"/>
          <button id="ai-send">Send</button>
        </div>
      </div>`;

    const chat = $("ai-chat");
    const chips = (list) => list.map(c =>
      `<button class="ai-chip">${esc(c)}</button>`).join("");

    function addMsg(kind, html, withChips) {
      const d = document.createElement("div");
      d.className = "ai-msg " + kind;
      d.innerHTML = `<div class="ai-bubble">${html}</div>`;
      chat.appendChild(d);
      if (withChips && withChips.length) {
        const c = document.createElement("div");
        c.className = "ai-chips-inline";
        c.innerHTML = chips(withChips);
        c.onclick = (e) => {
          const b = e.target.closest(".ai-chip");
          if (b) ask(b.textContent);
        };
        chat.appendChild(c);
      }
      chat.scrollTop = chat.scrollHeight;
    }

    function renderReply(r) {
      const confCls = (r.confidencePct || 0) >= 75 ? "high" : (r.confidencePct || 0) >= 50 ? "medium" : "low";
      let html = `<div class="ai-intent">${esc(r.intent)}</div>`;
      html += `<div>${esc(r.answer)}</div>`;
      if (r.reasoning) html += `<div class="ai-sec"><span class="t">Reasoning</span><p>${esc(r.reasoning)}</p></div>`;
      if (r.businessImpact) html += `<div class="ai-sec"><span class="t">Business Impact</span><p>${esc(r.businessImpact)}</p></div>`;
      if (r.action) html += `<div class="ai-sec"><span class="t">Recommended Action</span><p>${esc(r.action)}</p></div>`;
      html += `<div><span class="ai-conf ${confCls}">${esc(r.confidence || "Medium")} · ${r.confidencePct || 50}%</span></div>`;
      addMsg("bot", html, r.chips);
    }

    async function ask(q) {
      q = String(q || "").trim();
      if (!q) return;
      addMsg("user", esc(q));
      const input = $("ai-input");
      input.disabled = true;
      const typing = document.createElement("div");
      typing.className = "ai-msg bot"; typing.innerHTML = `<div class="ai-bubble ai-typing">Thinking…</div>`;
      chat.appendChild(typing); chat.scrollTop = chat.scrollHeight;
      try {
        const r = await AICore.answer(q, state.mode, state, D);
        typing.remove();
        renderReply(r);
      } catch (e) {
        typing.remove();
        addMsg("bot", `<div class="ai-intent">error</div><div>${esc(e && e.message ? e.message : String(e))}</div>`);
      } finally {
        input.disabled = false;
        input.focus();
      }
    }

    // dataset product fill
    const psel = $("ai-product");
    function fillProducts() {
      psel.innerHTML = "";
      (D.products || []).forEach(p => psel.add(new Option(p.product_id + " · " + p.category, p.product_id)));
      if (D.products && D.products[0]) { state.pid = psel.value = D.products[0].product_id; updateHint(); }
    }
    function updateHint() {
      const p = D.products.find(x => x.product_id === psel.value);
      $("ai-prod-hint").textContent = p ? `base ${D.currency}${p.base_price} · cost ${D.currency}${p.cost}` : "—";
      state.pid = psel.value;
    }
    psel.onchange = () => { updateHint(); };

    // chips
    const dsChips = [
      "Why is this price recommended?", "Should I increase the price?",
      "Forecast next 30 days", "Which products need discounts?",
      "Which products are running out of stock?", "Compare " + (D && D.products && D.products[1] ? D.products[0].product_id + " with " + D.products[1].product_id : "two products"),
      "Which segment should get discounts?", "Explain the RL agent decision",
      "Which model performs best?", "Best product to promote",
      "What is 20% of 500?", "What is price elasticity?",
    ];
    $("ai-ds-chips").innerHTML = chips(dsChips);
    $("ai-ds-chips").onclick = (e) => {
      const b = e.target.closest(".ai-chip");
      if (b) ask(b.textContent);
    };

    $("ai-send").onclick = () => { ask($("ai-input").value); $("ai-input").value = ""; };
    $("ai-input").onkeydown = (e) => { if (e.key === "Enter") { ask($("ai-input").value); $("ai-input").value = ""; } };

    (async function init() {
      try {
        D = await buildD();
        fillProducts();
        const ms = D.insights && D.insights.monthly_sales;
        const peak = ms && AICore.highestMonth(D);
        addMsg("bot",
          `<div class="ai-intent">assistant · ${D.products.length} products loaded</div>
           <div>I am AI, I'm here to help you. Ask me anything — pricing recommendations, forecasts, profit and inventory insights, what-if scenarios, math (percentages, margins, expressions), dataset statistics, or explain pricing & ML concepts.</div>
           <div class="ai-sec"><span class="t">Context</span><p>${D.products.length} products · ${D.customers.length} customers · ` +
          (peak ? `peak month ${AICore.monthNames[+peak - 1]}` : "dashboard data") +
          ` · ${D.overview && D.overview.model_backbone ? D.overview.model_backbone.toUpperCase() + " backbone" : "live data"}</p></div>`,
          ["Why is this price recommended?", "Which products need discounts?", "What is 20% of 500?", "What can you do?"]);
      } catch (e) {
        var noData = typeof window !== "undefined" && window.PricingData && !window.PricingData.active();
        addMsg("bot", noData
          ? "No dataset loaded — use the Upload Dataset button to load a CSV or Excel file, then I can answer questions about pricing, demand and profit."
          : "Could not load assistant data: " + esc(e && e.message ? e.message : String(e)));
      }
    })();

    /* Reloadable bootstrap so the assistant picks up an uploaded dataset. */
    if (typeof window !== "undefined") {
      window.PricingAssistant = {
        reload: function () {
          D = null;
          chat.innerHTML = "";
          return init();
        },
      };
    }
  })();
}
