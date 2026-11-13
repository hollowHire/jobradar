/* resume.js —— 简历匹配页逻辑 */
'use strict';

const M = window.JRMatcher;
const IO = window.JRResumeIO;

/* ============ 存储：扩展里用 chrome.storage，直接双击打开时退化成 localStorage ============ */
const hasExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const LS = 'jrPage:';
const store = {
  get(keys) {
    return new Promise((resolve) => {
      if (hasExt) { chrome.storage.local.get(keys, (r) => resolve(r || {})); return; }
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
        try { out[k] = JSON.parse(localStorage.getItem(LS + k) || 'null'); } catch (e) { out[k] = null; }
      });
      resolve(out);
    });
  },
  set(obj) {
    return new Promise((resolve) => {
      if (hasExt) { chrome.storage.local.set(obj, () => resolve()); return; }
      Object.keys(obj).forEach((k) => {
        /* file:// 等受限环境下 localStorage 可能直接抛 SecurityError，不能让整个页面挂掉 */
        try { localStorage.setItem(LS + k, JSON.stringify(obj[k])); } catch (e) {}
      });
      resolve();
    });
  },
  syncSet(obj) {
    return new Promise((resolve) => {
      if (hasExt && chrome.storage.sync) { chrome.storage.sync.set(obj, () => resolve()); return; }
      resolve();
    });
  }
};

const $ = (id) => document.getElementById(id);
let PROFILE = null;
let JOBS = [];
let RESULTS = [];
let usingSample = false;

/* 岗位范围：岗位池是跨关键词累积的（搜过「测试」再搜「FDE」，两批都在池里）。
 * 默认只按当前搜索词匹配 —— 先满足「我要找的是这个岗位」，再在里面按简历分排序。
 * 否则改完关键词看到的还是上一批岗位，等于设置白改。 */
let KW = '';        // 当前范围用的搜索词（= 最近一次抓到岗位时搜的词）
let KW_CFG = '';    // 设置页里填的搜索词
let KW_LAST = '';   // 最近一次真的抓到岗位时页面在搜的词
let KW_SRC = 'cfg';
let SCOPE = 'kw';
/* 池子里可能同时存在好几个词（搜过「测试」又搜过「FDE」）。
 * SEL_Q 是用户此刻真正在看的那一个 —— 它和 KW 分开，
 * 因为「最近抓的那个词」不一定就是用户想看的那个。 */
let SEL_Q = '';
let SEL_MANUAL = '';       // 用户手点过的词：自动同步时不要覆盖他的选择
let QMETA = {};            // 每个词最近一次抓到岗位的时间戳 { 词: {at} }
/* 用户手改过的话术：按岗位 id 记住。
 * 页面会在「切回这一屏」时自动重读数据并重绘，重绘不能把改了一半的字擦掉。 */
let EDITS = {};

/* 发送间隔：和 BOSS 面板共用同一份 jr:cfg，改哪边都算数
 * PER_JOB_SEC = BOSS 每个岗位本身要花的时间（等详情页 + 填话术），实测 4~6 秒 */
const GAP_STEPS = [5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90];
const PER_JOB_SEC = 5;
let CFG = { autoIntervalSec: 15 };

/* ============ 示例数据：扩展里没抓到岗位时也能先看看效果 ============ */
const SAMPLE = [
  { id: 's1', title: 'AI Agent 应用工程师', company: '星野智能', salary: '28-45K·14薪', sal: { min: 28, max: 45, months: 14 }, exp: '3-5年', degree: '本科', labels: ['Agent', '大模型', 'React', 'TypeScript'] },
  { id: 's2', title: '高级前端工程师', company: '澜舟智算', salary: '25-35K', sal: { min: 25, max: 35, months: 12 }, exp: '5-10年', degree: '本科', labels: ['React', 'TypeScript', 'Webpack', '微前端'] },
  { id: 's3', title: '大模型算法工程师', company: '深言科技', salary: '35-60K·14薪', sal: { min: 35, max: 60, months: 14 }, exp: '3-5年', degree: '硕士', labels: ['大模型', 'RAG', 'PyTorch', '微调'] },
  { id: 's4', title: '前端开发（小程序）', company: '云集电商', salary: '15-22K', sal: { min: 15, max: 22, months: 12 }, exp: '1-3年', degree: '大专', labels: ['小程序', 'Vue', 'uni-app'] },
  { id: 's5', title: 'AI 产品经理', company: '矩阵智能', salary: '25-40K', sal: { min: 25, max: 40, months: 12 }, exp: '3-5年', degree: '本科', labels: ['AI 应用', 'PRD', '用户研究', '大模型'] },
  { id: 's6', title: 'Go 后端工程师', company: '某云厂商', salary: '25-40K·15薪', sal: { min: 25, max: 40, months: 15 }, exp: '3-5年', degree: '本科', labels: ['Go', 'Kubernetes', 'Redis', '高并发'] },
  { id: 's7', title: 'Java 后端开发', company: '恒信金融', salary: '20-30K', sal: { min: 20, max: 30, months: 12 }, exp: '3-5年', degree: '本科', labels: ['Java', 'Spring Boot', 'MySQL', 'Kafka'] },
  { id: 's8', title: '数据产品经理', company: '某零售集团', salary: '22-32K', sal: { min: 22, max: 32, months: 12 }, exp: '3-5年', degree: '本科', labels: ['数据分析', '指标体系', 'SQL', 'PRD'] },
  { id: 's9', title: '前端工程师（数据看板）', company: '某 SaaS', salary: '22-30K', sal: { min: 22, max: 30, months: 13 }, exp: '3-5年', degree: '本科', labels: ['React', '可视化', 'ECharts', 'TypeScript'] },
  { id: 's10', title: '全栈工程师', company: '某 AI 创业公司', salary: '30-45K', sal: { min: 30, max: 45, months: 12 }, exp: '5-10年', degree: '本科', labels: ['React', 'Node.js', 'TypeScript', '大模型'] }
];

