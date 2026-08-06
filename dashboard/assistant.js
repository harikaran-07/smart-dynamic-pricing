/* AI Pricing Assistant — Smart Dynamic Pricing Dashboard
 *
 * Two modes:
 *   dataset : answers about a selected product using stored dataset values
 *   manual  : validates manual inputs, predicts, and recommends a price
 *
 * The core engine (AICore.answer) is pure: it takes a question, mode,
 * context and a data bundle and returns the 5-part response
 * (Answer / Reasoning / Business Impact / Recommended Action / Confidence).
 * It can be unit-tested in Node (module.exports) and runs in the browser.
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
                                        /\bif (inventory|stock|competitor|discount|price|marketing)\b/] },
    { key: "manual_predict", boost: 3, re: [/\brecommend( the)? best price\b/, /\bbest price for maximum profit\b/,
                                            /\bpredict demand for this\b/, /\bforecast this new product\b/] },
    { key: "forecast",  boost: 2, re: [/\bforecast\b/, /\bnext (7|14|30|60|90) days\b/, /\bnext (week|month|quarter)\b/,
                                        /\bpredict demand\b/, /\bincreasing demand\b/, /\bseasonal\b/] },
    { key: "inventory", boost: 2, re: [/\b(stock|inventory)s?\b/, /\boverstock\b/, /\blow stock\b/, /\bsell out\b/,
                                        /\breorder\b/, /\brun(ning)? out\b/] },
    { key: "profit",    boost: 2, re: [/\bprofit\b/, /\brevenue\b/, /\bmargin\b/, /\bmost profitable\b/,
                                        /\bhighest profit\b/, /\bimprove profit\b/, /\bdecreasing\b/] },
    { key: "segment",   boost: 2, re: [/\bsegment\b/, /\bpremium\b/, /\bloyal\b/, /\bbudget\b/, /\bbargain\b/,
                                        /\bhigh value\b/, /\bat risk\b/, /\bcustomer(s)?\b/] },
    { key: "seasonal",  boost: 2, re: [/\bseason\b/, /\bbest month\b/, /\bholiday\b/, /\bweekday\b/, /\bweekend\b/,
                                        /\bsummer\b/, /\bwinter\b/, /\bmonsoon\b/, /\bfestival\b/, /\bwhich month\b/] },
    { key: "rl",        boost: 2, re: [/\brl\b/, /\bq-?value\b/, /\breinforcement\b/, /\bagent\b/, /\breward\b/,
                                        /\baction (selected|taken|recommended)\b/] },
    { key: "ml",        boost: 2, re: [/\bmodel\b/, /\bxgboost\b/, /\brandom forest\b/, /\blightgbm\b/, /\bcatboost\b/,
                                        /\bfeature(s)?\b/, /\br2\b/, /\brmse\b/, /\bmae\b/, /\baccuracy\b/] },
    { key: "discount",  boost: 1, re: [/\bdiscount(s|ed)?\b/, /\boffer .*%?\b/, /\bmarkdown\b/, /\bsale\b/] },
    { key: "price_dir", boost: 1, re: [/\b(increase|decrease|raise|lower|drop|reduce|adjust|change).*price\b/,
                                        /\bshould i\b/] },
    { key: "business",  boost: 1, re: [/\bpromote\b/, /\bfastest growing\b/, /\bgrowing\b/, /\binsight\b/,
                                        /\bstrategy\b/, /\bsuggest\b/, /\bopportunit\b/, /\bbest product\b/] },
    { key: "price_why", boost: 1, re: [/\bwhy (is|was|did)\b/, /\bwhy.*(price|recommend|cost|pric)\b/, /\bpriced at\b/,
                                        /\bpricing\b/, /\bprice of\b/] },
    { key: "hello",     boost: 1, re: [/\bhi\b/, /\bhello\b/, /\bhey\b/, /\bhelp\b/, /\bwhat can you\b/] },
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

  /* ----- the 5-part answer ---------------------------------------------- */
  async answer(q, mode, ctx, D) {
    const intent = this.detectIntent(q);
    const handler = this.handlers[intent] || this.handlers.default;
    try {
      return await handler.call(this, q, mode, ctx || {}, D);
    } catch (e) {
      return {
        intent, mode,
        answer: "I could not compute that with the available data right now.",
        reasoning: "Detail: " + (e && e.message ? e.message : String(e)),
        businessImpact: "No change recommended until the input is corrected.",
        action: "Re-run the request, or switch the mode and provide the missing inputs.",
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
        answer: "I am the Smart Dynamic Pricing assistant. I can explain pricing recommendations, forecast demand, and surface profit, inventory, segment, seasonal, ML and RL insights from your live dashboard data.",
        reasoning: "Currently loaded: " + (ins.product_count || D.products?.length || 0) +
          " products, " + (D.customers ? D.customers.length : 0) + " customers, and full sales-history aggregates. " +
          (mode === "dataset" ? "You are in Dataset Mode — I use stored values for the selected product." :
            "You are in Manual Mode — I predict from the fields you entered."),
        businessImpact: "Faster, data-backed price and stock decisions across the catalogue.",
        action: "Try: \"Why is this product priced this way?\", \"Forecast next 30 days\", \"Which products need discounts?\", or \"What if inventory drops to 20?\".",
        confidence: "High", confidencePct: 90,
        chips: ["Why is this price recommended?", "Forecast next 30 days", "Which products need discounts?", "Inventory risk", "Best product to promote"],
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
      const discM = String(q).match(/\b(?:offer|give|apply)\s*(\d+(?:\.\d+)?)\s*%\s*discount/i);
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
          action: "Re-ask with one changed input, or edit the Manual Mode form and press Predict.",
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
          answer: "I need the Manual Mode fields to predict a new product. Fill the form (price, cost, inventory, competitor, demand pressure, …) and press Predict.",
          reasoning: "For " + (pid || "your product") + " I can already optimise from the dataset — use \"Recommend the best price\" in Dataset Mode.",
          businessImpact: "Manual Mode lets you test launch scenarios before committing stock.",
          action: "Switch to Manual Mode, enter the details and press Predict.",
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
      } catch (_) { /* demo sales handler also works */ }
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
    default(q, mode, ctx, D) {
      return {
        intent: "default", mode,
        answer: "I can help with pricing, demand, profit, segmentation, seasonality, inventory, RL and ML questions.",
        reasoning: "Ask about a selected product (Dataset Mode) or your entered fields (Manual Mode), and I answer from the live dashboard data.",
        businessImpact: "Better decisions in seconds, backed by the trained models.",
        action: "Try a quick question below, e.g. \"Why is this price recommended?\" or \"Forecast next 30 days\".",
        confidence: "Medium", confidencePct: 55,
        chips: ["Why is this price recommended?", "Forecast next 30 days", "Which products need discounts?", "Inventory risk"],
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
    .ai-tabs{display:flex;border-bottom:1px solid var(--line)}
    .ai-tab{flex:1;padding:13px 10px;background:transparent;border:0;color:var(--mut);font-weight:700;
      font-size:13px;cursor:pointer;margin:0;border-radius:0;box-shadow:none;position:relative}
    .ai-tab:hover{filter:none;background:rgba(91,140,255,.06)}
    .ai-tab.active{color:var(--txt)}
    .ai-tab.active::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
      background:linear-gradient(90deg,var(--acc),var(--acc-2))}
    .ai-pane{padding:18px 20px;border-bottom:1px solid var(--line)}
    .ai-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    .ai-row label{margin:0}
    .ai-select{max-width:170px}
    .ai-hint{font-size:12px;color:var(--faint);margin:0 0 12px}
    .ai-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
    .ai-field{margin:0}
    .ai-field input,.ai-field select{padding:8px 10px;margin-top:4px;font-size:12.5px}
    .ai-field.toggle{display:flex;align-items:center;gap:8px;padding-top:20px}
    .ai-field.toggle input{width:auto;margin:0}
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
      const [pd, cd, ins, overview] = await Promise.all([
        api("/api/products/detail"), api("/api/customers/detail"),
        api("/api/insights"), api("/api/overview")]);
      return {
        currency: "$", products: pd, customers: cd, insights: ins, overview,
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
        <div class="ai-tabs">
          <button class="ai-tab active" id="ai-tab-dataset">Dataset Mode</button>
          <button class="ai-tab" id="ai-tab-manual">Manual Mode</button>
        </div>
        <div class="ai-pane" id="ai-pane-dataset">
          <div class="ai-row">
            <label>Product</label>
            <select class="ai-select" id="ai-product"></select>
            <span class="ai-hint" id="ai-prod-hint">—</span>
          </div>
          <div class="ai-chips" id="ai-ds-chips"></div>
        </div>
        <div class="ai-pane" id="ai-pane-manual" style="display:none">
          <p class="ai-hint">Enter product details manually — the AI validates, predicts demand and recommends a price.</p>
          <div class="ai-grid">
            <div class="ai-field"><label>Product name</label><input id="m-name" value="New Product"/></div>
            <div class="ai-field"><label>Category</label><select id="m-category"></select></div>
            <div class="ai-field"><label>Current price</label><input id="m-price" type="number" value="49.99"/></div>
            <div class="ai-field"><label>Cost price</label><input id="m-cost" type="number" value="22.00"/></div>
            <div class="ai-field"><label>Inventory</label><input id="m-inv" type="number" value="50"/></div>
            <div class="ai-field"><label>Competitor price</label><input id="m-comp" type="number" value="55.00"/></div>
            <div class="ai-field"><label>Discount %</label><input id="m-disc" type="number" value="0" min="0" max="50"/></div>
            <div class="ai-field"><label>Demand pressure (0–1)</label><input id="m-pressure" type="number" value="0.5" step="0.1"/></div>
            <div class="ai-field"><label>Marketing spend</label><input id="m-mkt" type="number" value="0"/></div>
            <div class="ai-field"><label>Customer rating</label><input id="m-rating" type="number" value="4.2" step="0.1"/></div>
            <div class="ai-field"><label>Season</label><select id="m-season"><option>Normal</option><option>Summer</option><option>Winter</option><option>Monsoon</option><option>Festival</option></select></div>
            <div class="ai-field"><label>Month</label><select id="m-month"></select></div>
            <div class="ai-field"><label>Day of week</label><select id="m-dow"></select></div>
            <div class="ai-field toggle"><label class="ai-hint">Holiday</label><input id="m-holiday" type="checkbox"/></div>
            <div class="ai-field toggle"><label class="ai-hint">Weekend</label><input id="m-weekend" type="checkbox"/></div>
          </div>
          <button id="ai-predict">Predict &amp; Recommend Price</button>
        </div>
        <div class="ai-chat" id="ai-chat"></div>
        <div class="ai-input">
          <input id="ai-input" placeholder="Ask about pricing, demand, profit, inventory, segments, RL or ML…"/>
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
      let html = `<div class="ai-intent">${esc(r.intent)} · ${esc(r.mode)} mode</div>`;
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

    // manual form fill
    const catSel = $("m-category");
    catSel.innerHTML = "";
    (D.products || []).forEach(p => {
      if (!Array.prototype.find.call(catSel.options, o => o.value === p.category))
        catSel.add(new Option(p.category, p.category));
    });
    if (!catSel.options.length) catSel.add(new Option("General", "General"));
    const msel = $("m-month"), dsel = $("m-dow");
    AICore.monthNames.forEach((m, i) => msel.add(new Option(m, i + 1)));
    msel.value = String(new Date().getMonth() + 1);
    const dw = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    dw.forEach((d, i) => dsel.add(new Option(d, i)));
    dsel.value = "5";

    function readManual() {
      return {
        product_name: $("m-name").value || "New Product",
        category: $("m-category").value || "General",
        price: +$("m-price").value, cost: +$("m-cost").value,
        inventory: +$("m-inv").value, competitor: +$("m-comp").value || null,
        discount_pct: +$("m-disc").value || 0, demand_pressure: +$("m-pressure").value || 0.5,
        marketing_spend: +$("m-mkt").value || 0, customer_rating: +$("m-rating").value || 4,
        season: $("m-season").value, holiday: $("m-holiday").checked,
        weekend: $("m-weekend").checked ? 1 : 0, month: +$("m-month").value, dow: +$("m-dow").value,
      };
    }

    $("ai-predict").onclick = async () => {
      const m = readManual();
      if (!(m.price > 0 && m.cost > 0)) { addMsg("bot", "Validation failed: price and cost must be positive."); return; }
      state.mode = "manual"; state.manual = m;
      await ask("Predict demand for this new product and recommend the best price for maximum profit.");
    };

    // tabs
    $("ai-tab-dataset").onclick = () => {
      state.mode = "dataset";
      $("ai-tab-dataset").classList.add("active"); $("ai-tab-manual").classList.remove("active");
      $("ai-pane-dataset").style.display = ""; $("ai-pane-manual").style.display = "none";
    };
    $("ai-tab-manual").onclick = () => {
      state.mode = "manual";
      $("ai-tab-manual").classList.add("active"); $("ai-tab-dataset").classList.remove("active");
      $("ai-pane-manual").style.display = ""; $("ai-pane-dataset").style.display = "none";
    };

    // chips
    const dsChips = [
      "Why is this price recommended?", "Should I increase the price?",
      "Forecast next 30 days", "Which products need discounts?",
      "Which products are running out of stock?", "Compare " + (D && D.products && D.products[1] ? D.products[0].product_id + " with " + D.products[1].product_id : "two products"),
      "Which segment should get discounts?", "Explain the RL agent decision",
      "Which model performs best?", "Best product to promote",
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
           <div>Welcome! Ask me anything about pricing, demand, profit, inventory, segments, seasonality, RL or the ML models.</div>
           <div class="ai-sec"><span class="t">Context</span><p>${D.products.length} products · ${D.customers.length} customers · ` +
          (peak ? `peak month ${AICore.monthNames[+peak - 1]}` : "dashboard data") +
          ` · ${D.overview && D.overview.model_backbone ? D.overview.model_backbone.toUpperCase() + " backbone" : "demo simulation"}</p></div>`,
          ["Why is this price recommended?", "Which products need discounts?", "Inventory risk", "Best product to promote"]);
      } catch (e) {
        addMsg("bot", "Could not load assistant data: " + esc(e && e.message ? e.message : String(e)));
      }
    })();
  })();
}
