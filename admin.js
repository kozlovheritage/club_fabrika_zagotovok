(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    filter: "attention",
    query: "",
    page: 1,
    pageSize: 20,
    total: 0,
    csrfToken: "",
    enabled: true,
    orders: [],
    currentOrder: null,
    loading: false
  };
  const elements = {
    notice: $("#systemNotice"),
    greeting: $("#userGreeting"),
    attention: $("#summaryAttention"),
    delivered: $("#summaryDelivered"),
    inProgress: $("#summaryInProgress"),
    region: $("#ordersRegion"),
    results: $("#resultsLabel"),
    pagination: $("#pagination"),
    pageLabel: $("#pageLabel"),
    prev: $("#prevPage"),
    next: $("#nextPage"),
    refresh: $("#refreshButton"),
    searchForm: $("#searchForm"),
    searchInput: $("#searchInput"),
    dialog: $("#orderDialog"),
    detailId: $("#detailOrderId"),
    detailContent: $("#detailContent"),
    detailActions: $("#detailActions"),
    closeDialog: $("#closeDialog"),
    check: $("#checkButton"),
    resend: $("#resendButton"),
    confirmDialog: $("#resendDialog"),
    resendForm: $("#resendForm"),
    cancelResend: $("#cancelResend"),
    confirmResend: $("#confirmResend"),
    deliveredWarning: $("#deliveredWarning"),
    live: $("#liveMessage")
  };

  const text = (value, fallback = "—") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value);
  const addText = (parent, tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text(value);
    parent.append(node);
    return node;
  };
  const formatDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const formatAmount = (cents) => {
    const amount = Number(cents);
    if (!Number.isFinite(amount)) return "—";
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(amount / 100);
  };
  const normalize = (value) => String(value || "").toLowerCase();
  const labels = {
    queued:"Принято в очередь NotiSend",sent:"Отправлено, доставка ещё не подтверждена",
    delivered:"Принято сервером получателя",skipped:"Не отправлено",
    soft_bounced:"Получатель отклонил письмо",hard_bounced:"Доставка невозможна",
    unknown:"Доставка неизвестна",send_failed:"Ошибка отправки",
    pending:"Ожидает отправки",sending:"Отправляется",accepted:"Принято почтовым API",
    blocked:"Требуется проверка",paid:"Оплачено",review:"Оплата требует сверки",
    premium:"Расширенный",basic:"Базовый",
    provider_auth:"Проверьте доступ к почтовому API",provider_rate_limit:"Лимит почтового API",
    provider_rejected:"Провайдер отклонил отправку",credentials_review:"Проверьте актуальный доступ",
    temporary_send_failure:"Временный сбой отправки",status_unavailable:"Не удалось получить статус",
    "resend:customer_request":"Повтор по просьбе участника","resend:delivery_failed":"Повтор после сбоя",
    "status:checked":"Статус проверен","status:unavailable":"Статус временно недоступен"
  };
  const label = value => labels[value] || text(value);
  const statusInfo = (order) => {
    const status = normalize(order.delivery_status || order.mail_state || order.status);
    if (order.needs_attention || /fail|bounce|reject|error|не удалось|ошиб/.test(status)) {
      return { label: "Нужна проверка", tone: "error" };
    }
    if (status === "delivered") {
      return { label: "Сервер получателя принял", tone: "success" };
    }
    if (["pending","queued","sending","sent","accepted"].includes(status)) {
      return { label: label(status), tone: "progress" };
    }
    if (/paid|оплачен/.test(normalize(order.status))) return { label: "Оплата есть", tone: "progress" };
    if (/cancel|refund|отмен|возврат/.test(status)) return { label: "Оплата отменена", tone: "neutral" };
    return { label: text(order.status, "Статус уточняется"), tone: "neutral" };
  };
  const isMailAccepted = (order) => ["delivered","hard_bounced","skipped"].includes(normalize(order.delivery_status));
  function dialogError(parent, message) {
    let node = parent.querySelector("[data-action-error]");
    if (!node) {node=document.createElement("p");node.dataset.actionError="";node.className="notice";node.setAttribute("role","alert");parent.append(node);}
    node.textContent=message;node.hidden=false;
  }

  function showNotice(message, tone = "warning") {
    elements.notice.textContent = message;
    elements.notice.dataset.tone = tone;
    elements.notice.hidden = false;
  }
  function hideNotice() { elements.notice.hidden = true; }
  function announce(message) { elements.live.textContent = message; }
  function explainError(error) {
    if (error.status === 401 || error.status === 403) return "Сессия поддержки завершилась или у этой учётной записи нет доступа. Войдите в клуб снова и повторите действие.";
    if (error.status === 503) return "Административная проверка сейчас недоступна. Возможно, нет соединения с платёжным или почтовым провайдером. Попробуйте позже.";
    if (error.status === 502) return "Сервис провайдера временно не отвечает. Заказ и письмо не изменены.";
    return error.message || "Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.";
  }
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: "include",
          signal: AbortSignal.timeout(15000),...options,
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
      });
    } catch (_) {
      const error = new Error("Сервер не отвечает. Проверьте соединение и попробуйте снова.");
      error.status = 0;
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* Non-JSON errors get a useful fallback below. */ }
    if (!response.ok) {
      const error = new Error(payload && (payload.message || payload.error) ? String(payload.message || payload.error) : `Ошибка сервера (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  function setLoading(loading) {
    state.loading = loading;
    elements.region.setAttribute("aria-busy", loading ? "true" : "false");
    if (loading) {
      elements.region.replaceChildren();
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton-list";
      skeleton.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) {
        const row = document.createElement("div");
        row.className = "skeleton-row";
        skeleton.append(row);
      }
      elements.region.append(skeleton);
      elements.results.textContent = "Загружаем заказы…";
    }
    elements.refresh.disabled = loading;
  }
  function makeState(title, description, isError = false) {
    const wrapper = document.createElement("div");
    wrapper.className = isError ? "error-state" : "empty-state";
    const mark = addText(wrapper, "div", isError ? "!" : "Ф", "state-mark");
    mark.setAttribute("aria-hidden", "true");
    addText(wrapper, "h3", title);
    addText(wrapper, "p", description);
    if (isError) {
      const retry = addText(wrapper, "button", "Попробовать снова", "button button-secondary");
      retry.type = "button";
      retry.addEventListener("click", loadOrders);
    }
    return wrapper;
  }
  function renderOrder(order) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "order-row";
    button.setAttribute("aria-label", `Заказ ${text(order.order_id)}. ${text(order.buyer_name || order.buyer_email)}. ${statusInfo(order).label}. Открыть подробности.`);

    const buyer = document.createElement("span");
    buyer.className = "order-primary";
    addText(buyer, "span", order.buyer_name || "Имя не указано", "buyer-name");
    addText(buyer, "span", order.buyer_email || "Email не указан", "buyer-email");
    button.append(buyer);

    addText(button, "span", label(order.tariff), "order-tariff");
    const amountDate = document.createElement("span");
    addText(amountDate, "span", formatAmount(order.amount_cents), "order-amount");
    addText(amountDate, "span", formatDate(order.paid_at || order.created_at), "order-date");
    button.append(amountDate);

    const end = document.createElement("span");
    end.className = "row-end";
    const info = statusInfo(order);
    const pill = addText(end, "span", info.label, `status-pill status-${info.tone}`);
    pill.title = "Принятие письма сервером не подтверждает, что оно попало во входящие.";
    addText(end, "span", "›", "row-arrow");
    button.append(end);
    button.addEventListener("click", () => openOrder(order.order_id));
    return button;
  }
  function renderOrders() {
    elements.region.replaceChildren();
    const orders = Array.isArray(state.orders) ? state.orders : [];
    if (!orders.length) {
      elements.results.textContent = state.query ? "Поиск завершён" : "Заказы не найдены";
      elements.region.append(makeState(
        state.query ? "Совпадений нет" : (state.filter === "attention" ? "Сейчас всё спокойно" : "Пока нет заказов"),
        state.query ? "Проверьте написание имени или email либо очистите строку поиска." :
          (state.filter === "attention" ? "В списке нет заказов, которым сейчас требуется внимание." : "Список заказов пока пуст. Данные появятся после поступления заказов.")
      ));
      elements.pagination.hidden = true;
      return;
    }
    const list = document.createElement("div");
    list.className = "order-list";
    orders.forEach((order) => list.append(renderOrder(order)));
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
  async function loadOrders() {
    if (state.loading) return;
    hideNotice();
    setLoading(true);
    const params = new URLSearchParams({ filter: state.filter, page: String(state.page) });
    if (state.query) params.set("q", state.query);
    try {
      const result = await api(`/api/admin/orders?${params.toString()}`);
      state.orders = Array.isArray(result.orders) ? result.orders : [];
      state.total = Number(result.total) || 0;
      state.page = Number(result.page) || state.page;
      state.pageSize = Number(result.pageSize) || 20;
      state.csrfToken = result.csrfToken || state.csrfToken;
      state.enabled = result.enabled !== false;
      elements.greeting.textContent = result.user && result.user.name ? `Здравствуйте, ${result.user.name}` : "Кабинет поддержки";
      elements.attention.textContent = result.summary && result.summary.attention != null ? String(result.summary.attention) : "—";
      elements.delivered.textContent = result.summary && result.summary.delivered != null ? String(result.summary.delivered) : "—";
      elements.inProgress.textContent = result.summary && result.summary.inProgress != null ? String(result.summary.inProgress) : "—";
      renderOrders();
      if (!state.enabled) {
        showNotice("CloudPayments ещё не подключён. Здесь появятся его заказы после включения. Рабочая оплата Prodamus не менялась.", "warning");
      } else if (result.alertsConfigured === false) {
        showNotice("Email-уведомления владельцу не настроены. Проблемные письма пока видны только в этом разделе.", "warning");
      }
    } catch (error) {
      state.orders = [];
      state.total = 0;
      elements.region.replaceChildren(makeState("Не удалось загрузить заказы", explainError(error), true));
      elements.results.textContent = "Список недоступен";
      elements.pagination.hidden = true;
      showNotice(explainError(error), error.status === 401 || error.status === 403 || error.status === 503 ? "warning" : "error");
    } finally {
      setLoading(false);
    }
  }

  function addDetailItem(parent, label, value) {
    const item = document.createElement("div");
    item.className = "detail-item";
    addText(item, "span", label, "detail-label");
    addText(item, "span", value, "detail-value");
    parent.append(item);
  }
  function renderTimeline(items, kind) {
    const list = document.createElement("ul");
    list.className = kind === "history" ? "history-list" : "audit-list";
    if (!Array.isArray(items) || !items.length) {
      addText(list, "li", kind === "history" ? "Событий отправки пока нет." : "Записей поддержки пока нет.", "history-empty");
      return list;
    }
    items.forEach((entry) => {
      const li = document.createElement("li");
      li.className = kind === "history" ? "history-item" : "audit-item";
      const description = kind === "history"
        ? [entry.status && label(entry.status), entry.provider && `Провайдер: ${entry.provider}`, entry.error_code && label(entry.error_code),entry.recipient_email && `Получатель: ${entry.recipient_email}`].filter(Boolean).join(" · ") || "Событие отправки"
        : label(entry.action);
      addText(li, "span", description);
      if (entry.provider_message_id) addText(li, "span", `ID письма: ${entry.provider_message_id}`);
      const time = entry.checked_at || entry.sent_at || entry.created_at;
      if (time) addText(li, "span", formatDate(time), "history-time");
      list.append(li);
    });
    return list;
  }
  function renderDetail(order, history, audit) {
    elements.detailContent.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    addDetailItem(grid, "Участник", order.buyer_name);
    addDetailItem(grid, "Email в платеже", order.buyer_email);
    if(order.recipient_email && order.recipient_email!==order.buyer_email)
      addDetailItem(grid, "Email для письма", order.recipient_email);
    addDetailItem(grid, "Тариф", label(order.tariff));
    addDetailItem(grid, "Оплата", formatAmount(order.amount_cents));
    addDetailItem(grid, "Статус оплаты", label(order.status));
    addDetailItem(grid, "Состояние письма", label(order.delivery_status || order.mail_state));
    addDetailItem(grid, "Провайдер", order.provider);
    addDetailItem(grid, "Попытки отправки", order.attempts);
    addDetailItem(grid, "Создан", formatDate(order.created_at));
    addDetailItem(grid, "Оплачен", formatDate(order.paid_at));
    addDetailItem(grid, "Последняя отправка", formatDate(order.last_sent_at));
    addDetailItem(grid, "Последняя проверка", formatDate(order.status_checked_at));
    if (order.provider_message_id) addDetailItem(grid, "ID письма у провайдера", order.provider_message_id);
    if (order.last_error_code) addDetailItem(grid, "Причина последней ошибки", label(order.last_error_code));
    elements.detailContent.append(grid);
    const explanation = addText(elements.detailContent, "p", "Очередь NotiSend и статус «Отправлено» ещё не подтверждают доставку. Только «Принято сервером получателя» означает приём почтовым сервером — не попадание во входящие. При отказе провайдера или получателя сначала проверьте причину; повтор не снимает блокировку и не отменяет отписку.", "detail-explanation");
    explanation.setAttribute("role", "note");
    const historySection = document.createElement("section");
    historySection.className = "history-section";
    addText(historySection, "h3", "История доставки");
    historySection.append(renderTimeline(history, "history"));
    elements.detailContent.append(historySection);
    const auditSection = document.createElement("section");
    auditSection.className = "history-section";
    addText(auditSection, "h3", "Действия поддержки");
    auditSection.append(renderTimeline(audit, "audit"));
    elements.detailContent.append(auditSection);
  }
  async function openOrder(id) {
    state.currentOrder = state.orders.find((order) => String(order.order_id) === String(id)) || null;
    elements.detailId.textContent = text(id);
    elements.detailActions.hidden = true;
    elements.detailContent.replaceChildren();
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton-row";
    elements.detailContent.append(skeleton);
    if (!elements.dialog.open) elements.dialog.showModal();
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(id)}`);
      state.csrfToken = result.csrfToken || state.csrfToken;
      state.currentOrder = result.order || state.currentOrder;
      if (!state.currentOrder) throw new Error("В ответе сервера нет данных заказа.");
      renderDetail(state.currentOrder, result.history, result.audit);
      elements.check.disabled = !state.enabled || state.currentOrder.provider !== "notisend" ||
        !state.currentOrder.provider_message_id || !["queued","sent","unknown"].includes(state.currentOrder.delivery_status);
      elements.resend.disabled = !state.enabled || state.currentOrder.status !== "paid" ||
        !["accepted","blocked"].includes(state.currentOrder.mail_state);
      elements.detailActions.hidden = false;
    } catch (error) {
      elements.detailContent.replaceChildren(makeState("Подробности недоступны", explainError(error), true));
      showNotice(explainError(error), error.status === 401 || error.status === 403 ? "warning" : "error");
    }
  }
  async function checkStatus() {
    if (!state.currentOrder || elements.check.disabled) return;
    const id = state.currentOrder.order_id;
    elements.check.disabled = true;
    elements.check.textContent = "Проверяем…";
    try {
      await api(`/api/admin/orders/${encodeURIComponent(id)}/check`, {
        method: "POST",
        headers: { "X-CSRF-Token": state.csrfToken },
        body: "{}"
      });
      announce("Статус письма проверен. Обновляем данные.");
      await loadOrders();
      await openOrder(id);
    } catch (error) {
      dialogError(elements.detailContent, explainError(error));
    } finally {
      elements.check.textContent = "Проверить статус письма";
      elements.check.disabled = !state.enabled || !["queued","sent","unknown"].includes(state.currentOrder?.delivery_status);
    }
  }
  function beginResend() {
    if (!state.currentOrder) return;
    const accepted = isMailAccepted(state.currentOrder);
    const oldError=elements.resendForm.querySelector("[data-action-error]");
    if(oldError)oldError.hidden=true;
    elements.deliveredWarning.hidden = !accepted;
    const failedOption = $('input[name="reason"][value="delivery_failed"]', elements.resendForm);
    const requestOption = $('input[name="reason"][value="customer_request"]', elements.resendForm);
    requestOption.checked = accepted;
    failedOption.checked = !accepted;
    elements.confirmResend.disabled = false;
    if (!elements.confirmDialog.open) elements.confirmDialog.showModal();
  }
  async function resendOrder(event) {
    event.preventDefault();
    if (!state.currentOrder) return;
    const reason = new FormData(elements.resendForm).get("reason");
    if (isMailAccepted(state.currentOrder) && reason !== "customer_request") {
      dialogError(elements.resendForm,"Повтор требует подтверждения запроса самого участника.");
      return;
    }
    const order = state.currentOrder;
    elements.confirmResend.disabled = true;
    elements.confirmResend.textContent = "Отправляем…";
    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.order_id)}/resend`, {
        method: "POST",
        headers: { "X-CSRF-Token": state.csrfToken },
        body: JSON.stringify({
          reason,
          expectedMessageId: order.provider_message_id || null,
          expectedAttempts: order.attempts || 0
        })
      });
      elements.confirmDialog.close();
      elements.dialog.close();
      announce("Запрос на повторную отправку принят. Обновляем список.");
      showNotice("Запрос на повторную отправку принят. Обновляем данные заказа.", "warning");
      await loadOrders();
    } catch (error) {
      dialogError(elements.resendForm,explainError(error));
    } finally {
      elements.confirmResend.disabled = false;
      elements.confirmResend.textContent = "Подтвердить отправку";
    }
  }

  document.querySelectorAll(".filter-tab").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.filter === button.dataset.filter) return;
      state.filter = button.dataset.filter;
      state.page = 1;
      document.querySelectorAll(".filter-tab").forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
      });
      loadOrders();
    });
  });
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.query = elements.searchInput.value.trim();
    state.page = 1;
    loadOrders();
  });
  elements.refresh.addEventListener("click", loadOrders);
  elements.prev.addEventListener("click", () => {
    if (state.page > 1) { state.page -= 1; loadOrders(); }
  });
  elements.next.addEventListener("click", () => {
    if (state.page < Math.ceil(state.total / state.pageSize)) { state.page += 1; loadOrders(); }
  });
  elements.closeDialog.addEventListener("click", () => elements.dialog.close());
  elements.check.addEventListener("click", checkStatus);
  elements.resend.addEventListener("click", beginResend);
  elements.cancelResend.addEventListener("click", () => elements.confirmDialog.close());
  elements.resendForm.addEventListener("submit", resendOrder);
  elements.resendForm.querySelectorAll('input[name="reason"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      elements.confirmResend.disabled = Boolean(state.currentOrder && isMailAccepted(state.currentOrder) && radio.value !== "customer_request" && radio.checked);
    });
  });
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });
  elements.confirmDialog.addEventListener("click", (event) => {
    if (event.target === elements.confirmDialog) elements.confirmDialog.close();
  });
  loadOrders();
})();
