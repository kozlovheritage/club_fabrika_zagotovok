(() => {
  "use strict";
  const root = document.querySelector("#analyticsRegion");
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const money = cents => {
    if (cents === null || cents === undefined || !/^-?\d+$/.test(String(cents))) return "—";
    const value = Number(cents) / 100;
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB",
      minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  };
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? new Intl.NumberFormat("ru-RU").format(Number(value)) : "—";
  const dateLabel = value => {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? String(value || "—") :
      new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
  };
  const fullDate = value => {
    const [year,month,day] = String(value).split("-").map(Number);
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year,month-1,day)));
  };
  const paymentCount = count => {
    const plural = new Intl.PluralRules("ru-RU").select(Number(count));
    return `${number(count)} ${plural === "one" ? "оплата" : plural === "few" ? "оплаты" : "оплат"}`;
  };
  const text = (parent, tag, value, className = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null || value === "" ? "—" : String(value);
    parent.append(node);
    return node;
  };
  const makeSvg = (label, className) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 600 176");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.classList.add("analytics-chart", className);
    return svg;
  };
  const svgNode = (name, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  function card(title, subtitle, className = "") {
    const section = document.createElement("section");
    section.className = `analytics-card ${className}`.trim();
    text(section, "h3", title);
    text(section, "p", subtitle, "chart-subtitle");
    return section;
  }
  function renderCollection(data) {
    const panel = card("Оплаты по дням", "Без записей возвратов · не чистая выручка", "collection-chart-card");
    const metric = document.createElement("div");
    metric.className = "chart-total";
    text(metric, "strong", money(data.amount_cents), "chart-total-value");
    text(metric, "span", `${number(data.count)} успешных оплат за период`, "chart-total-caption");
    panel.append(metric);
    const returns = data.refunds || {};
    text(panel, "p", `Возвраты отдельно: ${number(returns.full_count)} полных и ${number(returns.partial_count)} частичных.${returns.reported_count ? " Ещё "+number(returns.reported_count)+" уведомлений о возврате требуют сверки." : ""} Сумма частичных возвратов не предполагается.`, "chart-note");
    if (!Array.isArray(data.daily)) {
      text(panel, "p", "Ряд по дням не предоставлен сервером.", "analytics-unavailable");
      return panel;
    }
    const valid = data.daily.filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.day)) && /^-?\d+$/.test(String(item.amount_cents)));
    if (!valid.length) {
      text(panel, "p", "За выбранный период нет доступных ежедневных значений.", "analytics-unavailable");
      return panel;
    }
    const values = valid.map(item => Number(item.amount_cents));
    const max = Math.max(...values, 1);
    const svg = makeSvg(`Ежедневные суммы успешных оплат: ${valid.map(item => `${dateLabel(item.day)} — ${money(item.amount_cents)}, ${number(item.count)} оплат`).join("; ")}`, "daily-bars");
    const baseline = svgNode("line", { x1: 12, y1: 137, x2: 588, y2: 137, class: "chart-baseline" });
    svg.append(baseline);
    const step = 576 / valid.length;
    const barWidth = Math.max(3, Math.min(22, step * 0.62));
    valid.forEach((item, index) => {
      const height = values[index] === 0 ? 2 : Math.max(3, (values[index] / max) * 104);
      const x = 12 + index * step + (step - barWidth) / 2;
      const bar = svgNode("rect", { x, y: 137 - height, width: barWidth, height, rx: 2,
        class: "chart-bar", tabindex: 0, "data-day-index": index,
        "aria-label": `${fullDate(item.day)} — ${money(item.amount_cents)}` });
      const title = svgNode("title", {});
      title.textContent = `${fullDate(item.day)} — ${money(item.amount_cents)}`;
      bar.append(title);
      svg.append(bar);
      if (valid.length <= 12 || index === 0 || index === valid.length - 1 || index % Math.ceil(valid.length / 8) === 0) {
        const label = svgNode("text", { x: x + barWidth / 2, y: 157, class: "chart-axis-label", "text-anchor": "middle" });
        label.textContent = dateLabel(item.day);
        svg.append(label);
      }
    });
    panel.append(svg);
    const hoverValue = document.createElement("p");
    hoverValue.className = "chart-hover-value";
    hoverValue.hidden = true;
    hoverValue.setAttribute("role", "status");
    hoverValue.setAttribute("aria-live", "polite");
    const barFor = target => target instanceof Element ? target.closest(".chart-bar[data-day-index]") : null;
    const showValue = bar => {
      const item = valid[Number(bar.dataset.dayIndex)];
      if (!item) return;
      hoverValue.textContent = `${fullDate(item.day)} · ${money(item.amount_cents)} · ${paymentCount(item.count)}`;
      hoverValue.hidden = false;
    };
    svg.addEventListener("pointerover", event => {
      const bar = barFor(event.target);
      if (bar && event.pointerType !== "touch") showValue(bar);
    });
    svg.addEventListener("pointerout", event => {
      const bar = barFor(event.target);
      if (bar && event.pointerType === "mouse" && document.activeElement !== bar) hoverValue.hidden = true;
    });
    svg.addEventListener("focusin", event => {
      const bar = barFor(event.target);
      if (bar) showValue(bar);
    });
    svg.addEventListener("focusout", event => {
      if (barFor(event.target)) hoverValue.hidden = true;
    });
    svg.addEventListener("click", event => {
      const bar = barFor(event.target);
      if (bar) showValue(bar);
    });
    panel.append(hoverValue);
    const table = document.createElement("ul");
    table.className = "chart-text-list";
    valid.forEach(item => text(table, "li", `${dateLabel(item.day)}: ${money(item.amount_cents)} · ${number(item.count)} оплат`));
    panel.append(table);
    return panel;
  }
  function renderFailures(data) {
    const panel = card("Подтверждённые неуспешные попытки", "Группировка по сервису и причине", "failure-chart-card");
    if (!Array.isArray(data.groups)) {
      text(panel, "p", "Сведения о причинах ошибок недоступны.", "analytics-unavailable");
      return panel;
    }
    const groups = data.groups.filter(row => row && row.count !== null && row.count !== undefined &&
      Number.isFinite(Number(row.count)) && Number(row.count) >= 0);
    if (!groups.length) {
      text(panel, "p", "Подтверждённых неуспешных попыток для показа нет.", "analytics-unavailable");
      return panel;
    }
    const names = groups.map(row => `${row.provider || "Провайдер не указан"} · ${row.label || row.reason_code || "Причина не передана"}`);
    const max = Math.max(...groups.map(row => Number(row.count)), 1);
    const height = Math.max(176, groups.length * 34 + 26);
    const svg = makeSvg(`Подтверждённые неуспешные попытки: ${groups.map((row, i) => `${names[i]} — ${number(row.count)}`).join("; ")}`, "failure-bars");
    svg.setAttribute("viewBox", `0 0 600 ${height}`);
    svg.setAttribute("aria-label", `Неуспешные попытки по причине: ${groups.map((row, i) => `${names[i]} — ${number(row.count)}`).join("; ")}`);
    groups.forEach((row, index) => {
      const y = 17 + index * 34;
      const label = svgNode("text", { x: 2, y: y + 13, class: "chart-category-label" });
      label.textContent = names[index].length > 42 ? `${names[index].slice(0, 39)}…` : names[index];
      svg.append(label);
      svg.append(svgNode("rect", { x: 315, y, width: Math.max(2, (Number(row.count) / max) * 228), height: 18, rx: 3, class: "failure-bar" }));
      const value = svgNode("text", { x: 552, y: y + 14, class: "chart-value-label" });
      value.textContent = number(row.count);
      svg.append(value);
    });
    panel.append(svg);
    text(panel, "p", `${number(data.count)} подтверждённых неуспешных попыток. Оформления, неизвестные статусы оплаты и неизвестная доставка исключены. Доля отказов не рассчитывается: знаменатель неполон.`, "chart-note");
    const list = document.createElement("ul");
    list.className = "chart-text-list";
    groups.forEach((row, index) => {
      const item=text(list,"li",`${names[index]}: ${number(row.count)}`);
      const meter=document.createElement("meter");
      meter.className="failure-meter";
      meter.min=0;meter.max=max;meter.value=Number(row.count);
      meter.setAttribute("aria-label",`${names[index]}: ${number(row.count)}`);
      item.append(meter);
    });
    panel.append(list);
    return panel;
  }
  const renderer = {
    period: "30",
    request: 0,
    loading: false,
    generatedAt: null,
    failedRefresh: false,
    updateFreshness(){
      const node=root.querySelector("[data-analytics-freshness]");
      if(!node)return;
      const age=Date.now()-Date.parse(this.generatedAt||"");
      node.textContent=this.failedRefresh?"Статистика не обновилась · показаны прежние данные":
        Number.isFinite(age)&&age<120000?"Статистика обновлена: "+new Date(this.generatedAt).toLocaleTimeString("ru-RU"):
        "Статистика устарела · обновите данные";
      node.classList.toggle("is-stale",this.failedRefresh||!Number.isFinite(age)||age>=120000);
    },
    async load(period = "30",mode = "user") {
      if(mode==="poll"&&this.loading)return;
      this.period = period;
      const request = ++this.request;
      this.loading = true;
      root.setAttribute("aria-busy", "true");
      if(mode!=="poll"){
      root.replaceChildren();
      const skeleton = document.createElement("div");
      skeleton.className = "analytics-card analytics-loading";
      text(skeleton, "div", "", "skeleton-row");
      text(skeleton, "div", "", "skeleton-row");
      const second = skeleton.cloneNode(true);
      root.append(skeleton, second);
      }
      try {
        const response = await fetch(`/api/admin/analytics?period=${encodeURIComponent(period)}`, {
          credentials: "include", cache: "no-store", headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data && (data.message || data.error) || `Ошибка сервера (${response.status}).`);
        if (request !== this.request) return;
        this.generatedAt=data.generatedAt;
        this.failedRefresh=false;
        const collection = data.collection;
        const failures = data.failures;
        root.replaceChildren(
          collection ? renderCollection(collection) : card("Оплаты по дням", "Данные недоступны", "analytics-unavailable-card"),
          failures ? renderFailures(failures) : card("Подтверждённые неуспешные попытки", "Данные недоступны", "analytics-unavailable-card")
        );
        const limits = data.limits_note ? String(data.limits_note) : "";
        if (limits) text(root, "p", limits, "analytics-limit-note");
        const freshness=text(root,"p","","analytics-limit-note");
        freshness.dataset.analyticsFreshness="";
        this.updateFreshness();
      } catch (error) {
        if (request !== this.request) return;
        if(mode==="poll"){this.failedRefresh=true;this.updateFreshness();return;}
        root.replaceChildren();
        const panel = card("Аналитика временно недоступна", "Данные не заменяются нулевыми значениями.", "analytics-error");
        text(panel, "p", error.message || "Не удалось загрузить аналитику. Проверьте соединение и попробуйте снова.", "analytics-unavailable");
        const retry = text(panel, "button", "Повторить", "button button-secondary");
        retry.type = "button";
        retry.addEventListener("click", () => this.load(this.period));
        root.append(panel);
      } finally {
        if (request === this.request) {root.setAttribute("aria-busy", "false");this.loading=false;}
      }
    }
  };
  window.clubAnalytics = renderer;
})();