const SAMPLE_RESUME = `张明
求职意向：AI 应用工程师（前端方向）  杭州
电话 13812345678  邮箱 zhangming@example.com
教育背景
2013.09-2017.06  浙江大学  计算机科学与技术  本科
工作经历
2021.07-至今  星野智能  高级前端工程师
- 负责 AI Agent 对话产品的前端架构，用 React + TypeScript 重构会话流组件，首屏从 2.4s 降到 0.9s
- 主导 RAG 知识库问答的检索结果渲染，接入向量检索接口，问答准确率提升 18%
- 搭建前端监控体系（Sentry 加自研埋点），线上白屏率下降 60%
2017.07-2021.06  某电商公司  前端开发工程师
- 用 Vue 重构商品详情页，支撑大促峰值 QPS 3 万
- 负责小程序端活动页开发，累计服务 200 万用户
技能
React / Vue / TypeScript / Node.js / Python；了解 LLM、RAG、Prompt 工程；熟悉 Docker、CI/CD
期望薪资 25-32K`;

/* ============ 通用 ============ */
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function scoreColor(s) {
  if (s >= 80) return 'var(--ok)';
  if (s >= 65) return '#38bdf8';
  if (s >= 50) return 'var(--warn)';
  return 'var(--bad)';
}

/* ============ 解析 ============ */
function parseNow() {
  const raw = $('raw').value.trim();
  if (raw.length < 30) {
    document.getElementById('profileBox').style.display = 'none';
    return;
  }
  PROFILE = M.parseResume(raw);
  renderPoolInfo();
  renderProfile();
  renderMatches();
}

function renderProfile() {
  const p = PROFILE;
  $('profileBox').style.display = 'block';
  $('fYears').textContent = p.years ? p.years + ' 年' : '—';
  $('fDegree').textContent = p.degree || '—';
  $('fSalary').textContent = p.expect ? p.expect.min + '-' + p.expect.max + 'K' : '—';
  $('fCity').textContent = p.city || '—';
  $('fSkills').textContent = p.skills.length;
  $('fBullets').textContent = p.bullets.length;

  $('skillChips').innerHTML = p.skills.slice(0, 16)
    .map((s) => '<span class="chip">' + esc(s) + '</span>').join('') ||
    '<span class="chip n">没识别到技能，检查一下粘贴的内容</span>';
  $('skillChips').innerHTML += p.titles.length
    ? '<span class="chip n">方向：' + esc(p.titles.join(' / ')) + '</span>' : '';

  $('queryChips').innerHTML = M.suggestQueries(p, 3).map((q) => (
    '<button class="sm" data-q="' + esc(q) + '">' + esc(q) + ' ↗</button>'
  )).join('');
}

/* ============ 岗位池 ============ */
/* 旧版本存下来的岗位可能没有 url（早期把 lid/securityId 当成必需字段）。
 * 只要 id 是 BOSS 的加密岗位 id，就能直接拼出详情页链接，别让老数据变砖。 */
function detailUrl(id) {
  if (!id || String(id).indexOf('|') >= 0) return '';
  return 'https://www.zhipin.com/job_detail/' + id + '.html';
}

async function loadJobs() {
  const r = await store.get(['jr:jobs']);
  const arr = Array.isArray(r['jr:jobs']) ? r['jr:jobs'] : [];
  arr.forEach((j) => { if (j && !j.url && j.id) j.url = detailUrl(j.id); });
  if (arr.length >= 3) {
    JOBS = arr.filter((j) => j && j.title && !j.blocked);
    usingSample = false;
  } else if (arr.length) {
    JOBS = arr.filter((j) => j && j.title);
    usingSample = false;
  } else {
    JOBS = SAMPLE.slice();
    usingSample = true;
  }
  renderPoolInfo();
}

