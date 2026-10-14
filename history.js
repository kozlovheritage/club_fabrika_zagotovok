(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    kind: "payments",
    status: "all",
    query: "",
    page: 1,
    pageSize: 25,
    total: 0,
    items: [],
    loading: false,
    listRequest: 0,
    detailRequest: 0
  };
  const elements = {
    notice: $("#systemNotice"),
    greeting: $("#userGreeting"),
    payments: $("#summaryPayments"),
    paid: $("#summaryPaid"),
    refunded: $("#summaryRefunded"),
    leads: $("#summaryLeads"),
    syncSuccess: $("#syncSuccess"),
    syncImport: $("#syncImport"),
    syncState: $("#syncState"),
    syncError: $("#syncError"),
    syncLimits: $("#syncLimits"),
    region: $("#historyRegion"),
    results: $("#resultsLabel"),
    hint: $("#resultsHint"),
    pagination: $("#pagination"),
    pageLabel: $("#pageLabel"),
    prev: $("#prevPage"),
    next: $("#nextPage"),
    refresh: $("#refreshButton"),
    searchForm: $("#searchForm"),
    searchInput: $("#searchInput"),
    status: $("#statusFilter"),
    statusWrap: $("#statusFilterWrap"),
    dialog: $("#historyDialog"),
    detailKind: $("#detailKind"),
    detailId: $("#detailOrderId"),
    detailContent: $("#detailContent"),
    closeDialog: $("#closeDialog"),
    detailDone: $("#detailDone"),
    live: $("#liveMessage")
  };

  const emptyText = (value, fallback = "—") =>
    value === null || value === undefined || String(value).trim() === "" ? fallback : String(value);
  const appendText = (parent, tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = emptyText(value);
    parent.append(node);
    return node;
  };
  const formatDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const formatAmount = (cents, currency) => {
    const amount = Number(cents);
    if (!Number.isFinite(amount)) return "—";
    const code = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase())
      ? String(currency).toUpperCase() : "RUB";
    try {
      return new Intl.NumberFormat("ru-RU", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount / 100);
    } catch (_) {
      return `${(amount / 100).toLocaleString("ru-RU")} ${code}`;
    }
  };
  const labels = {
    premium: "Расширенный", basic: "Базовый", unknown: "Тариф не указан",
    paid: "Оплачено", settled: "Расчёт завершён", received: "Получено",
    refunded: "Возврат", partially_refunded: "Частичный возврат",
    failed: "Неуспешно", pending: "Ожидает", review: "Требует сверки",
    lead: "Оформление", csv: "CSV", platform: "Платформа",
    delivered: "Принято сервером получателя", pending_mail: "Ожидает доставки",
    not_verified: "Не проверено"
  };
  const label = (value) => Object.prototype.hasOwnProperty.call(labels, String(value))
    ? labels[String(value)] : emptyText(value);
  const explainError = (error) => {
    if (error.status === 401 || error.status === 403) {
      return "Сессия администратора завершилась или у этой учётной записи нет доступа. Войдите в кабинет снова и повторите запрос.";
    }
    if (error.status === 0) return "Сервер не отвечает. Проверьте соединение и попробуйте снова.";
    return error.message || "Не удалось загрузить историю. Попробуйте снова.";
  };

  async function api(path) {
    let response;
    try {
      response = await fetch(path, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000)
      });
    } catch (_) {
      const error = new Error("Сервер не отвечает. Проверьте соединение и попробуйте снова.");
      error.status = 0;
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* Use a safe message for non-JSON errors. */ }
    if (!response.ok) {
      const error = new Error(payload && (payload.message || payload.error)
        ? String(payload.message || payload.error) : `Ошибка сервера (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }
  function showNotice(message, tone = "warning") {
    elements.notice.textContent = message;
    elements.notice.dataset.tone = tone;
    elements.notice.hidden = false;
  }
  function hideNotice() { elements.notice.hidden = true; }
  function announce(message) { elements.live.textContent = message; }
  function setBusy(loading) {
    state.loading = loading;
    elements.region.setAttribute("aria-busy", loading ? "true" : "false");
    elements.refresh.disabled = loading;
    if (loading) {
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton-list";
      skeleton.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i += 1) {
        const row = document.createElement("div");
        row.className = "skeleton-row";
        skeleton.append(row);
      }
      elements.region.replaceChildren(skeleton);
      elements.results.textContent = "Загружаем историю…";
    }
  }
  function makeState(title, description, isError = false) {
    const wrapper = document.createElement("div");
    wrapper.className = isError ? "error-state" : "empty-state";
    appendText(wrapper, "div", isError ? "!" : "Ф", "state-mark").setAttribute("aria-hidden", "true");
    appendText(wrapper, "h3", title);
    appendText(wrapper, "p", description);
    if (isError) {
      const retry = appendText(wrapper, "button", "Попробовать снова", "button button-secondary");
      retry.type = "button";
      retry.addEventListener("click", () => loadHistory("retry"));
    }
    return wrapper;
  }
  function syncStatus(sync = {}) {
    elements.syncSuccess.textContent = formatDate(sync.last_success_at);
    elements.syncImport.textContent = formatDate(sync.last_import_at);
    const hasError = Boolean(sync.last_error);
    const lastSync = Date.parse(sync.last_success_at || "");
    const stale = !Number.isFinite(lastSync) || Date.now() - lastSync > 180000;
    elements.syncState.textContent = hasError ? "Есть ошибка синхронизации" :
      (stale ? "Нет свежей сверки" : "Сверка платформы работает");
    elements.syncState.classList.toggle("is-warning", hasError || stale);
    elements.syncError.hidden = !hasError;
    elements.syncError.textContent = hasError ? `Последняя ошибка: ${String(sync.last_error)}` : "";
    elements.syncLimits.textContent = emptyText(sync.limits_note,
      "История включает только полученные события. Пропущенные уведомления и полный удалённый журнал автоматически не запрашиваются.");
  }
  function statusTone(status, kind) {
    if (kind === "lead") return "neutral";
    if (["paid", "settled", "received"].includes(String(status))) return "success";
    if (["refunded", "partially_refunded"].includes(String(status))) return "progress";
    if (status === "failed") return "error";
    return "neutral";
  }
  function cell(parent, title, value, className = "") {
    const wrapper = document.createElement("span");
    if (className) wrapper.className = className;
    appendText(wrapper, "span", title, "history-cell-label");
    appendText(wrapper, "span", value, "history-cell-value");
    parent.append(wrapper);
    return wrapper;
  }
  function renderItem(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-row";
    const kind = item.kind === "lead" ? "lead" : "payment";
    button.setAttribute("aria-label",
      `${kind === "lead" ? "Оформление" : "Платёж"}, ${emptyText(item.buyer_email, "email не указан")}, ${label(item.status)}. Открыть подробности.`);

    const main = document.createElement("span");
    main.className = "history-main";
    appendText(main, "span", item.buyer_email || "Email не указан", "history-email");
    appendText(main, "span", `Заказ: ${emptyText(item.order_id)}`, "history-secondary");
    button.append(main);

    const tariff = document.createElement("span");
    tariff.className = "history-kind";
    appendText(tariff, "span", kind === "lead" ? "Оформление" : label(item.tariff), "history-kind");
    if (item.source_status) appendText(tariff, "span", `Источник: ${label(item.source_status)}`, "history-secondary");
    button.append(tariff);

    const amount = document.createElement("span");
    amount.className = "history-row-amount";
    appendText(amount, "span", item.amount_cents == null ? "Сумма не указана" : formatAmount(item.amount_cents, item.currency), "history-amount");
    appendText(amount, "span", emptyText(item.currency, "Валюта не указана"), "history-secondary");
    button.append(amount);

    const state = document.createElement("span");
    state.className = "history-row-status";
    const pill = appendText(state, "span", kind === "lead" ? "Активность оформления" : label(item.status),
      `status-pill status-${statusTone(item.status, kind)}`);
    pill.title = item.source_status ? `Статус записи: ${String(item.source_status)}` : "Статус записи";
    button.append(state);

    const date = document.createElement("span");
    date.className = "history-row-date";
    appendText(date, "span", formatDate(item.occurred_at), "history-date");
    button.append(date);
    button.addEventListener("click", () => openDetail(item));
    return button;
  }
  function renderList() {
    elements.region.replaceChildren();
    if (!state.items.length) {
      const hasQuery = Boolean(state.query);
      elements.results.textContent = hasQuery ? "Поиск завершён" : "Записей нет";
      elements.region.append(makeState(
        hasQuery ? "Совпадений не найдено" : (state.kind === "leads" ? "Оформлений пока нет" : "Платежей пока нет"),
        hasQuery ? "Проверьте email или номер заказа и попробуйте снова." :
          "Когда в истории появятся новые события, они будут показаны здесь. Отсутствие записи не подтверждает отсутствие события у провайдера."
      ));
      elements.pagination.hidden = true;
      return;
    }
    const list = document.createElement("div");
    list.className = "history-list";
    state.items.forEach((item) => list.append(renderItem(item)));
    elements.region.append(list);
    const first = (state.page - 1) * state.pageSize + 1;
    const last = Math.min(state.page * state.pageSize, state.total);
    elements.results.textContent = `Показаны ${first}–${last} из ${state.total}`;
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    elements.pagination.hidden = pages <= 1;
    elements.pageLabel.textContent = `Страница ${state.page} из ${pages}`;
    elements.prev.disabled = state.page <= 1;
    elements.next.disabled = state.page >= pages;
  }
  async function loadHistory(reason = "user") {
    if (reason === "poll" && (document.hidden || state.loading)) return;
    const requestId = ++state.listRequest;
    const request = { kind: state.kind, status: state.status, query: state.query, page: state.page };
    if (reason !== "poll") hideNotice();
    setBusy(true);
    const params = new URLSearchParams({
      kind: request.kind,
      q: request.query,
      status: request.status,
      page: String(request.page)
    });
    try {
      const result = await api(`/api/admin/history?${params.toString()}`);
      if (requestId !== state.listRequest) return;
      state.items = Array.isArray(result.items) ? result.items : [];
      state.total = Number(result.total) || 0;
      state.page = Number(result.page) || request.page;
      state.pageSize = Number(result.pageSize) || 25;
      elements.greeting.textContent = result.user && result.user.name
        ? `Здравствуйте, ${String(result.user.name)}` : "История клуба";
      const summary = result.summary || {};
      elements.payments.textContent = emptyText(summary.payments, "0");
      elements.paid.textContent = emptyText(summary.paid, "0");
      elements.refunded.textContent = emptyText(summary.refunded, "0");
      elements.leads.textContent = emptyText(summary.leads, "0");
      syncStatus(result.sync || {});
      renderList();
      if (reason === "poll") announce("История обновлена.");
    } catch (error) {
      if (requestId !== state.listRequest) return;
      state.items = [];
      state.total = 0;
      elements.region.replaceChildren(makeState("История недоступна", explainError(error), true));
      elements.results.textContent = "Список недоступен";
      elements.pagination.hidden = true;
      showNotice(explainError(error), error.status === 401 || error.status === 403 ? "warning" : "error");
      if (error.status === 401 || error.status === 403) {
        elements.syncState.textContent = "Требуется доступ администратора";
        elements.syncState.classList.add("is-warning");
      }
    } finally {
      if (requestId === state.listRequest) {
        elements.region.setAttribute("aria-busy", "false");
        elements.refresh.disabled = false;
        state.loading = false;
      }
    }
  }
  function addDetailItem(parent, title, value, className = "") {
    const item = document.createElement("div");
    item.className = `detail-item${className ? ` ${className}` : ""}`;
    appendText(item, "span", title, "detail-label");
    appendText(item, "span", value, "detail-value");
    parent.append(item);
  }
  function renderEvents(events) {
    const list = document.createElement("ul");
    list.className = "history-event-list";
    if (!Array.isArray(events) || !events.length) {
      appendText(list, "li", "Связанные события оформления не найдены.", "history-empty");
      return list;
    }
    events.forEach((event) => {
      const row = document.createElement("li");
      row.className = "history-event";
      const details = [
        event.kind && `Событие: ${String(event.kind)}`,
        event.source_status && `Статус источника: ${String(event.source_status)}`,
        event.source && `Источник: ${label(event.source)}`,
        event.provider_id && `ID провайдера: ${String(event.provider_id)}`,
        Number(event.occurrences) > 1 &&
          `Точных повторов активности: ${Number(event.occurrences)} (не новые продажи)`
      ].filter(Boolean);
      appendText(row, "span", details.join(" · ") || "Событие оформления", "");
      if (event.occurred_at) appendText(row, "span", formatDate(event.occurred_at), "history-event-time");
      list.append(row);
    });
    return list;
  }
  function renderDetail(item, result) {
    const detail = result.item || item;
    elements.detailContent.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    addDetailItem(grid, "Тип записи", detail.kind === "lead" ? "Оформление" : "Платёж");
    addDetailItem(grid, "Email покупателя", detail.buyer_email);
    addDetailItem(grid, "Номер заказа", detail.order_id);
    addDetailItem(grid, "Тариф", label(detail.tariff));
    addDetailItem(grid, "Сумма", detail.amount_cents == null ? "Не указана" : formatAmount(detail.amount_cents, detail.currency));
    addDetailItem(grid, "Статус", label(detail.status));
    addDetailItem(grid, "Статус источника", detail.source_status);
    addDetailItem(grid, "Источник записи", label(detail.source));
    addDetailItem(grid, "Провайдер", label(detail.provider));
    addDetailItem(grid, "ID у провайдера", detail.provider_id);
    addDetailItem(grid, "Дата события", formatDate(detail.occurred_at));
    const providedMailStatus = result.mail_status || detail.mail_status;
    const mailState = providedMailStatus && providedMailStatus !== "not_verified"
      ? label(providedMailStatus) : "Не проверено";
    addDetailItem(grid, "Состояние письма", mailState);
    addDetailItem(grid, "Связанный заказ платформы", result.live_order_id || "Не связан");
    elements.detailContent.append(grid);

    if (detail.identity_conflict === true || item.identity_conflict === true) {
      const warning = appendText(elements.detailContent, "p",
        "Требуется проверка: ID провайдера совпал, но email, номер заказа или сумма различались. Доступ не объединяется автоматически.",
        "history-identity-warning");
      warning.setAttribute("role", "alert");
    }

    const note = appendText(elements.detailContent, "p",
      "Это историческая запись для сверки. Просмотр не отправляет письма, не меняет пароль, оплату или доступ. Статус платежа сам по себе не подтверждает доставку письма.",
      "history-detail-note");
    note.setAttribute("role", "note");
    const eventsSection = document.createElement("section");
    eventsSection.className = "history-events";
    appendText(eventsSection, "h3", "Связанные события оформления");
    eventsSection.append(renderEvents(result.events));
    elements.detailContent.append(eventsSection);
  }
  async function openDetail(item) {
    const requestId = ++state.detailRequest;
    const kind = item.kind === "lead" ? "leads" : "payments";
    elements.detailKind.textContent = kind === "leads" ? "ОФОРМЛЕНИЕ" : "ПЛАТЁЖ";
    elements.detailId.textContent = emptyText(item.order_id, "без номера заказа");
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton-row";
    elements.detailContent.replaceChildren(skeleton);
    if (!elements.dialog.open) elements.dialog.showModal();
    try {
      const result = await api(`/api/admin/history/${encodeURIComponent(String(item.id))}?kind=${encodeURIComponent(kind)}`);
      if (requestId !== state.detailRequest || !elements.dialog.open) return;
      if (!result.item) throw new Error("В ответе сервера нет данных записи.");
      renderDetail(item, result);
    } catch (error) {
      if (requestId !== state.detailRequest || !elements.dialog.open) return;
      elements.detailContent.replaceChildren(makeState("Подробности недоступны", explainError(error), true));
      showNotice(explainError(error), error.status === 401 || error.status === 403 ? "warning" : "error");
    }
  }

  document.querySelectorAll("[data-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.kind;
      if (kind === state.kind) return;
      state.kind = kind;
      state.page = 1;
      if (kind === "leads") {
        state.status = "all";
        elements.status.value = "all";
      }
      elements.statusWrap.hidden = kind !== "payments";
      document.querySelectorAll("[data-kind]").forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
      });
      loadHistory();
    });
  });
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.query = elements.searchInput.value.trim();
    state.page = 1;
    loadHistory();
  });
  elements.status.addEventListener("change", () => {
    state.status = elements.status.value;
    state.page = 1;
    loadHistory();
  });
  elements.refresh.addEventListener("click", () => loadHistory("refresh"));
  elements.prev.addEventListener("click", () => {
    if (state.page > 1) { state.page -= 1; loadHistory(); }
  });
  elements.next.addEventListener("click", () => {
    if (state.page < Math.ceil(state.total / state.pageSize)) { state.page += 1; loadHistory(); }
  });
  const closeDetail = () => {
    state.detailRequest += 1;
    if (elements.dialog.open) elements.dialog.close();
  };
  elements.closeDialog.addEventListener("click", closeDetail);
  elements.detailDone.addEventListener("click", closeDetail);
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) closeDetail();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadHistory("poll");
  });
  window.setInterval(() => loadHistory("poll"), 30000);
  elements.statusWrap.hidden = false;
  loadHistory("initial");
})();
