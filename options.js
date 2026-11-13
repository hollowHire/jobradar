/* options.js */
'use strict';

const DEFAULT_CFG = {
  salaryFloor: 15, targetMin: 22, targetMax: 32,
  city: '杭州', district: '西湖区', excludeDistricts: '',
  homeAddress: '', amapKey: '', maxCommuteKm: 8,
  includeKeywords: 'AI,大模型,Agent,前端,Node,数据',
  excludeKeywords: '外包,驻场,人力派遣,销售,电话,大小周,单休,996,夜班',
  mustWelfare: '双休,五险一金',
  preferStages: 'B轮,C轮,D轮及以上,已上市,不需要融资',
  blockScales: '',
  jobQuery: '前端',
  greeting: '',
  batchSize: 15, autoIntervalSec: 15, dailyCap: 40,
  cfgVer: 2,
  hideBlocked: false
};

const TEXT_FIELDS = [
  'jobQuery', 'city', 'district', 'excludeDistricts', 'homeAddress', 'amapKey',
  'includeKeywords', 'excludeKeywords', 'mustWelfare', 'preferStages', 'blockScales', 'greeting'
];
const NUM_FIELDS = [
  'salaryFloor', 'targetMin', 'targetMax', 'maxCommuteKm', 'batchSize', 'autoIntervalSec', 'dailyCap'
];

const $ = (id) => document.getElementById(id);

function fill(cfg) {
  TEXT_FIELDS.forEach((k) => { if ($(k)) $(k).value = cfg[k] == null ? '' : cfg[k]; });
  NUM_FIELDS.forEach((k) => { if ($(k)) $(k).value = cfg[k] == null ? '' : cfg[k]; });
}

function read() {
  const cfg = {};
  TEXT_FIELDS.forEach((k) => { cfg[k] = ($(k).value || '').trim(); });
  NUM_FIELDS.forEach((k) => {
    const v = parseFloat($(k).value);
    cfg[k] = isNaN(v) ? DEFAULT_CFG[k] : v;
  });
  cfg.autoIntervalSec = Math.min(180, Math.max(5, cfg.autoIntervalSec || 15));
  cfg.batchSize = Math.min(60, Math.max(1, cfg.batchSize || 15));
  cfg.dailyCap = Math.min(200, Math.max(1, cfg.dailyCap || 40));
  cfg.cfgVer = 2;            // 已迁移到新节奏，避免下次被当成老配置重置
  cfg.hideBlocked = false;
  return cfg;
}

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.style.background = bad ? '#dc2626' : '#16a34a';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1700);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function loadStats() {
  chrome.storage.local.get(['jr:jobs', 'jr:stats', 'jr:applied'], (r) => {
    const jobs = Array.isArray(r['jr:jobs']) ? r['jr:jobs'] : [];
    $('jobCount').textContent = jobs.length;
    $('appliedCount').textContent = Object.keys(r['jr:applied'] || {}).length;
    const s = r['jr:stats'] || {};
    $('openedCount').textContent = s.date === todayKey() ? (s.opened || 0) : 0;
  });
}

function renderLog() {
  chrome.storage.local.get(['jr:log'], (r) => {
    const log = Array.isArray(r['jr:log']) ? r['jr:log'] : [];
    if (!log.length) {
      $('logBox').innerHTML = '<div style="color:#5f6a7d;padding:6px 0">还没有投递记录。到搜索页打开面板，点「自动投递」。</div>';
      return;
    }
    $('logBox').innerHTML = log.slice(0, 120).map((l) => {
      const d = new Date(l.ts);
      const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      const color = l.ok ? '#7ee2a8' : '#fca5a5';
      const mark = l.ok ? '✓' : '✗';
      return '<div style="display:flex;gap:8px;border-bottom:1px solid rgba(255,255,255,.05);padding:4px 0">' +
        '<span style="color:#5f6a7d;flex:0 0 42px">' + hm + '</span>' +
        '<span style="color:' + color + ';flex:0 0 12px">' + mark + '</span>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfdcec">' +
        (l.title || '') + ' · ' + (l.company || '') + '</span>' +
        '<span style="color:#6b7688;flex:0 0 96px;text-align:right">' + (l.reason || '') + '</span>' +
        '</div>';
    }).join('');
  });
}