/* 简历页是长驻标签页：用户在 BOSS 那边换了词、抓了新岗位，再切回这一屏时，
 * 页面里的 KW / JOBS 还是打开那一刻的旧值 —— 于是「再点一次解析简历」出来的
 * 还是上一批岗位。所以每次解析、每次切回这一屏，都先从存储重新读一遍。 */
let _syncing = null;
let _syncAt = 0;
let _lastSig = '';
function storeSig() {
  return JOBS.length + '|' + JOBS.map((j) => j.id).join(',') + '|' +
    KW_LAST + '|' + KW_CFG + '|' + SEL_Q + '|' + SCOPE + '|' +
    Object.keys(QMETA).sort().map((k) => k + ':' + QMETA[k].at).join(',');
}

async function syncFromStore() {
  if (_syncing) return _syncing;
  _syncing = (async () => {
    await loadCfg();
    await loadJobs();          // 内部会先 renderPoolInfo 一次
    pickDefaultQuery();        // 选哪个词要等岗位读回来才知道
    const sig = storeSig();
    if (!PROFILE) { renderPoolInfo(); _lastSig = sig; return; }
    /* 数据没变就别重绘 —— 用户可能正在里面改话术，白重绘一次就把光标和输入弄丢了 */
    if (sig === _lastSig) { renderPoolInfo(); return; }
    renderMatches();
    _lastSig = storeSig();
  })();
  try { await _syncing; } finally { _syncing = null; }
}

function scheduleSync() {
  const now = Date.now();
  if (now - _syncAt < 800) return;    // 切窗口会连发好几个事件，别重复读
  _syncAt = now;
  syncFromStore();
}

function renderPoolInfo() {
  const total = JOBS.length;
  const q = SEL_Q;                                          // 此刻在看哪个搜索词
  const inQ = q ? JOBS.filter((j) => inScope(j, q)) : JOBS.slice();
  const inKw = inQ.length;                                  // 落在这个词范围内的
  const relCnt = q ? inQ.filter((j) => relevance(j, q)).length : total;   // 标题里真有这个词的
  const offCnt = Math.max(0, inKw - relCnt);                // 范围里但标题不含词（BOSS 推荐位）
  const src = pool();
  const canApply = src.filter((j) => j.url).length;
  const miss = src.length - canApply;

  /* 设置里改了词、池子里又确实一条这个词的岗位都没有 → 才提示去搜。
   * 以前只要「设置里的词 ≠ 上次抓的词」就报警，用户明明已经搜过了也被说成没搜，
   * 而且报的还是「岗位池是上次搜 X 时抓的」，人会以为抓取坏了。 */
  const sync = $('kwSync');
  if (sync) {
    const changed = !!KW_CFG && KW_CFG !== KW_LAST;
    const lack = !!KW_CFG && countOf(KW_CFG) === 0;
    if (usingSample || !changed || !lack) {
      sync.style.display = 'none';
    } else {
      sync.style.display = 'block';
      sync.innerHTML = '设置里的岗位名称是「<b>' + esc(KW_CFG) + '</b>」，但池子里还没有这个词的岗位' +
        (KW_LAST ? '（上次抓到的是「' + esc(KW_LAST) + '」）' : '') +
        '。<button class="sm" data-q="' + esc(KW_CFG) + '">去搜「' + esc(KW_CFG) + '」 ↗</button>' +
        ' 抓到后回来点「解析简历」。';
    }
  }

  const scopeBox = $('scopeBox');
  if (usingSample || !q) {
    if (scopeBox) scopeBox.style.display = 'none';
  } else {
    if (scopeBox) scopeBox.style.display = 'flex';
    const kwBtn = $('scKw'), allBtn = $('scAll'), more = $('scMore');
    if (kwBtn) {
      kwBtn.textContent = '「' + q + '」 ' + (relCnt || inKw);
      kwBtn.className = SCOPE === 'all' ? '' : 'on';
      kwBtn.title = '按「' + q + '」过滤。池子里一共 ' + total + ' 个岗位' +
        (KW_CFG && KW_CFG !== q ? '（设置里填的是「' + KW_CFG + '」）' : '');
    }
    /* 其他搜过的词直接列出来，一点就切过去 —— 用户常常在 BOSS 搜索框直接改词，
     * 设置页那边还是旧值，光靠「当前搜索词」这一个按钮根本切不到想看的那批。 */
    if (more) {
      more.innerHTML = knownQueries()
        .filter((x) => x.q !== q && x.n > 0)
        .slice(0, 4)
        .map((x) => '<button data-scope="q" data-q="' + esc(x.q) + '" title="池子里有 ' + x.n +
          ' 个「' + esc(x.q) + '」的岗位">' + esc(x.q) + ' ' + x.n + '</button>')
        .join('');
    }
    if (allBtn) {
      allBtn.textContent = '全部已抓 ' + total;
      allBtn.className = SCOPE === 'all' ? 'on' : '';
    }
    /* 标题里没这个词的，默认折叠但不丢弃 —— BOSS 的推荐位常常夹在里面 */
    const tip = $('scTip');
    if (tip) {
      if (offCnt > 0) {
        tip.innerHTML = SCOPE === 'kwloose'
          ? '<a data-scope="kw" style="cursor:pointer;color:#8fbcff">隐藏这 ' + offCnt + ' 个标题不含「' + esc(q) + '」的</a>'
          : '<a data-scope="kwloose" style="cursor:pointer;color:var(--dim2)">另有 ' + offCnt +
            ' 个标题不含「' + esc(q) + '」（BOSS 推荐位）· 显示</a>';
      } else {
        tip.textContent = '';
      }
    }
  }

  if (!PROFILE) { $('poolInfo').innerHTML = '先解析简历'; return; }

  if (usingSample) {
    $('poolInfo').innerHTML =
      '<span style="color:var(--warn)">现在是 <b>10 个示例岗位</b>，一个链接都没有，投不出去</span>' +
      '：先回 BOSS 搜索页让面板抓到真实岗位（满 3 个以上），再回这里点「解析简历」。';
    return;
  }

  /* 这个词下一个都没有：必须明说，不能回退到别的词糊弄过去 */
  if (inKw === 0) {
    $('poolInfo').innerHTML =
      '<span style="color:var(--bad)">搜索词「' + esc(q) + '」下还没抓到岗位</span>' +
      '：池子里 ' + total + ' 个都是别的关键词搜的，已排除。' +
      '<button class="sm" data-q="' + esc(q) + '" style="margin-left:6px">去搜「' + esc(q) + '」 ↗</button>';
    return;
  }

  if (canApply === 0) {
    $('poolInfo').innerHTML =
      '<span style="color:var(--bad)">这批 ' + src.length + ' 个岗位都没拿到详情页链接，投不了</span>' +
      '：去 BOSS 搜索页按 F5 刷新一次让面板重抓（链接来自岗位卡片和列表接口），回来再点一次「解析简历」。';
    return;
  }

  $('poolInfo').innerHTML =
    (q ? '搜索词 <b>' + esc(q) + '</b> 下 <b>' + src.length + '</b> 个岗位' : '岗位池 <b>' + src.length + '</b> 个') +
    '，其中 <b>' + canApply + '</b> 个可直接投递' +
    (miss ? '（' + miss + ' 个缺详情页链接，会跳过）' : '') +
    (SCOPE === 'all' && q ? '。当前看的是全部关键词的池子' : '') + '。';
}

