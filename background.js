/* background.js —— 自动投递编排器
 *
 * 关键：MV3 的 service worker 30 秒空闲就会被终止，内存变量全部丢失。
 * 所以 workerWin / workerTab / controllerTab 一律持久化在 chrome.storage.session，
 * 每次用到时读回来 —— 这是「卡在第一个岗位」的根本原因。
 */
'use strict';

const KEY = { cfg: 'jr:cfg', run: 'jr:run', state: 'jr:state' };

async function getState() {
  try {
    const r = await chrome.storage.session.get(KEY.state);
    return r[KEY.state] || {};
  } catch (e) {
    return {};
  }
}
async function setState(patch) {
  const cur = await getState();
  await chrome.storage.session.set({ [KEY.state]: Object.assign({}, cur, patch) });
}

async function pushRun(patch) {
  const r = await chrome.storage.local.get(KEY.run);
  const cur = r[KEY.run] || {};
  await chrome.storage.local.set({ [KEY.run]: Object.assign({}, cur, patch) });
}

async function openWorker(url) {
  const st = await getState();

  if (st.workerWin != null && st.workerTab != null) {
    try {
      await chrome.windows.get(st.workerWin);
      await chrome.tabs.update(st.workerTab, { url: url, active: true });
      return;
    } catch (e) {
      // 窗口已被关掉，继续往下新建
    }
  }

  const w = await chrome.windows.create({
    url: url,
    type: 'popup',
    width: 460,
    height: 820,
    top: 40,
    left: 40,
    focused: false
  });
  await setState({ workerWin: w.id, workerTab: w.tabs && w.tabs[0] ? w.tabs[0].id : null });
}

async function closeWorker() {
  const st = await getState();
  if (st.workerWin != null) {
    try { await chrome.windows.remove(st.workerWin); } catch (e) { /* ignore */ }
  }
  await setState({ workerWin: null, workerTab: null });
}

chrome.windows.onRemoved.addListener(async (winId) => {
  const st = await getState();
  if (winId === st.workerWin) {
    await setState({ workerWin: null, workerTab: null });
    if (st.controllerTab != null) {
      try {
        await chrome.tabs.sendMessage(st.controllerTab, { type: 'jr:workerClosed' });
      } catch (e) { /* controller 可能已关闭 */ }
    }
    pushRun({ running: false, phase: 'stopped' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (tabId === st.workerTab) await setState({ workerWin: null, workerTab: null });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  /* --- 控制器请求：打开 / 跳转到下一个岗位 --- */
  if (msg.type === 'jr:next') {
    (async () => {
      try {
        if (sender.tab && sender.tab.id != null) await setState({ controllerTab: sender.tab.id });

        const sep = msg.job.url.includes('?') ? '&' : '?';
        const url = msg.job.url + sep + 'jr=1&jr_id=' + encodeURIComponent(msg.job.id);
        await openWorker(url);
        await pushRun({
          running: true,
          phase: 'running',
          current: msg.job.title || '',
          currentId: msg.job.id,
          at: Date.now()
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  /* --- 详情页 / 聊天页执行完毕：转发回控制器 --- */
  if (msg.type === 'jr:pageDone') {
    (async () => {
      const st = await getState();
      if (st.controllerTab != null) {
        try {
          await chrome.tabs.sendMessage(st.controllerTab, {
            type: 'jr:done',
            jobId: msg.jobId,
            ok: !!msg.ok,
            reason: msg.reason || ''
          });
        } catch (e) { /* 控制器已关闭，忽略 */ }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* --- 控制器请求：收工 --- */
  if (msg.type === 'jr:stop') {
    (async () => {
      await closeWorker();
      await pushRun({ running: false, phase: 'stopped' });
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* --- 查询工作台是否还活着（控制器定时探活用） --- */
  if (msg.type === 'jr:alive') {
    (async () => {
      const st = await getState();
      let alive = false;
      if (st.workerWin != null) {
        try { await chrome.windows.get(st.workerWin); alive = true; } catch (e) { alive = false; }
      }
      sendResponse({ ok: true, alive: alive });
    })();
    return true;
  }

  if (msg.type === 'openTab') {
    chrome.tabs.create({ url: msg.url, active: !!msg.active });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'openOptions') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'openResume') {
    chrome.tabs.create({ url: chrome.runtime.getURL('resume.html') })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  /* --- 简历页：计划生成后直接开跑，不用用户回搜索页手动点 ---
   * 优先复用已有的 BOSS 搜索结果页（它本来就能当投递控制器）；
   * 没有就开一个新的，content.js 加载时会消费 jr:autoStart 自动开始。 */
  if (msg.type === 'jr:startFromResume') {
    (async () => {
      const url = 'https://www.zhipin.com/web/geek/job' +
        (msg.query ? '?query=' + encodeURIComponent(msg.query) : '');
      try {
        const tabs = await chrome.tabs.query({ url: '*://www.zhipin.com/*' });
        const geek = tabs.filter((t) => /\/web\/geek\//.test(t.url || ''))
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        for (const t of geek) {
          try {
            await chrome.tabs.update(t.id, { active: true });
            try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) { /* ignore */ }
            const r = await chrome.tabs.sendMessage(t.id, { type: 'jr:startNow' });
            if (r && r.busy) {
              sendResponse({ ok: false, error: '面板正在投递，先点「停止」再试' });
              return;
            }
            sendResponse({ ok: true, via: 'reuse', tabId: t.id });
            return;
          } catch (e) {
            /* 这个标签页的 content script 还没就绪，试下一个 */
          }
        }
        const tab = await chrome.tabs.create({ url: url, active: true });
        sendResponse({ ok: true, via: 'new', tabId: tab.id });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'badge') {
    const n = Number(msg.count || 0);
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    sendResponse({ ok: true });
    return true;
  }
});
