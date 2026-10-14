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
    loading: false,
    listRequest: 0,
    detailRequest: 0,
    generatedAt: null,
    refreshFailed: false
  };
  const elements = {
    notice: $("#systemNotice"),
    paymentProvider: $("#paymentProviderNotice"),
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
    confirmAccess: $("#confirmAccessButton"),
    accessDialog: $("#confirmAccessDialog"),
    accessForm: $("#confirmAccessForm"),
    accessCheckbox: $("#accessConfirmedCheck"),
    accessSubmit: $("#submitConfirmAccess"),
    accessCancel: $("#cancelConfirmAccess"),
    confirmDialog: $("#resendDialog"),
    resendForm: $("#resendForm"),
    cancelResend: $("#cancelResend"),
    confirmResend: $("#confirmResend"),
    deliveredWarning: $("#deliveredWarning"),
    credentialPanel: $("#credentialPanel"),
    credentialLogin: $("#credentialLogin"),
    credentialValue: $("#credentialValue"),
    credentialFeedback: $("#credentialFeedback"),
    viewPassword: $("#viewPasswordButton"),
    resetPassword: $("#resetPasswordButton"),
    resetDialog: $("#resetPasswordDialog"),
    resetForm: $("#resetPasswordForm"),
    resetRequested: $("#resetRequested"),
    confirmPasswordReset: $("#confirmPasswordReset"),
    cancelPasswordReset: $("#cancelPasswordReset"),
    live: $("#liveMessage"),
    unverified: $("#summaryUnverified"),
    freshness: $("#freshnessLabel")
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
    pending:"Ожидает",sending:"Отправляется",accepted:"Принято почтовым API",
    failed:"Отказ оплаты",canceled:"Отмена оплаты",authorized:"Средства заблокированы, не списаны",
    refunded:"Возврат полной суммы",partially_refunded:"Частичный возврат",
    refund_reported:"Зарегистрирован возврат — нужна сверка",
    refund_failed:"Возврат не выполнен — нужна проверка",payment_refund_review:"Возврат или отмена — проверьте доступ",
    completed:"Оплата подтверждена",duplicate:"Повторная операция — нужна сверка",
    blocked:"Требуется проверка",paid:"Оплачено",review:"Оплата требует сверки",
    premium:"Расширенный",basic:"Базовый",
    provider_auth:"Проверьте доступ к почтовому API",provider_rate_limit:"Лимит почтового API",
    provider_rejected:"Провайдер отклонил отправку",credentials_review:"Проверьте актуальный доступ",
    temporary_send_failure:"Временный сбой отправки",status_unavailable:"Не удалось получить статус",
    send_uncertain:"Сервис мог принять письмо. Проверьте отправку перед повтором",
    "resend:customer_request":"Повтор по просьбе участника","resend:delivery_failed":"Повтор после сбоя",
    "status:checked":"Статус проверен","status:unavailable":"Статус временно недоступен",
    "password:view":"Просмотр текущего пароля администратором",
    "access:confirmed":"Оплата и получение доступа подтверждены администратором",
    "password:reset":"Новый пароль создан и поставлен в очередь отправки"
  };
  const label = value => labels[value] || text(value);
  const providerName = value => ({prodamus:"Prodamus",cloudpayments:"CloudPayments"})[value] || "Не указан";
  const statusInfo = (order) => {
    if(order.access_confirmed_at&&!order.needs_attention)
      return {label:"Письмо принято · вручную",tone:"success"};
    if (order.queue_category === "unverified")
      return { label: "Не подтверждено", tone: "progress" };
    if (order.queue_category === "accepted")
      return { label: "Письмо принято сервером", tone: "success" };
    if (order.queue_category === "payment_review")
      return { label: "Сверка оплаты", tone: "error" };
    if (order.queue_category === "access_review")
      return { label: "Проверка доступа", tone: "error" };
    if (order.queue_category === "mail_error")
      return { label: "Ошибка доставки", tone: "error" };
    if (order.queue_category === "progress")
      return { label: "В процессе", tone: "progress" };
    if(order.status==="pending"&&!order.mail_state&&(!order.last_payment_status||order.last_payment_status==="pending"))
      return {label:"Ожидает оплаты",tone:"progress"};
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
    addText(buyer, "span", `Email плательщика: ${order.buyer_email || "не указан"}`, "buyer-email");
    if (order.tariff === "premium")
      addText(buyer, "span", `Email для входа: ${order.account_email || "пока не привязан к заказу"}`, "buyer-email");
    else if (order.recipient_email && order.recipient_email !== order.buyer_email)
      addText(buyer, "span", `Email письма: ${order.recipient_email}`, "buyer-email");
    addText(buyer, "span", `${providerName(order.payment_provider)} · ${label(order.last_payment_status || order.status)}`, "order-date");
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
    if (order.queue_reason || order.next_action) {
      const queue = document.createElement("span");
      queue.className = "queue-note";
      if (order.queue_reason) addText(queue, "span", order.queue_reason, "queue-reason");
      if (order.next_action) addText(queue, "span", `Дальше: ${order.next_action}`, "queue-next");
      button.append(queue);
    }
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
  async function loadOrders(mode = "user") {
    const polling = mode === "poll";
    const dialogsOpen = Array.from(document.querySelectorAll("dialog")).some(dialog => dialog.open);
    if (polling && (dialogsOpen || document.hidden || state.loading || elements.searchInput.value.trim() !== state.query)) return;
    if (state.loading && polling) return;
    const requestId = ++state.listRequest;
    const request = { filter: state.filter, query: state.query, page: state.page };
    if (!polling) {
      hideNotice();
      setLoading(true);
    } else {
      state.loading = true;
      elements.refresh.disabled = true;
      elements.region.setAttribute("aria-busy", "true");
    }
    const params = new URLSearchParams({ filter: request.filter, page: String(request.page) });
    if (request.query) params.set("q", request.query);
    try {
      const result = await api(`/api/admin/orders?${params.toString()}`);
      if (requestId !== state.listRequest || request.filter !== state.filter ||
          request.query !== state.query || request.page !== state.page) return;
      state.orders = Array.isArray(result.orders) ? result.orders : [];
      state.refreshFailed = false;
      state.total = Number(result.total) || 0;
      state.page = Number(result.page) || state.page;
      state.pageSize = Number(result.pageSize) || 20;
      state.csrfToken = result.csrfToken || state.csrfToken;
      state.enabled = result.enabled !== false;
      state.generatedAt = result.generatedAt || null;
      updateFreshness();
      if(elements.paymentProvider){
        elements.paymentProvider.replaceChildren();
        addText(elements.paymentProvider,"strong",`Новые оплаты: ${providerName(result.activePaymentProvider)}.`);
        addText(elements.paymentProvider,"p","Переключение только вручную по команде владельца. Начатые оплаты завершаются через исходный сервис.");
        if(Array.isArray(result.providerHistory)&&result.providerHistory.length){
          const details=document.createElement("details");
          addText(details,"summary","История ручных переключений");
          result.providerHistory.forEach(entry=>addText(details,"p",
            `${formatDate(entry.changed_at)} · ${providerName(entry.previous_provider)} → ${providerName(entry.next_provider)}`));
          elements.paymentProvider.append(details);
        }
        elements.paymentProvider.hidden=false;
      }
      elements.greeting.textContent = result.user && result.user.name ? `Здравствуйте, ${result.user.name}` : "Кабинет поддержки";
      elements.attention.textContent = result.summary && result.summary.attention != null ? String(result.summary.attention) : "—";
      elements.delivered.textContent = result.summary && result.summary.delivered != null ? String(result.summary.delivered) : "—";
      elements.inProgress.textContent = result.summary && result.summary.inProgress != null ? String(result.summary.inProgress) : "—";
      if (elements.unverified) elements.unverified.textContent = result.summary && result.summary.unverified != null ? String(result.summary.unverified) : "—";
      renderOrders();
      if (polling) window.clubAnalytics.load(window.clubAnalytics.period,"poll");
      if (!state.enabled) {
        showNotice("Автоматическая отправка доступов ещё не включена. Здесь появятся новые заказы после её включения.", "warning");
      } else if (result.alertsConfigured === false) {
        showNotice("Email-уведомления владельцу не настроены. Проблемные письма пока видны только в этом разделе.", "warning");
      }
    } catch (error) {
      if (requestId !== state.listRequest) return;
      if (polling) {
        state.refreshFailed = true;
        if (elements.freshness) elements.freshness.classList.add("is-stale");
      } else {
        state.orders = [];
        state.total = 0;
        elements.region.replaceChildren(makeState("Не удалось загрузить заказы", explainError(error), true));
        elements.results.textContent = "Список недоступен";
        elements.pagination.hidden = true;
        showNotice(explainError(error), error.status === 401 || error.status === 403 || error.status === 503 ? "warning" : "error");
      }
    } finally {
      if (requestId === state.listRequest) {
        if (!polling) setLoading(false);
        else {
          state.loading = false;
          elements.region.setAttribute("aria-busy", "false");
          elements.refresh.disabled = false;
        }
      }
    }
  }
  function updateFreshness() {
    window.clubAnalytics?.updateFreshness();
    if (!elements.freshness) return;
    const stamp = Date.parse(state.generatedAt || "");
    if (!Number.isFinite(stamp)) {
      elements.freshness.textContent = "Свежесть данных неизвестна";
      elements.freshness.classList.add("is-stale");
      return;
    }
    const age = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
    elements.freshness.textContent = state.refreshFailed ? "Обновление не удалось · показаны прежние данные" :
      age < 60 ? "Данные только что обновлены" : `Обновлено ${Math.floor(age / 60)} мин. назад`;
    elements.freshness.title = formatDate(state.generatedAt);
    elements.freshness.classList.toggle("is-stale", age > 120 || state.refreshFailed);
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
  function renderDetail(order, history, audit, paymentHistory) {
    elements.detailContent.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    addDetailItem(grid, "Участник", order.buyer_name);
    addDetailItem(grid, "Email плательщика (из платежа)", order.buyer_email);
    addDetailItem(grid, order.tariff==="premium"?"Email для входа":"Email письма",
      order.tariff==="premium"?(order.account_email||"пока не привязан к заказу"):(order.recipient_email||order.buyer_email));
    addDetailItem(grid, "Тариф", label(order.tariff));
    addDetailItem(grid, "Оплата", formatAmount(order.amount_cents));
    addDetailItem(grid, "Статус оплаты", label(order.last_payment_status || order.status));
    addDetailItem(grid, "Обработка доступа", label(order.status));
    addDetailItem(grid, "Состояние письма", label(order.delivery_status || order.mail_state));
    if(order.access_confirmed_at)addDetailItem(grid,"Получение доступа","Подтверждено вручную · "+formatDate(order.access_confirmed_at));
    addDetailItem(grid, "Платёжный сервис", providerName(order.payment_provider));
    addDetailItem(grid, "Провайдер онлайн-кассы", order.receipt_provider || "Не подтверждён");
    addDetailItem(grid, "Статус чека", order.receipt_status === "unknown" || !order.receipt_status ? "Нет подтверждённых данных" : label(order.receipt_status));
    if(order.receipt_id)addDetailItem(grid,"ID чека",order.receipt_id);
    addDetailItem(grid, "Почтовый сервис", order.provider);
    addDetailItem(grid, "Попытки отправки", order.attempts);
    addDetailItem(grid, "Создан", formatDate(order.created_at));
    addDetailItem(grid, "Оплачен", formatDate(order.paid_at));
    addDetailItem(grid, "Последняя отправка", formatDate(order.last_sent_at));
    addDetailItem(grid, "Последняя проверка", formatDate(order.status_checked_at));
    if (order.provider_message_id) addDetailItem(grid, "ID письма у провайдера", order.provider_message_id);
    if (order.last_error_code) addDetailItem(grid,
      ["external_delivery_unverified","status_unavailable","send_uncertain"].includes(order.last_error_code)?
        "Ограничение проверки":"Причина последней ошибки",
      order.last_error_code==="external_delivery_unverified"?"Prodamus не передаёт подтверждение доставки":label(order.last_error_code));
    if (order.queue_reason) addDetailItem(grid, "Почему заказ в этой очереди", order.queue_reason);
    if (order.next_action) addDetailItem(grid, "Следующий шаг", order.next_action);
    elements.detailContent.append(grid);
    if(order.payment_requires_review||["refund_reported","refunded","partially_refunded"].includes(order.last_payment_status))
      addText(elements.detailContent,"p","Провайдер сообщил о возврате. Доступ автоматически не отзывается — требуется проверка владельцем.","detail-explanation");
    const paymentSection=document.createElement("section");
    paymentSection.className="history-section";
    addText(paymentSection,"h3","События оплаты");
    const payments=document.createElement("ul");
    payments.className="history-list";
    if(!Array.isArray(paymentHistory)||!paymentHistory.length)addText(payments,"li","Подтверждённых событий провайдера пока нет.");
    else paymentHistory.forEach(entry=>addText(payments,"li",
      `${formatDate(entry.created_at)} · ${providerName(entry.payment_provider)} · ${label(entry.provider_status)} · ${formatAmount(entry.amount_cents)}${entry.transaction_id ? " · ID "+entry.transaction_id : ""}${entry.error_code ? " · код "+entry.error_code : ""}`));
    paymentSection.append(payments);
    elements.detailContent.append(paymentSection);
    const explanation = addText(elements.detailContent, "p", "Очередь NotiSend и статус «Отправлено» ещё не подтверждают доставку. Только «Принято сервером получателя» означает приём почтовым сервером — не попадание во входящие. При отказе провайдера или получателя сначала проверьте причину; повтор не снимает блокировку и не отменяет отписку.", "detail-explanation");
    explanation.setAttribute("role", "note");
    if ((order.delivery_status === "unknown" || order.queue_category === "unverified") &&
        (order.payment_provider === "prodamus" || order.provider === "prodamus")) {
      const providerUnknown = addText(elements.detailContent, "p",
        "Статус Prodamus не подтверждён: провайдер не возвращает подтверждение доставки. Это неопределённость, а не зарегистрированный отказ. Перед повторной отправкой проверьте фактическую ситуацию.",
        "detail-explanation");
      providerUnknown.setAttribute("role", "note");
    }
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
    const requestId = ++state.detailRequest;
    const requestedId = String(id);
    clearCredential();
    elements.credentialPanel.hidden = true;
    state.currentOrder = state.orders.find((order) => String(order.order_id) === String(id)) || {order_id:requestedId};
    elements.detailId.textContent = text(id);
    elements.detailActions.hidden = true;
    elements.detailContent.replaceChildren();
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton-row";
    elements.detailContent.append(skeleton);
    if (!elements.dialog.open) elements.dialog.showModal();
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(id)}`);
      if (requestId !== state.detailRequest || !elements.dialog.open ||
          String(state.currentOrder?.order_id) !== requestedId) return;
      state.csrfToken = result.csrfToken || state.csrfToken;
      if (!result.order || String(result.order.order_id)!==requestedId) throw new Error("В ответе сервера нет данных заказа.");
      state.currentOrder = result.order;
      renderDetail(state.currentOrder, result.history, result.audit, result.paymentHistory);
      const credentialEligible = state.enabled && state.currentOrder.tariff === "premium" &&
        state.currentOrder.status === "paid" && !state.currentOrder.payment_requires_review &&
        !["refund_reported","refunded","partially_refunded","canceled","refund_failed"].includes(state.currentOrder.last_payment_status);
      elements.credentialPanel.hidden = !credentialEligible;
      elements.credentialLogin.textContent = state.currentOrder.recipient_email || state.currentOrder.buyer_email || "—";
      elements.viewPassword.disabled = !credentialEligible;
      elements.resetPassword.disabled = !credentialEligible || !["accepted","blocked"].includes(state.currentOrder.mail_state);
      elements.check.disabled = !state.enabled || state.currentOrder.provider !== "notisend" ||
        !state.currentOrder.provider_message_id || !["queued","sent","unknown"].includes(state.currentOrder.delivery_status);
      elements.resend.disabled = !state.enabled || state.currentOrder.status !== "paid" ||
        Boolean(state.currentOrder.payment_requires_review) ||
        ["refund_reported","refunded","partially_refunded","canceled","refund_failed"].includes(state.currentOrder.last_payment_status) ||
        !["accepted","blocked"].includes(state.currentOrder.mail_state);
      elements.confirmAccess.disabled = !state.enabled || state.currentOrder.status !== "paid" ||
        state.currentOrder.last_payment_status !== "paid" || state.currentOrder.payment_requires_review ||
        state.currentOrder.mail_state === "sending" || Boolean(state.currentOrder.access_confirmed_at);
      elements.confirmAccess.textContent = state.currentOrder.access_confirmed_at ? "Доступ подтверждён вручную" : "Оплата и доступ подтверждены";
      elements.detailActions.hidden = false;
    } catch (error) {
      if (requestId !== state.detailRequest || !elements.dialog.open ||
          String(state.currentOrder?.order_id) !== requestedId) return;
      elements.detailContent.replaceChildren(makeState("Подробности недоступны", explainError(error), true));
      showNotice(explainError(error), error.status === 401 || error.status === 403 ? "warning" : "error");
    }
  }
  function beginConfirmAccess(){
    if(!state.currentOrder||elements.confirmAccess.disabled)return;
    elements.accessForm.reset();
    elements.accessForm.querySelector("[data-action-error]")?.remove();
    elements.accessDialog.showModal();
  }
  async function confirmAccess(event){
    event.preventDefault();
    if(!state.currentOrder||!elements.accessCheckbox.checked||elements.accessSubmit.disabled)return;
    const order=state.currentOrder;
    elements.accessSubmit.disabled=true;
    try{
      await api(`/api/admin/orders/${encodeURIComponent(order.order_id)}/confirm-access`,{
        method:"POST",headers:{"X-CSRF-Token":state.csrfToken},
        body:JSON.stringify({confirmed:true,expectedAttempts:order.attempts,expectedMessageId:order.provider_message_id||null})
      });
      elements.accessDialog.close();
      await loadOrders();
      await openOrder(order.order_id);
      announce("Получение доступа подтверждено вручную. Заказ перенесён в «Письмо принято».");
    }catch(error){
      elements.accessForm.querySelector("[data-action-error]")?.remove();
      const message=document.createElement("p");message.dataset.actionError="true";message.setAttribute("role","alert");
      message.textContent=explainError(error);elements.accessForm.append(message);
    }finally{elements.accessSubmit.disabled=false;}
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
  function clearCredential() {
    elements.credentialValue.textContent = "";
    elements.credentialValue.hidden = true;
    elements.credentialFeedback.textContent = "";
  }
  function displayCredential(result) {
    elements.credentialLogin.textContent = result.loginEmail || elements.credentialLogin.textContent;
    elements.credentialValue.textContent = result.password;
    elements.credentialValue.hidden = false;
    elements.credentialFeedback.textContent = result.emailQueued
      ? "Новый пароль сохранён. Письмо в очереди; его доставку проверяйте по статусу ниже."
      : "Текущий пароль проверен. Просмотр записан в журнал поддержки.";
  }
  async function viewPassword() {
    if (!state.currentOrder || elements.viewPassword.disabled) return;
    const id = state.currentOrder.order_id;
    clearCredential();
    elements.viewPassword.disabled = true;
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(id)}/password`, {
        method: "POST", headers: { "X-CSRF-Token": state.csrfToken }, body: "{}"
      });
      if (state.currentOrder?.order_id === id && elements.dialog.open) displayCredential(result);
    } catch (error) {
      if (state.currentOrder?.order_id === id && elements.dialog.open)
        elements.credentialFeedback.textContent = explainError(error);
    } finally {
      if (state.currentOrder?.order_id === id) elements.viewPassword.disabled = false;
    }
  }
  function beginPasswordReset() {
    if (!state.currentOrder || elements.resetPassword.disabled) return;
    elements.resetForm.reset();
    const oldError = elements.resetForm.querySelector("[data-action-error]");
    if (oldError) oldError.hidden = true;
    elements.confirmPasswordReset.disabled = false;
    if (!elements.resetDialog.open) elements.resetDialog.showModal();
  }
  async function resetOrderPassword(event) {
    event.preventDefault();
    if (!state.currentOrder || !elements.resetRequested.checked || elements.confirmPasswordReset.disabled) return;
    const order = state.currentOrder;
    elements.confirmPasswordReset.disabled = true;
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(order.order_id)}/reset-password`, {
        method: "POST", headers: { "X-CSRF-Token": state.csrfToken },
        body: JSON.stringify({confirmRequested:true,expectedAttempts:order.attempts || 0,
          expectedMessageId:order.provider_message_id || null})
      });
      clearCredential();
      elements.resetDialog.close();
      await loadOrders();
      await openOrder(order.order_id);
      if (state.currentOrder?.order_id === order.order_id) displayCredential(result);
    } catch (error) {
      dialogError(elements.resetForm, explainError(error));
    } finally {
      elements.confirmPasswordReset.disabled = false;
    }
  }
  function beginResend() {
    if (!state.currentOrder) return;
    const accepted = isMailAccepted(state.currentOrder) || state.currentOrder.last_error_code === "send_uncertain";
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
    if ((isMailAccepted(state.currentOrder) || state.currentOrder.last_error_code === "send_uncertain") && reason !== "customer_request") {
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
  elements.refresh.addEventListener("click", () => {
    loadOrders();
    window.clubAnalytics.load(window.clubAnalytics.period);
  });
  elements.prev.addEventListener("click", () => {
    if (state.page > 1) { state.page -= 1; loadOrders(); }
  });
  elements.next.addEventListener("click", () => {
    if (state.page < Math.ceil(state.total / state.pageSize)) { state.page += 1; loadOrders(); }
  });
  elements.closeDialog.addEventListener("click", () => elements.dialog.close());
  elements.check.addEventListener("click", checkStatus);
  elements.resend.addEventListener("click", beginResend);
  elements.confirmAccess.addEventListener("click",beginConfirmAccess);
  elements.accessForm.addEventListener("submit",confirmAccess);
  elements.accessCancel.addEventListener("click",()=>elements.accessDialog.close());
  elements.viewPassword.addEventListener("click", viewPassword);
  elements.resetPassword.addEventListener("click", beginPasswordReset);
  elements.resetForm.addEventListener("submit", resetOrderPassword);
  elements.cancelPasswordReset.addEventListener("click", () => elements.resetDialog.close());
  elements.dialog.addEventListener("close", clearCredential);
  window.addEventListener("pagehide", clearCredential);
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
  elements.dialog.addEventListener("close", () => { state.detailRequest += 1; clearCredential(); });
  elements.confirmDialog.addEventListener("click", (event) => {
    if (event.target === elements.confirmDialog) elements.confirmDialog.close();
  });
  document.querySelectorAll("[data-period]").forEach(button => {
    button.addEventListener("click", () => {
      if (button.dataset.period === window.clubAnalytics.period) return;
      document.querySelectorAll("[data-period]").forEach(tab => {
        const active = tab === button;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
      });
      window.clubAnalytics.load(button.dataset.period);
    });
  });
  window.clubAnalytics.load("30");
  window.setInterval(() => loadOrders("poll"), 30000);
  window.setInterval(updateFreshness, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadOrders("poll");
  });
  window.addEventListener("pagehide", () => { state.detailRequest += 1; });
  const initialOrder = new URLSearchParams(window.location.search).get("order");
  if (initialOrder) {
    state.filter = "all";
    document.querySelectorAll(".filter-tab").forEach(tab => {
      const active = tab.dataset.filter === "all";
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    });
    loadOrders().then(() => openOrder(initialOrder));
  } else loadOrders();
})();