/* ============ 搜索词范围 ============ */
function kwHit(text, q) {
  const t = String(text || '').toLowerCase();
  const tokens = String(q || '').toLowerCase().split(/[\s,，、/|·]+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.some((k) => t.indexOf(k) >= 0);
}

/* 标题/标签里到底有没有搜索词（FDE ↔ 前线部署 这类别名交给 matcher 统一处理） */
function relevance(j, q) {
  if (!q) return true;
  try { if (M && M.relevant) return M.relevant(j, q); } catch (e) { /* 兜底 */ }
  return kwHit((j.title || '') + ' ' + (j.labels || []).join(' '), q);
}

/* 和 content.js 保持同一套判断：
 * ① 抓取时记过这个词 → 算
 * ② 没有记录（老数据 / 详情页推荐位抓的）→ 退回标题标签比对，对不上就不算。
 *    以前这里直接放行，结果整个池子都算「当前搜索词」，页面上一堆无关岗位。 */
function inScope(j, q) {
  if (!q) return true;
  if (j.fromResume) return true;
  const qs = j.qs || [];
  if (qs.length && qs.indexOf(q) >= 0) return true;
  return relevance(j, q);
}

function pool() {
  if (SCOPE === 'all' || !SEL_Q) return JOBS;
  const inQ = JOBS.filter((j) => inScope(j, SEL_Q));
  /* kw = 当前搜索词 + 标题里真有这个词；kwloose = 只要在范围内（含 BOSS 推荐位） */
  if (SCOPE === 'kwloose') return inQ;
  const rel = inQ.filter((j) => relevance(j, SEL_Q));
  /* 一个都对不上（搜索词写法太特殊）时不要全清空，退回整个范围 */
  return rel.length ? rel : inQ;
}

/* ============ 匹配 ============ */
function topN() {
  const v = parseInt($('topN').value, 10);
  return Math.max(1, Math.min(50, isNaN(v) ? 10 : v));
}

function renderMatches() {
  if (!PROFILE) return;
  const src = pool();
  if (!src.length) {
    RESULTS = [];
    $('matches').innerHTML = '<div class="empty">' + (SEL_Q && SCOPE !== 'all'
      ? '搜索词「' + esc(SEL_Q) + '」下还没有岗位<br>回 BOSS 搜一下（面板会自动收录），再回来点「解析简历」'
      : '没有可匹配的岗位') + '</div>';
    $('actions').style.display = 'none';
    $('paceBox').style.display = 'none';
    updateApplyBtn();      // RESULTS 空了，按钮要同步禁用，别让人点了没反应
    renderPoolInfo();
    return;
  }
  const scored = M.scoreJobs(PROFILE, src);
  RESULTS = scored.slice(0, topN()).map((j, i) => Object.assign({}, j, {
    greeting: EDITS[j.id] != null ? EDITS[j.id] : M.makeGreeting(PROFILE, j, i),
    edited: EDITS[j.id] != null
  }));

  $('matches').innerHTML = RESULTS.map((j, i) => {
    const hits = j.hits.slice(0, 4).map((h) => '<span class="chip g">' + esc(h.k) + '</span>').join('');
    const gaps = j.gaps.slice(0, 3).map((g) => '<span class="chip r">缺 ' + esc(g.k) + '</span>').join('');
    const flags = j.flags.map((f) => '<span class="chip n">⚠ ' + esc(f) + '</span>').join('');
    /* 标题里没有当前搜索词：多半是 BOSS 的推荐位/详情页相似职位，标出来别让人误会 */
    const offQ = (SEL_Q && !relevance(j, SEL_Q))
      ? '<span class="chip n" title="标题和标签里都没有「' + esc(SEL_Q) + '」，通常是 BOSS 推荐位混进来的">词外</span>'
      : '';
    const meta = [j.company, j.exp, j.degree, j.area].filter(Boolean).join(' · ');

    /* 详情页链接：匹配分是本地算的，得让用户能点回原 JD 自己核对一遍。
     * 有 url → 新标签打开（不带 jr=1，不会触发自动投递）；
     * 没 url → 直说投不出去，别让人以为只是没显示。 */
    const detail = j.url
      ? '<a class="m-link" href="' + esc(j.url) + '" target="_blank" rel="noreferrer noopener"' +
        ' data-detail="' + i + '" title="' + esc(j.url) + '">查看详情 ↗</a>'
      : '<span class="m-link off" title="没拿到详情页链接，这条投不出去；回 BOSS 搜索页按 F5 重抓一次通常就有">无详情页链接</span>';

    return '<div class="m-item" data-i="' + i + '">' +
      '<div class="m-top">' +
      '<div class="m-score"><b style="color:' + scoreColor(j.match) + '">' + j.match + '</b><span>匹配</span></div>' +
      '<div class="m-main">' +
      '<div class="m-t1">' + (j.url
        ? '<a class="m-nm" href="' + esc(j.url) + '" target="_blank" rel="noreferrer noopener"' +
          ' data-detail="' + i + '" title="' + esc(j.url) + '">' + esc(j.title) + '</a>'
        : '<span class="m-nm">' + esc(j.title) + '</span>') +
      '<span class="m-sal">' + esc(j.salary || '面议') + '</span></div>' +
      '<div class="m-t2"><span class="m-meta">' + esc(meta) + '</span>' + detail + '</div>' +
      '<div class="m-kv">' + offQ + hits + gaps + flags + '</div>' +
      '<div class="m-msg">' +
      '<div class="mt"><span>打招呼语（可直接改）</span>' +
      '<span class="len" data-len="' + i + '">' + j.greeting.length + ' 字</span></div>' +
      '<textarea data-g="' + i + '" spellcheck="false">' + esc(j.greeting) + '</textarea>' +
      '</div></div></div></div>';
  }).join('');

  $('actions').style.display = 'flex';
  $('applyHint').style.display = 'block';
  updateApplyBtn();
  renderPace();
  renderPoolInfo();
}

/* ============ 节奏（发送间隔） ============ */
async function loadCfg() {
  if (hasExt && chrome.storage && chrome.storage.sync) {
    const r = await new Promise((res) => {
      chrome.storage.sync.get('jr:cfg', (o) => res((o && o['jr:cfg']) || {}));
    });
    CFG = Object.assign({ autoIntervalSec: 15 }, r);
    /* 设置页里填的岗位名称 */
    KW_CFG = String(CFG.jobQuery || '').trim();
    /* 老配置迁移，和 content.js 保持一致：v1 默认 45 秒太慢 */
    if (!r.cfgVer) {
      if (+CFG.autoIntervalSec === 45) CFG.autoIntervalSec = 15;
      CFG.cfgVer = 2;
    }
  }
  /* 范围用「最近一次真的抓到岗位时搜的词」，它才和池子里的内容对得上；
   * 设置页里的词可能已经改了但还没重新搜，两者不一致时单独提示。 */
  if (hasExt) {
    const r2 = await new Promise((res) => {
      chrome.storage.local.get(['jr:lastQuery', 'jr:qmeta'], (o) => res(o || {}));
    });
    KW_LAST = String(r2['jr:lastQuery'] || '').trim();
    const raw = r2['jr:qmeta'] || {};
    QMETA = {};
    Object.keys(raw).forEach((k) => {
      const v = raw[k];
      QMETA[k] = { at: typeof v === 'number' ? v : +(v && v.at) || 0 };
    });
  }
  KW = KW_LAST || KW_CFG;
  KW_SRC = KW_LAST ? 'last' : 'cfg';
  renderPace();   // 选哪个词要等岗位读回来才知道，见 syncFromStore()
}

/* 某个搜索词在池子里有多少条岗位（标题/标签真的对得上才算） */
function countOf(q) {
  if (!q) return 0;
  const inQ = JOBS.filter((j) => inScope(j, q));
  const rel = inQ.filter((j) => relevance(j, q));
  return rel.length || inQ.length;
}

/* 池子里出现过的所有搜索词，最近抓到的排前面 */
function knownQueries() {
  const seen = {};
  JOBS.forEach((j) => {
    (j.qs || []).forEach((q) => { if (q) seen[q] = true; });
  });
  [KW_LAST, KW_CFG, SEL_MANUAL].forEach((q) => { if (q) seen[q] = true; });
  return Object.keys(seen)
    .map((q) => ({ q, n: countOf(q), at: (QMETA[q] && QMETA[q].at) || 0 }))
    .sort((a, b) => (b.at - a.at) || (b.n - a.n));
}

/* 决定默认看哪个词。
 * 优先级：用户手点过的 > 最近真的抓到过岗位的那个词 > lastQuery > 设置里的词。
 * 用「最近抓到的」而不是「设置里的」，是因为用户常常直接在 BOSS 搜索框改词，
 * 设置页那边还留着旧值 —— 这时候该跟着实际搜的词走。 */
function pickDefaultQuery() {
  if (SCOPE === 'all') return;
  if (SEL_MANUAL && countOf(SEL_MANUAL) > 0) { SEL_Q = SEL_MANUAL; return; }

  const withAt = knownQueries().filter((x) => x.at > 0 && x.n > 0);
  if (withAt.length) { SEL_Q = withAt[0].q; return; }

  if (countOf(KW_LAST) > 0) { SEL_Q = KW_LAST; return; }
  if (countOf(KW_CFG) > 0) { SEL_Q = KW_CFG; return; }
  SEL_Q = KW_CFG || KW_LAST || (knownQueries()[0] || {}).q || '';
}

function renderPace() {
  const box = $('paceBox');
  if (!box) return;
  const g = Math.max(5, +CFG.autoIntervalSec || 15);
  $('gapVal').textContent = g;

  const n = RESULTS.filter((j) => j.url).length;
  if (!n) {
    $('paceEst').textContent = '';
    box.style.display = 'none';
    return;
  }
  const sec = n * (g + PER_JOB_SEC);
  const human = sec < 90 ? Math.round(sec) + ' 秒' : Math.round(sec / 60) + ' 分钟';
  $('paceEst').innerHTML = '预计 <b>' + human + '</b> 投完 ' + n + ' 个' +
    (g <= 8 ? ' <span style="color:var(--bad)">· 偏快，容易被限流</span>' : '');
  box.style.display = 'flex';
}

function saveGap(v) {
  CFG.autoIntervalSec = v;
  CFG.cfgVer = CFG.cfgVer || 2;
  if (hasExt && chrome.storage && chrome.storage.sync) {
    try { chrome.storage.sync.set({ 'jr:cfg': CFG }); } catch (e) {}
  }
  renderPace();
}

function stepGap(dir) {
  const cur = Math.max(5, +CFG.autoIntervalSec || 15);
  let i = GAP_STEPS.indexOf(cur);
  if (i < 0) {
    i = GAP_STEPS.findIndex((s) => s >= cur);
    if (i < 0) i = GAP_STEPS.length - 1;
  } else {
    i = Math.min(GAP_STEPS.length - 1, Math.max(0, i + dir));
  }
  saveGap(GAP_STEPS[i]);
}

/* ============ 同步 / 投递 ============ */
const BG = {
  send(msg) {
    return new Promise((resolve) => {
      if (!(hasExt && chrome.runtime && chrome.runtime.sendMessage)) return resolve({ ok: false });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(resp || { ok: false });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }
};

/* 计划里必须带 url：面板拿到 url 才能把岗位直接补进投递池，
 * 不再要求用户回搜索页把同一批岗位重新抓一遍 */
function buildPlan() {
  const greets = {};
  RESULTS.forEach((j) => { greets[j.id] = j.greeting; });
  return {
    at: Date.now(),
    n: RESULTS.length,
    /* 话术模板版本：面板据此判断这份计划是不是用旧话术生成的 */
    mv: (M && M.versions) || '',
    sample: usingSample,
    items: RESULTS.map((j) => ({
      id: j.id, title: j.title, company: j.company,
      salary: j.salary || '', match: j.match, greeting: j.greeting,
      url: j.url || '', area: j.area || '', exp: j.exp || '', degree: j.degree || ''
    })),
    greets
  };
}

async function savePlan(plan) {
  await store.set({ 'jr:plan': plan, 'jr:greets': plan.greets });
  await store.set({
    'jr:profile': {
      at: Date.now(), skills: PROFILE.skills, years: PROFILE.years,
      titles: PROFILE.titles, city: PROFILE.city
    }
  });
}

async function makePlan() {
  if (!RESULTS.length) return;
  const plan = buildPlan();
  await savePlan(plan);
  if (usingSample) {
    toast('已写入，但当前是示例岗位（没有链接），面板里投不出去，只能看效果', true);
    return;
  }
  toast('已同步 ' + RESULTS.length + ' 个岗位 + 一对一话术，回面板点「自动投递」即可');
}

/* 一步到位：写计划 → 打开/复用 BOSS 页面 → 面板自动开跑 */
let lastStartAt = 0;
async function startApply() {
  if (!RESULTS.length) return;
  if (!hasExt) {
    toast('这是独立预览页，投递要在扩展里用：装好扩展后从面板进「简历匹配」', true);
    return;
  }
  if (Date.now() - lastStartAt < 6000) {
    toast('刚提交过，等 BOSS 页面加载完就会开始投递');
    return;
  }
  const ready = RESULTS.filter((j) => j.url);
  if (!ready.length) {
    toast(usingSample
      ? '示例岗位没有真实链接，投不了。先在 BOSS 搜索页让面板抓到岗位，再回来解析'
      : '这批岗位没拿到详情页链接（DOM 兜底抓的），回搜索页刷一次重抓后再试', true);
    return;
  }

  lastStartAt = Date.now();
  const btn = $('btnApply');
  btn.disabled = true;
  btn.textContent = '正在启动…';

  const plan = buildPlan();
  await savePlan(plan);
  await store.set({ 'jr:autoStart': { at: Date.now(), n: ready.length } });

  /* 打开的搜索页要和岗位池用同一个词，否则面板那边的「当前搜索词」对不上 */
  const kw = KW || (M.suggestQueries(PROFILE, 1) || [])[0] || '';
  const resp = await BG.send({ type: 'jr:startFromResume', query: kw });

  btn.disabled = false;
  updateApplyBtn();

  if (resp && resp.ok) {
    toast('已开始投递 ' + ready.length + ' 个岗位 · 切到 BOSS 页面看进度（每个岗位一对一话术）');
  } else {
    toast('启动投递失败：' + ((resp && resp.error) || '未知原因') + '。也可回面板手动点「自动投递」', true);
  }
}

function updateApplyBtn() {
  const btn = $('btnApply');
  if (!btn) return;
  const n = RESULTS.filter((j) => j.url).length;
  btn.textContent = n ? '立即投递 ' + n + ' 个' : '没有可投的岗位';
  btn.disabled = !n || !hasExt;
}

/* ============ 最近投递（让用户回这个页面就能看到结果） ============ */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

async function renderRunInfo() {
  const box = $('runBox');
  if (!box) return;
  const r = await store.get(['jr:log']);
  const log = Array.isArray(r['jr:log']) ? r['jr:log'] : [];
  if (!log.length) { box.style.display = 'none'; return; }

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todays = log.filter((x) => x && x.ts >= start.getTime());
  const okN = todays.filter((x) => x.ok).length;
  const badN = todays.length - okN;

  box.style.display = 'block';
  box.innerHTML =
    '<div style="margin-bottom:6px;color:var(--dim2)">最近投递（今天）' +
    '　成功 <b style="color:var(--ok)">' + okN + '</b>　失败 <b style="color:var(--bad)">' + badN + '</b></div>' +
    log.slice(0, 4).map((x) =>
      '<div style="color:var(--dim2);margin-top:3px">' + fmtTime(x.ts) + ' · ' + esc(x.title || '') +
      ' <span style="color:' + (x.ok ? 'var(--ok)' : 'var(--bad)') + '">' +
      esc(x.reason || (x.ok ? '已投' : '失败')) + '</span></div>'
    ).join('');
}

/* ============ 事件 ============ */
$('btnParse').addEventListener('click', async () => {
  await syncFromStore();          // 先把 BOSS 那边新抓的岗位/新搜索词读进来
  parseNow();
  if (PROFILE) {
    toast('识别到 ' + PROFILE.skills.length + ' 项技能、' + PROFILE.bullets.length + ' 条可用原句' +
      (SEL_Q ? '，按「' + SEL_Q + '」匹配' : ''));
  }
});

$('btnSample').addEventListener('click', () => {
  $('raw').value = SAMPLE_RESUME;
  parseNow();
  toast('已填入示例简历');
});

$('btnClear').addEventListener('click', () => {
  $('raw').value = '';
  PROFILE = null;
  RESULTS = [];
  $('profileBox').style.display = 'none';
  $('actions').style.display = 'none';
  $('paceBox').style.display = 'none';
  $('matches').innerHTML = '<div class="empty">先把简历解析出来</div>';
});

$('topN').addEventListener('change', renderMatches);

$('raw').addEventListener('input', () => {
  clearTimeout(window._deb);
  window._deb = setTimeout(parseNow, 400);
});

document.addEventListener('click', (e) => {
  /* 岗位详情页：用标签页打开，扩展页里 window.open 容易被拦；
   * 注意不要带 jr=1，否则同一页面会被当成交付流程去点「立即沟通」 */
  const dl = e.target.closest('[data-detail]');
  if (dl) {
    const url = dl.getAttribute('href');
    if (url) {
      e.preventDefault();
      if (hasExt && chrome.tabs) chrome.tabs.create({ url });
      else window.open(url, '_blank');
    }
    return;
  }

  /* 发送间隔的加减 */
  const gb = e.target.closest('[data-gap]');
  if (gb) {
    stepGap(+gb.getAttribute('data-gap'));
    return;
  }

  /* 岗位范围切换：当前搜索词 / 全部已抓 */
  const sc = e.target.closest('[data-scope]');
  if (sc) {
    const v = sc.getAttribute('data-scope');
    if (v === 'all') {
      SCOPE = 'all';
    } else if (v === 'q') {
      /* 换一个搜索词看：记成「用户手选的」，以后自动同步不会把它改回去 */
      SEL_Q = sc.getAttribute('data-q') || SEL_Q;
      SEL_MANUAL = SEL_Q;
      SCOPE = 'kw';
    } else {
      SCOPE = v === 'kwloose' ? 'kwloose' : 'kw';
      if (SCOPE === 'kw') SEL_MANUAL = SEL_Q;
    }
    renderMatches();
    return;
  }

  const q = e.target.closest('[data-q]');
  if (!q) return;
  const kw = q.getAttribute('data-q');
  const city = PROFILE && PROFILE.city ? PROFILE.city : '';
  const url = 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(kw);
  if (hasExt && chrome.tabs) chrome.tabs.create({ url });
  else window.open(url, '_blank');
  toast('已打开「' + kw + '」搜索结果' + (city ? '（城市沿用面板里设的 ' + city + '）' : ''));
});

/* 文件选择 / 拖拽 */
$('drop').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) readFile(f);
});
['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('drop').classList.remove('over');
}));
$('drop').addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) readFile(f);
});

