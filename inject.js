/*
 * inject.js —— 注入到页面主世界（page context）
 * 目的：从 BOSS 直聘列表接口拿到结构化岗位数据，比解析 DOM 稳得多。
 * 只做只读监听，不改写任何请求/响应。
 */
(function () {
  'use strict';
  if (window.__JR_INJECTED__) return;
  window.__JR_INJECTED__ = true;

  var TAG = '__JOBRADAR__';
  var PATTERN = /search\/joblist|joblist\.json|zpgeek\/search/i;

  function emit(type, payload) {
    try {
      window.postMessage({ tag: TAG, type: type, payload: payload }, '*');
    } catch (e) { /* ignore */ }
  }

  function safeParse(text) {
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function handle(body) {
    if (!body || typeof body !== 'object') return;
    var d = body.zpData || body.data || body;
    if (!d || typeof d !== 'object') return;
    var list = d.jobList || d.jobCardList || d.list;
    if (!Array.isArray(list) || !list.length) return;
    emit('joblist', {
      jobs: list,
      query: d.query || '',
      city: d.city || '',
      total: d.totalCount || list.length
    });
  }

  /* ---- fetch hook ---- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (PATTERN.test(url)) {
          p.then(function (res) {
            return res.clone().text();
          }).then(function (txt) {
            handle(safeParse(txt));
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  /* ---- XHR hook ---- */
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__jrUrl = String(u || ''); } catch (e) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      if (self.__jrUrl && PATTERN.test(self.__jrUrl)) {
        self.addEventListener('load', function () {
          try {
            if (self.responseType === 'json') handle(self.response);
            else handle(safeParse(self.responseText));
          } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
    return XS.apply(this, arguments);
  };

  emit('ready', { href: location.href });
})();
