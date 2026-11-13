/* popup.js */
'use strict';

const $ = (id) => document.getElementById(id);

/* 版本号从 manifest 读，避免手写常量过期 */
try {
  const v = chrome.runtime.getManifest().version;
  const el = document.querySelector('.ver');
  if (el && v) el.textContent = 'v' + v;
} catch (e) {}

function render() {
  chrome.storage.local.get(['jr:jobs', 'jr:applied', 'jr:run', 'jr:plan'], (r) => {
    const jobs = Array.isArray(r['jr:jobs']) ? r['jr:jobs'] : [];
    const applied = r['jr:applied'] || {};
    $('n1').textContent = jobs.length;
    $('n2').textContent = jobs.filter((j) => !j.blocked && !applied[j.id]).length;
    $('n3').textContent = Object.keys(applied).length;

    const plan = r['jr:plan'];
    if (plan && Array.isArray(plan.items) && plan.items.length) {
      $('resume').textContent = '简历匹配 · 已同步 ' + plan.items.length + ' 个岗位';
    }

    const run = r['jr:run'] || {};
    if (run.running) {
      $('runBar').style.display = 'block';
      $('runTxt').textContent = run.current || '';
    }
  });
}

render();

$('go').addEventListener('click', () => {
  chrome.storage.sync.get('jr:cfg', (o) => {
    const q = (o['jr:cfg'] && o['jr:cfg'].jobQuery) || '';
    chrome.tabs.create({
      url: 'https://www.zhipin.com/web/geek/job' + (q ? '?query=' + encodeURIComponent(q) : '')
    });
    window.close();
  });
});

$('resume').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('resume.html') });
  window.close();
});

$('opt').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  window.close();
});

$('exp').addEventListener('click', () => {
  chrome.storage.local.get(['jr:jobs', 'jr:applied'], (r) => {
    const jobs = Array.isArray(r['jr:jobs']) ? r['jr:jobs'] : [];
    if (!jobs.length) return;
    const applied = r['jr:applied'] || {};
    jobs.sort((a, b) => b.score - a.score);
    const head = ['分数', '职位', '公司', '薪资', '区域', '经验', '学历', '阶段', '规模', 'HR活跃', '已投', '排除原因', '链接'];
    const rows = jobs.map((j) => [j.score, j.title, j.company, j.salary, j.area, j.exp,
      j.degree, j.stage, j.scale, j.active, applied[j.id] ? '是' : '',
      j.blocked ? j.blockReason : '', j.url]
      .map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(','));
    const csv = '\ufeff' + [head.join(','), ...rows].join('\r\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'jobradar-' + Date.now() + '.csv';
    a.click();
  });
});