async function readFile(file) {
  try {
    $('drop').querySelector('b').textContent = '正在解析 ' + file.name + ' …';
    const text = await IO.readResumeFile(file);
    if (!text || text.length < 30) throw new Error('这个文件里几乎没读到文字（可能是扫描件）');
    $('raw').value = text;
    parseNow();
    toast('已读取 ' + file.name + '（' + text.length + ' 字）');
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    $('drop').querySelector('b').textContent = '点击选择 .docx / .txt / .md';
  }
}

/* 话术编辑 */
$('matches').addEventListener('input', (e) => {
  const ta = e.target.closest('textarea[data-g]');
  if (!ta) return;
  const i = +ta.getAttribute('data-g');
  if (!RESULTS[i]) return;
  RESULTS[i].greeting = ta.value;
  if (RESULTS[i].id) EDITS[RESULTS[i].id] = ta.value;
  const lab = document.querySelector('.len[data-len="' + i + '"]');
  if (lab) {
    lab.textContent = ta.value.length + ' 字';
    lab.classList.toggle('bad', ta.value.length > 180);
  }
});

$('btnPlan').addEventListener('click', makePlan);
$('btnApply').addEventListener('click', startApply);

$('btnCopy').addEventListener('click', async () => {
  const txt = RESULTS.map((j) => '【' + j.title + ' · ' + j.company + '】\n' + j.greeting).join('\n\n');
  try {
    await navigator.clipboard.writeText(txt);
    toast('已复制 ' + RESULTS.length + ' 条话术');
  } catch (e) { toast('复制失败，请手动选中', true); }
});

$('btnJson').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ profile: PROFILE, items: RESULTS }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jobradar-plan.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ============ 启动 ============ */
(async function init() {
  $('envPill').innerHTML = hasExt
    ? '扩展环境 · 数据只在 <b>本机</b>'
    : '独立预览模式 · 用示例岗位演示';

  await syncFromStore();

  /* 回填上一次的简历，省得每次重贴 */
  const r = await store.get(['jr:resumeRaw']);
  if (r['jr:resumeRaw'] && r['jr:resumeRaw'].length > 30) {
    $('raw').value = r['jr:resumeRaw'];
    parseNow();
  } else if (!hasExt) {
    $('raw').value = SAMPLE_RESUME;
    parseNow();
  }

  setInterval(() => {
    const v = $('raw').value;
    if (v && v.length > 30 && v !== window._lastSaved) {
      window._lastSaved = v;
      store.set({ 'jr:resumeRaw': v });
    }
  }, 2500);

  /* 从 BOSS 那边切回来时自动刷一次：不用再靠「记得点一下解析」 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync();
  });
  window.addEventListener('focus', scheduleSync);

  renderRunInfo();
  setInterval(renderRunInfo, 4000);   // 投递在别的标签页跑，这里轮询刷新结果
})();
