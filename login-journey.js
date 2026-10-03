/* Independent ES5 observer: native login still works if this file cannot load. */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var token = script.getAttribute('data-token');
  var code = script.getAttribute('data-code');
  var page = script.getAttribute('data-page');
  var initialized = false;
  var sent = {};
  var storageKey = 'club_login_journey';
  var previous;
  try { previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
  // Stitch a cookie-less redirect back to the login form to the prior submission.
  if (page === 'login' && previous && previous.submitted &&
      /^L-[0-9A-F]{16}\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(previous.token || '') &&
      Date.now() - Number(previous.token.split('.')[1]) < 1800000) {
    token = previous.token;
    code = token.split('.')[0];
    send('returned_to_login');
  }
  function remember(submitted) {
    try { sessionStorage.setItem(storageKey, JSON.stringify({token: token, submitted: submitted})); } catch (_) {}
  }
  function send(stage, details) {
    if (sent[stage]) return;
    sent[stage] = true;
    var event = {token: token, stage: stage, page: page};
    if (details) for (var key in details) if (Object.prototype.hasOwnProperty.call(details, key)) event[key] = details[key];
    try {
      var body = JSON.stringify(event);
      if (navigator.sendBeacon && navigator.sendBeacon('/api/auth/diagnostics',
          new Blob([body], {type: 'application/json'}))) return;
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/auth/diagnostics', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (_) {}
  }
  function errorKind(error) {
    var name = error && error.name;
    return /^(SyntaxError|TypeError|ReferenceError|SecurityError|Error)$/.test(name || '') ? name : 'other';
  }
  window.clubLoginDiagnostic = {
    stage: function (stage, details) {
      if (stage === 'cabinet_initialized') initialized = true;
      send(stage, details);
    }
  };
  window.addEventListener('error', function (event) {
    if (event.error || typeof event.message === 'string') {
      var kind = errorKind(event.error);
      if (kind === 'other' && typeof event.message === 'string') {
        var match = /^(SyntaxError|TypeError|ReferenceError|SecurityError):/.exec(event.message);
        if (match) kind = match[1];
      }
      send('script_error', {errorKind: kind});
    }
  });
  window.addEventListener('unhandledrejection', function (event) {
    send('promise_error', {errorKind: errorKind(event.reason)});
  });
  document.addEventListener('DOMContentLoaded', function () {
    var badge = document.querySelector('#loginJourneyCode span');
    if (badge) badge.textContent = code;
    var form = document.querySelector('#screen-login form');
    if (page === 'login' && form) {
      var trace = form.querySelector('input[name="_login_trace"]');
      if (trace) trace.value = token;
      remember(false);
      send('form_loaded', {cookieEnabled: !!navigator.cookieEnabled,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight});
      form.addEventListener('invalid', function (event) {
        send('form_invalid', {field: event.target.name === 'email' ? 'email' :
          event.target.name === 'password' ? 'password' : 'other'});
      }, true);
      var button = form.querySelector('button[type="submit"]');
      if (button) button.addEventListener('click', function () { send('submit_clicked'); });
      form.addEventListener('submit', function () {
        remember(true);
        send('form_submitted');
      });
    }
    if (page === 'club') {
      remember(false);
      send('cabinet_dom_ready', {cookieEnabled: !!navigator.cookieEnabled,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight});
      setTimeout(function () {
        if (initialized) return;
        send('cabinet_timeout');
        var node = document.getElementById('loginJourneyCode');
        if (node) {
          node.textContent = 'Кабинет не завершил загрузку. Код проверки: ' + code +
            '. Сообщите этот код службе заботы.';
          node.setAttribute('role', 'alert');
        }
      }, 15000);
    }
  });
}());