function downloadCsv(name, rows) {
  const csv = '\ufeff' + rows.map((r) =>
    r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = name;
  a.click();
}

function exportJobs() {
  chrome.storage.local.get(['jr:jobs', 'jr:applied'], (r) => {
    const jobs = Array.isArray(r['jr:jobs']) ? r['jr:jobs'] : [];
    if (!jobs.length) return toast('还没有数据', true);
    const applied = r['jr:applied'] || {};
    jobs.sort((a, b) => b.score - a.score);
    const head = ['分数', '职位', '公司', '薪资', '区域', '经验', '学历', '阶段', '规模', 'HR活跃', '已投', '排除原因', '链接'];
    const rows = jobs.map((j) => [j.score, j.title, j.company, j.salary, j.area, j.exp, j.degree,
      j.stage, j.scale, j.active, applied[j.id] ? '是' : '', j.blocked ? j.blockReason : '', j.url]);
    downloadCsv('jobradar-' + todayKey() + '.csv', [head].concat(rows));
    toast('已导出 ' + jobs.length + ' 条');
  });
}

function exportLog() {
  chrome.storage.local.get(['jr:log'], (r) => {
    const log = Array.isArray(r['jr:log']) ? r['jr:log'] : [];
    if (!log.length) return toast('还没有投递记录', true);
    const head = ['时间', '结果', '职位', '公司', '薪资', '分数', '原因'];
    const rows = log.map((l) => [new Date(l.ts).toLocaleString('zh-CN'), l.ok ? '成功' : '失败',
      l.title, l.company, l.salary, l.score, l.reason]);
    downloadCsv('jobradar-log-' + todayKey() + '.csv', [head].concat(rows));
    toast('已导出 ' + log.length + ' 条记录');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get('jr:cfg', (o) => {
    fill(Object.assign({}, DEFAULT_CFG, o['jr:cfg'] || {}));
  });
  loadStats();
  renderLog();

  $('btnSave').addEventListener('click', () => {
    const cfg = read();
    if (cfg.targetMin > cfg.targetMax) return toast('期望下限不能大于上限', true);
    if (cfg.dailyCap > 120) return toast('每日上限建议 ≤ 120', true);
    chrome.storage.sync.get('jr:cfg', (old) => {
      const prevQ = String(((old || {})['jr:cfg'] || {}).jobQuery || '').trim();
      chrome.storage.sync.set({ 'jr:cfg': cfg }, () => {
        const changed = String(cfg.jobQuery || '').trim() !== prevQ;
        toast(changed ? '已保存。岗位名称改了，记得去 BOSS 搜一次' : '已保存，回到列表页会自动重新打分');
        loadStats();
        /* 改完关键词最忌讳「以为改了就生效」：直接给他一个去搜的入口。
         * 不重新搜的话，岗位池里还是上一批岗位，简历匹配页也只能按旧词匹配。 */
        if (changed && cfg.jobQuery) {
          const url = 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(cfg.jobQuery);
          if (confirm('岗位名称已改成「' + cfg.jobQuery + '」。\n\n' +
            '岗位池里现在还是上一批岗位 —— 要去 BOSS 搜一次吗？\n' +
            '（抓到新岗位后，简历匹配页就会按「' + cfg.jobQuery + '」出结果）')) {
            try { chrome.tabs.create({ url }); } catch (e) { window.open(url, '_blank'); }
          }
        }
      });
    });
  });

  $('btnReset').addEventListener('click', () => {
    if (!confirm('恢复默认筛选条件？（不影响已抓取的岗位）')) return;
    chrome.storage.sync.set({ 'jr:cfg': DEFAULT_CFG }, () => {
      fill(DEFAULT_CFG);
      toast('已恢复默认');
    });
  });

  $('btnExport').addEventListener('click', exportJobs);
  $('btnExportLog').addEventListener('click', exportLog);

  $('btnClear').addEventListener('click', () => {
    if (!confirm('清空本地保存的岗位数据？（已投记录会保留）')) return;
    chrome.storage.local.set({ 'jr:jobs': [] }, () => {
      toast('已清空');
      loadStats();
    });
  });

  $('btnClearApplied').addEventListener('click', () => {
    if (!confirm('重置已投记录？重置后同一批岗位可能被重复投递。')) return;
    chrome.storage.local.set({ 'jr:applied': {} }, () => {
      toast('已重置');
      loadStats();
    });
  });
});
