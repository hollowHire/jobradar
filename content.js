/*
 * content.js —— 岗位雷达主逻辑（三种运行模式）
 *
 *  MODE = list   搜索列表页：抓数据 → 打分 → 面板 → 驱动投递队列
 *  MODE = detail 岗位详情页：自动点「立即沟通」
 *  MODE = chat   聊天页：自动填入并发送自定义打招呼语
 *
 * 所有岗位数据、评分、筛选项只在本地 chrome.storage，无任何自有服务器。
 */
(function () {
  'use strict';
  if (window.__JOBRADAR_CONTENT__) return;
  window.__JOBRADAR_CONTENT__ = true;

  /* ================= 配置 ================= */
  var DEFAULT_CFG = {
    salaryFloor: 15,
    targetMin: 22,
    targetMax: 32,
    city: '杭州',
    district: '西湖区',
    excludeDistricts: '',
    homeAddress: '',
    amapKey: '',
    maxCommuteKm: 8,
    includeKeywords: 'AI,大模型,Agent,前端,Node,数据',
    excludeKeywords: '外包,驻场,人力派遣,销售,电话,大小周,单休,996,夜班',
    mustWelfare: '双休,五险一金',
    preferStages: 'B轮,C轮,D轮及以上,已上市,不需要融资',
    blockScales: '',
    jobQuery: '前端',
    greeting: '',
    batchSize: 15,
    autoIntervalSec: 15,
    dailyCap: 40,
    hideBlocked: false
  };

  var SK = {
    cfg: 'jr:cfg', jobs: 'jr:jobs', stats: 'jr:stats', home: 'jr:home',
    applied: 'jr:applied', log: 'jr:log', picked: 'jr:picked',
    greets: 'jr:greets', plan: 'jr:plan', autoStart: 'jr:autoStart',
    /* 最近一次真正抓到岗位时页面在搜什么 —— 简历页靠它决定「当前搜索词」 */
    lastQuery: 'jr:lastQuery',
    /* 每个搜索词最近一次抓到岗位的时间戳。
     * 为什么不能只用 lastQuery：同时开着两个 BOSS 标签页时，老标签页里的一次滚动
     * 就会把 lastQuery 改写回去，简历页于是又跳回上一个词。按词记时间才不会被抢。 */
    qmeta: 'jr:qmeta'
  };

  var CFG = Object.assign({}, DEFAULT_CFG);
  var VERSION = '0.8.6';
  /* 话术模板版本：和 matcher.js 的 versions 对齐。
   * 单独一个常量，扩展自身版本号变了不会误报「旧话术」。 */
  var GREET_TPL = '0.8.0';
  var JOBS = new Map();
  var APPLIED = {};
  /* 简历匹配计划同步过来的东西 */
  var GREETS = {};          // { jobId: 打招呼语 }
  var MATCH = {};           // { jobId: 匹配分 }
  var PLAN = null;          // 最近一次同步的计划
  /* PICKED: 用户手动勾选的结果 { jobId: 1|0 }
   * 1 = 用户亲手勾上，0 = 用户亲手取消，没有记录 = 看「默认勾选」（见 autoPickSet）。
   * 勾上就等于「会投这个岗位」—— 不存在「勾了但不投」这种状态。 */
  var PICKED = {};
  /* 默认勾选的集合会随分数/已投/每批数量变化，用一个版本号让缓存失效 */
  var POOL_REV = 0;
  var stats = { date: todayStr(), opened: 0, lastOpenAt: 0 };
  var homeGeo = null;

  var host = null, root = null, listEl = null, collapsed = true, renderTimer = null;

  /* ================= 工具 ================= */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function splitList(s) {
    return String(s || '').split(/[,，、\s]+/).filter(Boolean);
  }
  function param(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadConfig() {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(SK.cfg, function (o) {
        if (o[SK.cfg]) {
          CFG = Object.assign({}, DEFAULT_CFG, o[SK.cfg]);
          /* 老配置迁移：v1 的默认间隔是 45 秒，用户普遍觉得太慢。
           * 只在没迁过且值仍是旧默认 45 时才降到 15，用户自己设过的其他值不动。 */
          if (!o[SK.cfg].cfgVer) {
            if (+CFG.autoIntervalSec === 45) CFG.autoIntervalSec = 15;
            CFG.cfgVer = 2;
            chrome.storage.sync.set({ [SK.cfg]: CFG }, function () {});
          }
        }
        chrome.storage.local.get([SK.stats, SK.home, SK.applied, SK.picked, SK.greets, SK.jobs, SK.plan], function (r) {
          if (r[SK.stats]) stats = r[SK.stats];
          if (stats.date !== todayStr()) stats = { date: todayStr(), opened: 0, lastOpenAt: 0 };
          homeGeo = r[SK.home] || null;
          APPLIED = r[SK.applied] || {};
          PICKED = r[SK.picked] || {};
          GREETS = r[SK.greets] || {};
          if (r[SK.plan] && Array.isArray(r[SK.plan].items)) {
            PLAN = r[SK.plan];
            PLAN.items.forEach(function (it) { MATCH[it.id] = it.match; });
          }
          /* 把上次抓过的岗位读回来：跨关键词搜索、刷新页面都不会丢，
           * 这样「简历匹配」的候选池才能越搜越大 */
          if (Array.isArray(r[SK.jobs])) {
            var healed = 0;
            r[SK.jobs].forEach(function (j) {
              if (!j || !j.id || JOBS.has(j.id)) return;
              /* 旧版本存的岗位可能没有 url（早期把 lid/securityId 当成必需）。
               * 这里按 id 补一条详情页链接，别让老数据永远投不出去。 */
              if (!j.url) {
                var fixed = detailUrl(j.id);
                if (fixed) { j.url = fixed; healed++; }
              }
              try {
                scoreJob(j);
                JOBS.set(j.id, j);
              } catch (e) { /* 旧版本数据字段不全，跳过 */ }
            });
            if (healed) { diag.healed = healed; persist(); }
          }
          resolve();
        });
      });
    });
  }
  function saveStats() { chrome.storage.local.set({ [SK.stats]: stats }); }

  /* ================= 薪资解析 ================= */
  function parseSalary(desc) {
    if (!desc) return null;
    var t = String(desc).replace(/\s/g, '');
    var m, months;
    m = t.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)K/i);
    if (m) {
      months = (t.match(/[·*](\d+)薪/) || [])[1];
      return { min: +m[1], max: +m[2], months: months ? +months : 12, raw: desc };
    }
    m = t.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元\/天/);
    if (m) return { min: +m[1] * 21.75 / 1000, max: +m[2] * 21.75 / 1000, months: 12, raw: desc };
    m = t.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元\/时/);
    if (m) return { min: +m[1] * 8 * 21.75 / 1000, max: +m[2] * 8 * 21.75 / 1000, months: 12, raw: desc };
    m = t.match(/(\d+(?:\.\d+)?)K以上/);
    if (m) return { min: +m[1], max: +m[1] * 1.3, months: 12, raw: desc };
    return null;
  }

  /* 薪资文本清洗
   * 只认 "15-16K" / "15-16K·13薪" / "200-300元/天" / "20K以上" 这几种结构。
   * 抓错的（把别名、标签、别的文本当薪资）一律返回空 —— 宁可显示「面议」，
   * 也不能显示一个错数，因为它会直接污染评分。
   */
  function cleanSalary(raw) {
    if (!raw) return '';
    var s = String(raw).replace(/\s/g, '');
    var m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(K|k|千)/);
    if (m) {
      var base = m[1] + '-' + m[2] + 'K';
      var mm = s.match(/[·*](\d+)薪/);
      return mm ? base + '·' + mm[1] + '薪' : base;
    }
    m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元\/天/);
    if (m) return m[1] + '-' + m[2] + '元/天';
    m = s.match(/(\d+(?:\.\d+)?)(K|k)以上/);
    if (m) return m[1] + 'K以上';
    return '';
  }

  /* ================= 归一化 ================= */

  /* 详情页链接：只要有 encryptJobId 就能拼出来。
   * 早期版本把 lid / securityId 当成必需，接口一旦没回（它们只是来源追踪参数），
   * url 就整个变空 → 面板里所有岗位都变成「无详情页链接」，一个都投不出去。
   * 现在：优先用卡片上真实的 href，其次用 id 拼，lid/securityId 有就带上。 */
  function detailUrl(jid, raw, href) {
    if (href && /\/job_detail\//.test(href)) {
      return href.indexOf('http') === 0 ? href : 'https://www.zhipin.com' + href;
    }
    if (!jid) return '';
    if (jid.indexOf('|') >= 0) return '';   // 「品牌|岗位名」拼出来的假 id 不是真链接
    var qs = [];
    var lid = (raw && raw.lid) || (href && (href.match(/[?&]lid=([^&]+)/) || [])[1]) || '';
    var sid = (raw && raw.securityId) || (href && (href.match(/[?&]securityId=([^&]+)/) || [])[1]) || '';
    if (lid) qs.push('lid=' + encodeURIComponent(lid));
    if (sid) qs.push('securityId=' + encodeURIComponent(sid));
    return 'https://www.zhipin.com/job_detail/' + jid + '.html' + (qs.length ? '?' + qs.join('&') : '');
  }

  /* ================= 搜索词归属 =================
   * 岗位池是跨关键词累积的（搜「测试」再搜「FDE」，池里两批都在）。
   * 所以要给每条岗位记下「它是被哪个搜索词抓到的」，否则改完关键词
   * 看到的还是上一批岗位 —— 用户会以为设置没生效。
   * 以页面 URL 的 query 为准，而不是设置里的值：用户可能改了设置但没重新搜。
   */
  function currentQuery() {
    return pageQuery() || (CFG.jobQuery || '').trim();
  }

  /* 页面 URL 上的 query —— 只有真正的搜索结果页才有。
   * 绝对不能拿设置里的 CFG.jobQuery 顶替：详情页、聊天页也会跑本脚本，
   * 那些页面上抓到的岗位（详情页右侧的「相似职位」、聊天页的推荐位）
   * 会被打上设置里的搜索词，于是全部算进当前范围，页面上就冒出一堆无关岗位。 */
  function pageQuery() {
    try {
      if (!/^\/web\/geek\/job(\/|$)/.test(location.pathname)) return '';
      var m = /[?&]query=([^&]*)/.exec(location.search);
      if (!m || !m[1]) return '';
      return decodeURIComponent(m[1].replace(/\+/g, '%20')).trim();
    } catch (e) { return ''; }
  }

  /* 记下「这个词最近一次抓到岗位是什么时候」。
   * 简历页据此判断该默认显示哪个词 —— 用时间而不是「最后一次写入」，
   * 是因为同时开两个 BOSS 标签页时，老标签页的懒加载会把 lastQuery 改写回去。 */
  function touchQuery(q) {
    var now = Date.now();
    if (q === qmetaLastQ && now - qmetaLastAt < 20000) return;   // 同一次滚动不必反复写盘
    qmetaLastQ = q;
    qmetaLastAt = now;
    try {
      chrome.storage.local.get(SK.qmeta, function (o) {
        var m = (o && o[SK.qmeta]) || {};
        // 老数据里可能存的是数字，统一成 { at: ts }
        Object.keys(m).forEach(function (k) {
          if (typeof m[k] === 'number') m[k] = { at: m[k] };
        });
        m[q] = { at: now };
        // 只留最近 8 个词，免得越攒越大
        var keys = Object.keys(m).sort(function (a, b) { return (m[b].at || 0) - (m[a].at || 0); });
        keys.slice(8).forEach(function (k) { delete m[k]; });
        var payload = {};
        payload[SK.qmeta] = m;
        try { chrome.storage.local.set(payload); } catch (e) {}
      });
    } catch (e) { /* ignore */ }
  }

  function uniqQs(arr) {
    var out = [];
    (arr || []).forEach(function (q) {
      q = (q || '').trim();
      if (q && out.indexOf(q) < 0) out.push(q);
    });
    return out;
  }

  /* 标题里是否含搜索词（BOSS 本身是分词匹配，这里也按词拆） */
  function kwHit(text, q) {
    var t = (text || '').toLowerCase();
    var tokens = (q || '').toLowerCase().split(/[\s,，、/|·]+/).filter(Boolean);
    if (!tokens.length) return true;
    for (var i = 0; i < tokens.length; i++) {
      if (t.indexOf(tokens[i]) >= 0) return true;
    }
    return false;
  }

  /* 标题/标签里到底有没有搜索词（含 FDE ↔ 前线部署 这类别名）。
   * 逻辑放在 matcher.js 里共用，这里只做一层兜底。 */
  function relevance(j, q) {
    if (!q) return true;
    try {
      if (window.JRMatcher && window.JRMatcher.relevant) return window.JRMatcher.relevant(j, q);
    } catch (e) { /* 兜底走下面 */ }
    return kwHit((j.title || '') + ' ' + (j.labels || []).join(' '), q);
  }

  /* 这条岗位算不算当前搜索词范围：
   * ① 抓取时记录过这个词 → 算（最准）
   * ② 没记录过（老数据 / 详情页、聊天页抓到的）→ 退回标题标签比对，对不上就不算
   * 简历计划注入的岗位永远算，那是用户自己选的。 */
  function inScope(j, q) {
    if (!q) return true;
    if (j.fromResume) return true;
    var qs = j.qs || [];
    if (qs.length && qs.indexOf(q) >= 0) return true;
    return relevance(j, q);
  }


  function normalize(j, qIn) {
    var salStr = cleanSalary(j.salaryDesc);
    var sal = parseSalary(salStr);
    var area = [j.areaDistrict, j.businessDistrict].filter(Boolean).join('·');
    var labels = [].concat(j.jobLabels || [], j.skills || [], j.welfareList || []);
    var jid = j.encryptJobId || j.encryptJobIdStr || j.jobId || '';
    /* 搜索词优先级：接口自己报的 query（最准，就是服务端被问的那个词）
     * → 页面 URL 上的 query → 空（详情页/聊天页抓到的，不属于任何搜索） */
    var q = (typeof qIn === 'string' ? qIn
      : (typeof j.__query === 'string' ? j.__query : pageQuery())).trim();
    return {
      id: jid || j.lid || (j.brandName + '|' + j.jobName),
      title: j.jobName || '',
      company: j.brandName || '',
      salary: salStr,
      sal: sal,
      area: area,
      district: j.areaDistrict || '',
      business: j.businessDistrict || '',
      exp: j.jobExperience || '',
      degree: j.jobDegree || '',
      labels: labels.filter(Boolean),
      welfare: (j.welfareList || []).slice(),
      scale: j.brandScaleName || '',
      stage: j.brandStageName || '',
      industry: j.brandIndustry || j.industry || '',
      active: j.bossActiveTimeDesc || '',
      online: !!j.bossOnline,
      url: detailUrl(jid, j, j.__href || ''),
      /* 这条岗位是被哪个搜索词抓到的（可能多个），切关键词时用得上 */
      qs: q ? [q] : [],
      distKm: null,
      _geoDone: false,
      score: 0,
      blocked: false,
      blockReason: '',
      reasons: []
    };
  }

  /* ================= 打分引擎 ================= */
  function scoreJob(job) {
    var score = 50, reasons = [], blocked = false, blockReason = '';
    var cfg = CFG;

    /* 1. 薪资 */
    if (job.sal) {
      var midMonthly = (job.sal.min + job.sal.max) / 2;
      var annual = midMonthly * job.sal.months;
      var targetAnnual = (cfg.targetMin + cfg.targetMax) / 2 * 12;
      var ratio = annual / targetAnnual;

      if (job.sal.max < cfg.salaryFloor) {
        blocked = true;
        blockReason = '薪资上限 ' + job.sal.max.toFixed(0) + 'K 低于底线';
      } else {
        var d = clamp((ratio - 1) * 45, -26, 26);
        if (Math.abs(d) >= 3) {
          score += d;
          reasons.push({
            t: d > 0 ? '薪资高于期望 ' + Math.round((ratio - 1) * 100) + '%'
                     : '薪资低于期望 ' + Math.round((1 - ratio) * 100) + '%',
            d: Math.round(d)
          });
        } else {
          score += 4;
          reasons.push({ t: '薪资贴合期望', d: 4 });
        }
      }
      if (job.sal.months >= 14) { score += 5; reasons.push({ t: job.sal.months + ' 薪', d: 5 }); }
    } else {
      score -= 4; reasons.push({ t: '薪资面议', d: -4 });
    }

    /* 2. 通勤 */
    var exDistricts = splitList(cfg.excludeDistricts);
    if (exDistricts.some(function (x) { return x && job.area.indexOf(x) >= 0; })) {
      blocked = true;
      blockReason = '区域在排除名单（' + job.area + '）';
    } else if (cfg.district && job.area.indexOf(cfg.district) >= 0) {
      score += 9; reasons.push({ t: '通勤命中 ' + cfg.district, d: 9 });
    } else if (cfg.district && job.district && job.district !== cfg.district) {
      score -= 5; reasons.push({ t: '跨区 ' + job.district, d: -5 });
    }

    if (job.distKm != null) {
      if (job.distKm <= cfg.maxCommuteKm) {
        var bonus = Math.round(10 * (1 - job.distKm / Math.max(cfg.maxCommuteKm, 1)));
        score += bonus; reasons.push({ t: '直线 ' + job.distKm.toFixed(1) + 'km', d: bonus });
      } else if (job.distKm > cfg.maxCommuteKm * 1.6) {
        blocked = true;
        blockReason = '通勤 ' + job.distKm.toFixed(1) + 'km 超出范围';
      } else {
        score -= 10; reasons.push({ t: '通勤偏远 ' + job.distKm.toFixed(1) + 'km', d: -10 });
      }
    }

    /* 3. 关键词 */
    var text = (job.title + ' ' + job.labels.join(' ') + ' ' + job.welfare.join(' ') + ' ' +
      job.industry).toLowerCase();

    var hitInc = splitList(cfg.includeKeywords).filter(function (k) {
      return k && text.indexOf(k.toLowerCase()) >= 0;
    });
    if (hitInc.length) {
      var ib = Math.min(18, hitInc.length * 6);
      score += ib; reasons.push({ t: '命中 ' + hitInc.slice(0, 3).join('/'), d: ib });
    }

    var hitExc = splitList(cfg.excludeKeywords).filter(function (k) {
      return k && text.indexOf(k.toLowerCase()) >= 0;
    });
    if (hitExc.length) {
      var eb = -Math.min(34, hitExc.length * 13);
      score += eb; reasons.push({ t: '踩雷 ' + hitExc.slice(0, 3).join('/'), d: eb });
    }

    /* 4. 双休 / 福利 */
    var wf = job.welfare.join(' ') + ' ' + job.labels.join(' ');
    if (/双休/.test(wf)) { score += 10; reasons.push({ t: '双休', d: 10 }); }
    else if (/大小周|单休|排班/.test(wf)) { score -= 14; reasons.push({ t: '非双休', d: -14 }); }
    if (/不加班|弹性/.test(wf)) { score += 5; reasons.push({ t: '弹性/不加班', d: 5 }); }

    splitList(cfg.mustWelfare).forEach(function (w) {
      if (w && w !== '双休' && wf.indexOf(w) >= 0) { score += 4; reasons.push({ t: '有' + w, d: 4 }); }
    });

    /* 5. HR 活跃度 */
    if (job.online) { score += 6; reasons.push({ t: 'HR 在线', d: 6 }); }
    else if (/今日|刚刚/.test(job.active)) { score += 5; reasons.push({ t: 'HR 今日活跃', d: 5 }); }
    else if (/本周|3日/.test(job.active)) { score += 2; reasons.push({ t: 'HR 近期活跃', d: 2 }); }
    else if (/月|周前/.test(job.active)) { score -= 4; reasons.push({ t: 'HR 久未活跃', d: -4 }); }

    /* 6. 公司阶段 */
    if (cfg.preferStages && job.stage && cfg.preferStages.indexOf(job.stage) >= 0) {
      score += 6; reasons.push({ t: job.stage, d: 6 });
    }
    splitList(cfg.blockScales).forEach(function (s) {
      if (s && job.scale === s) { blocked = true; blockReason = '公司规模 ' + s + ' 已排除'; }
    });

    /* 7. 经验粗筛 */
    if (/应届|在校/.test(job.exp)) { score -= 6; reasons.push({ t: '要求 ' + job.exp, d: -6 }); }

    score = Math.round(clamp(score, 0, 100));
    job.score = score;
    job.blocked = blocked;
    job.blockReason = blockReason;
    job.reasons = reasons.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
    POOL_REV++;                     // 分数变了，「默认勾选」的排序要重算
    return job;
  }

  function rescoreAll() {
    JOBS.forEach(function (j) {
      /* 简历计划注入的岗位没有薪资/福利/通勤字段，用面板这套规则重算会直接打到低分。
       * 它们本来就是「简历匹配」选出来的，沿用匹配分即可。 */
      if (j.fromResume && MATCH[j.id] != null) {
        j.score = Math.round(MATCH[j.id]);
        j.blocked = false;
        j.blockReason = '';
        j.reasons = [{ d: j.score, t: '简历匹配' }];
        return;
      }
      scoreJob(j);
    });
    scheduleRender();
  }

  /* ================= 通勤距离（高德，可选） ================= */
  function amapGeocode(addr) {
    if (!CFG.amapKey || !addr) return Promise.resolve(null);
    var url = 'https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(addr) +
      '&city=' + encodeURIComponent(CFG.city) + '&key=' + CFG.amapKey;
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      return (j.status === '1' && j.geocodes && j.geocodes[0]) ? j.geocodes[0].location : null;
    }).catch(function () { return null; });
  }
  function amapDistance(from, to) {
    var url = 'https://restapi.amap.com/v3/distance?origins=' + from + '&destination=' + to +
      '&type=1&key=' + CFG.amapKey;
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      return (j.status === '1' && j.results && j.results[0]) ? (+j.results[0].distance) / 1000 : null;
    }).catch(function () { return null; });
  }
  function ensureHome() {
    if (homeGeo) return Promise.resolve(homeGeo);
    if (!CFG.amapKey || !CFG.homeAddress) return Promise.resolve(null);
    return amapGeocode(CFG.homeAddress).then(function (loc) {
      if (loc) { homeGeo = loc; chrome.storage.local.set({ [SK.home]: loc }); }
      return loc;
    });
  }
  function enrichDistance(job) {
    if (job._geoDone || !CFG.amapKey || !job.area) return;
    job._geoDone = true;
    ensureHome().then(function (home) {
      if (!home) return;
      return amapGeocode(CFG.city + job.district + job.business).then(function (loc) {
        if (!loc) return;
        return amapDistance(home, loc).then(function (km) {
          if (km != null) { job.distKm = km; scoreJob(job); scheduleRender(); }
        });
      });
    }).catch(function () {});
  }

  /* ================= 数据接收 ================= */
  function ingest(payload) {
    if (!payload || !Array.isArray(payload.jobs)) return;
    /* 这批岗位是在哪个搜索词下抓到的：
     * ① 列表接口的响应里带 query —— 那就是服务端被问的词，最可信
     * ② 退一步用页面 URL 上的 query
     * ③ 都没有（详情页/聊天页抓的）→ 空，别拿设置里的词顶替，否则一堆无关岗位会算进来 */
    var qBatch = String(payload.query || '').trim() || pageQuery();
    if (qBatch) {
      if (qBatch !== lastQuerySaved) {
        lastQuerySaved = qBatch;
        try { chrome.storage.local.set({ [SK.lastQuery]: qBatch }); } catch (e) {}
      }
      touchQuery(qBatch);
    }
    if (!diag.sampleApi && payload.jobs[0]) {
      try { diag.sampleApi = payload.jobs[0]; } catch (e) {}
    }
    var added = 0;
    payload.jobs.forEach(function (raw) {
      var job = normalize(raw, qBatch);
      if (!job.id || !job.title) return;
      var exist = JOBS.get(job.id);
      if (exist) {
        var keepResume = exist.fromResume && MATCH[job.id] != null;
        var prevUrl = exist.url;
        var prevQs = exist.qs || [];
        Object.assign(exist, job, { distKm: exist.distKm, _geoDone: exist._geoDone });
        /* 同一个岗位可能被多个关键词搜到（比如「测试」和「测试开发」），
         * 搜索词要并起来，不能后一次覆盖前一次 */
        exist.qs = uniqQs(prevQs.concat(job.qs || []));
        /* 后一次抓取没带链接（比如接口字段缺失）时，不能把已有的链接抹掉 */
        if (!exist.url && prevUrl) exist.url = prevUrl;
        if (keepResume) {
          /* 计划注入的岗位再次被抓到时，别用面板规则覆盖简历匹配分 */
          exist.fromResume = true;
          exist.score = Math.round(MATCH[job.id]);
          exist.blocked = false;
          exist.blockReason = '';
          exist.reasons = [{ d: exist.score, t: '简历匹配' }];
        } else {
          scoreJob(exist);
        }
      } else {
        scoreJob(job);
        JOBS.set(job.id, job);
        enrichDistance(job);
        added++;
      }
    });
    if (added) {
      scheduleRender();
      persist();
      chrome.runtime.sendMessage({ type: 'badge', count: JOBS.size }, function () {});
    }
  }

  var persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      var mine = Array.from(JOBS.values());
      chrome.storage.local.get(SK.jobs, function (r) {
        var byId = {};
        var old = Array.isArray(r[SK.jobs]) ? r[SK.jobs] : [];
        old.forEach(function (j) { if (j && j.id) byId[j.id] = j; });
        mine.forEach(function (j) { if (j && j.id) byId[j.id] = j; });
        var out = Object.keys(byId).map(function (k) { return byId[k]; });
        chrome.storage.local.set({ [SK.jobs]: out.slice(-600) });
      });
    }, 800);
  }

  /* ================= 诊断计数 ================= */
  var diag = { net: 0, dom: 0, tries: 0, domCards: 0, healed: 0 };
  var lastQuerySaved = '';
  var qmetaLastQ = '';
  var qmetaLastAt = 0;

  /* ================= DOM 兜底抓取 =================
   * 接口监听在部分页面/改版后会失效，这里直接从卡片 DOM 解析。
   * 字段比接口少（没有融资阶段/规模），打分照常降级运行。
   */
  function textOf(el, sels) {
    for (var i = 0; i < sels.length; i++) {
      var n = el.querySelector(sels[i]);
      if (n && n.textContent && n.textContent.trim()) return n.textContent.trim();
    }
    return '';
  }

  function scrapeDom() {
    diag.tries++;
    var cards = document.querySelectorAll(
      'li.job-card-wrapper, div.job-card-wrapper, li.job-card-box, div.job-card-box'
    );
    if (!cards.length) return;

    var batch = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var a = c.querySelector('a[href*="/job_detail/"]');
      if (!a) continue;

      var href = a.getAttribute('href') || '';
      var m = href.match(/job_detail\/([^.?]+)\.html/);
      var id = m ? m[1] : '';
      if (!id) continue;

      var title = textOf(c, ['.job-name', '.job-title .name', '.job-card-left .name', '.name']);
      if (!title) continue;

      var areaRaw = textOf(c, ['.job-area', '.job-area-wrapper', '.company-location', '.job-card-left .job-area']);
      var parts = areaRaw.split(/[·\s]+/).filter(Boolean);
      var district = '';
      for (var p = 0; p < parts.length; p++) {
        if (/[区县]/.test(parts[p])) { district = parts[p]; break; }
      }
      if (!district) district = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || '');
      var business = parts.filter(function (x) { return x !== district; }).join('·');

      var tags = [];
      var tnodes = c.querySelectorAll('.tag-list li, .tag-item, .job-labels span, .job-card-footer .tag-item');
      for (var t = 0; t < tnodes.length && t < 12; t++) {
        var tx = (tnodes[t].textContent || '').trim();
        if (tx && tags.indexOf(tx) < 0) tags.push(tx);
      }

      batch.push({
        encryptJobId: id,
        jobName: title,
        /* 卡片上的原始链接最可靠（带 lid/securityId），直接交给 normalize 用 */
        __href: href,
        /* 记下这次是在哪个搜索词下抓到的（详情页的「相似职位」拿不到，留空） */
        __query: pageQuery(),
        salaryDesc: cleanSalary(textOf(c, ['.salary', '.job-salary', '.job-card-left .salary', '.job-info .salary'])),
        areaDistrict: district,
        businessDistrict: business,
        brandName: textOf(c, ['.company-name', '.company-info h3', '.company-info .name', '.company-name a']),
        welfareList: tags.slice(),
        jobLabels: tags.slice(),
        bossActiveTimeDesc: textOf(c, ['.info-public em', '.job-card-footer em', '.boss-active-time', '.info-public']),
        jobExperience: '',
        jobDegree: '',
        brandStageName: textOf(c, ['.company-tag-list li:first-child']),
        brandScaleName: '',
        brandIndustry: '',
        lid: (href.match(/[?&]lid=([^&]+)/) || [])[1] || '',
        securityId: (href.match(/[?&]securityId=([^&]+)/) || [])[1] || ''
      });
    }

    diag.domCards = batch.length;
    if (!diag.sampleDom && cards[0]) {
      try { diag.sampleDom = cards[0].outerHTML.slice(0, 1400); } catch (e) {}
    }
    if (batch.length) {
      diag.dom++;
      ingest({ jobs: batch });
    }
  }

  function startDomScraper() {
    var deb = null;
    var later = function () {
      clearTimeout(deb);
      deb = setTimeout(scrapeDom, 600);
    };
    try {
      var mo = new MutationObserver(later);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }

    scrapeDom();
    setTimeout(scrapeDom, 1200);
    setInterval(function () {
      if (JOBS.size === 0 && diag.tries < 80) scrapeDom();
    }, 2500);
  }


  /* ================= 岗位勾选 ================= */
  function pickable(j) { return !j.blocked && !APPLIED[j.id] && !!j.url; }

  /* 默认勾选要不要卡「标题里得有搜索词」：
   * 只在「范围内确实存在对得上词的岗位」时才生效。
   * 否则用户搜了个说法特殊的词（词表没覆盖），会变成一个都不勾，看着像坏了。 */
  var relGateCache = null;
  function relGate() {
    var q = currentQuery();
    var key = q + '|' + JOBS.size;
    if (relGateCache && relGateCache.key === key) return relGateCache.on;
    var on = false;
    if (q) {
      JOBS.forEach(function (j) { if (!on && inScope(j, q) && relevance(j, q)) on = true; });
    }
    relGateCache = { key: key, on: on };
    return on;
  }

  function isPicked(j) {
    if (!pickable(j)) return false;
    if (PICKED[j.id] === 0) return false;
    if (PICKED[j.id] === 1) return true;       // 手动勾的，无条件算
    return !!autoPickSet()[j.id];
  }

  /* 默认勾选 = 范围内、能投的岗位里，按分数从高到低取前 N 个（N = 「默认勾」那个档位）。
   * 以前是「全部默认选中，投递时才按每批截断」—— 于是「已选 34」和
   * 「自动投递 15 个」两个数字永远对不上，用户没法判断到底会投哪些。
   * 现在默认勾多少就投多少，数字只有一套。 */
  var autoCache = null;
  function autoPickSet() {
    var q = currentQuery();
    var key = q + '|' + JOBS.size + '|' + POOL_REV + '|' +
      Math.max(1, +CFG.batchSize || 15) + '|' + (relGate() ? 1 : 0);
    if (autoCache && autoCache.key === key) return autoCache.set;
    var gate = relGate();
    var cand = [];
    JOBS.forEach(function (j) {
      if (!pickable(j) || !inScope(j, q)) return;
      /* 标题里没有搜索词的（BOSS 推荐位）默认不勾，想投得自己动手 */
      if (gate && !relevance(j, q)) return;
      cand.push(j);
    });
    cand.sort(function (a, b) { return b.score - a.score; });
    var set = {};
    cand.slice(0, Math.max(1, +CFG.batchSize || 15)).forEach(function (j) { set[j.id] = 1; });
    autoCache = { key: key, set: set };
    return set;
  }

  /* 唯一真源：勾着的 + 在当前搜索词范围内 + 有链接 + 没投过，按分数从高到低。
   * 「已选」这个数字、投递按钮上的数字、实际投递的队列，全部来自这里 ——
   * 三处不可能再对不上。用户勾了 34 个就投 34 个，不再被「每批」偷偷截断。 */
  function buildPool() {
    var q = currentQuery();
    var all = [];
    JOBS.forEach(function (j) {
      if (!isPicked(j)) return;
      if (!inScope(j, q)) return;
      all.push(j);
    });
    all.sort(function (a, b) { return b.score - a.score; });
    return all;
  }
  function pickedCount() { return buildPool().length; }

  var pickTimer = null, pickWriteAt = 0;
  function savePicked() {
    clearTimeout(pickTimer);
    pickTimer = setTimeout(function () {
      pickWriteAt = Date.now();
      chrome.storage.local.set({ [SK.picked]: PICKED });
    }, 400);
  }

  /* 勾选/取消后刷新数字 + 列表顺序：不整块重绘面板，避免输入框和滚动位置被打断。
   * 列表必须跟着重排 —— 勾上的会浮到前面并带上投递序号，否则用户看不出
   * 「我勾的这几个到底什么时候投」。 */
  function syncPickUi() {
    if (!root) return;
    var n = buildPool().length;
    var bt = root.querySelector('#jrstart');
    if (bt) bt.textContent = '自动投递 ' + n + ' 个';
    var kp = root.querySelector('#jrpick');
    if (kp) kp.textContent = n;
    paintList();
  }

  function setAllPicks(on) {
    var q = currentQuery();
    var gate = relGate();
    JOBS.forEach(function (j) {
      if (!pickable(j) || !inScope(j, q)) return;
      /* 「全选」也不碰词外的那几个：那是 BOSS 推荐位混进来的，想投得自己勾 */
      if (on && gate && !relevance(j, q) && PICKED[j.id] !== 1) return;
      PICKED[j.id] = on ? 1 : 0;
    });
    savePicked();
    paintList();
    syncPickUi();
  }

  /* 面板里直接调投递节奏，不用再跳设置页
   * 档位从 5 秒起：BOSS 每个岗位本身要花 4-6 秒（等页面 + 填话术），
   * 所以 5s 档的实际节奏约 10s 一个，已经算快的那一档。 */
  var GAP_STEPS = [5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90];
  var BATCH_STEPS = [3, 5, 10, 15, 20, 30, 50];

  function saveCfg() {
    try { chrome.storage.sync.set({ [SK.cfg]: Object.assign({}, CFG) }); } catch (e) {}
  }

  /* 正在等下一个岗位时改了间隔 → 立刻按新间隔重排，不用等这一轮等完 */
  function rescheduleGap() {
    if (!RUN.active || RUN.waiting || !RUN.nextAt) return;
    var gap = Math.max(5, +CFG.autoIntervalSec || 15) * 1000;
    RUN.nextAt = Date.now() + gap;
    clearTimeout(RUN.timer);
    RUN.timer = setTimeout(nextJob, gap);
  }

  function stepGap(dir) {
    var cur = Math.max(5, +CFG.autoIntervalSec || 15);
    var i = GAP_STEPS.indexOf(cur);
    if (i < 0) {
      // 不在档位里：向上取最近一档
      for (var k = 0; k < GAP_STEPS.length; k++) if (GAP_STEPS[k] >= cur) { i = k; break; }
      if (i < 0) i = GAP_STEPS.length - 1;
    } else if (dir > 0) {
      i = Math.min(GAP_STEPS.length - 1, i + 1);
    } else {
      i = Math.max(0, i - 1);
    }
    CFG.autoIntervalSec = GAP_STEPS[i];
    saveCfg();
    rescheduleGap();
    paintShell();
  }

  function stepBatch(dir) {
    var cur = Math.max(1, +CFG.batchSize || 15);
    var i = BATCH_STEPS.indexOf(cur);
    if (i < 0) {
      for (var k = 0; k < BATCH_STEPS.length; k++) if (BATCH_STEPS[k] >= cur) { i = k; break; }
      if (i < 0) i = BATCH_STEPS.length - 1;
    } else if (dir > 0) {
      i = Math.min(BATCH_STEPS.length - 1, i + 1);
    } else {
      i = Math.max(0, i - 1);
    }
    CFG.batchSize = BATCH_STEPS[i];
    saveCfg();
    paintShell();
  }

  /* ================= 简历匹配计划 ================= */

  /* 计划里带了链接的岗位，即使当前页面一次都没抓到，也要能投。
   * 之前只做「把对得上的勾上」，一旦换了搜索词或刚刷新页面，计划就等于失效 ——
   * 这是「同步完还要回搜索页刷出这 10 个岗位」的根因。 */
  function jobFromPlan(it) {
    var sal = parseSalary(it.salary || '');
    var m = Math.round(+it.match || 0);
    return {
      id: it.id, title: it.title || '（未知岗位）', company: it.company || '',
      salary: it.salary || '', sal: sal, area: it.area || '',
      district: '', business: '', exp: it.exp || '', degree: it.degree || '',
      labels: [], welfare: [], scale: '', stage: '', industry: '',
      active: '', online: false, url: it.url || detailUrl(it.id),
      distKm: null, _geoDone: true,
      score: m, blocked: false, blockReason: '',
      reasons: [{ d: m, t: '简历匹配' }],
      fromResume: true
    };
  }

  function applyPlan(plan, opts) {
    opts = opts || {};
    if (!plan || !Array.isArray(plan.items) || !plan.items.length) return 0;
    PLAN = plan;
    MATCH = {};
    if (plan.greets) GREETS = plan.greets;

    /* 计划就是答案：只投计划里的，其余全部取消勾选 */
    JOBS.forEach(function (j) { if (pickable(j)) PICKED[j.id] = 0; });
    var hit = 0, added = 0;
    plan.items.forEach(function (it) {
      if (!it || !it.id) return;
      MATCH[it.id] = it.match;
      var job = JOBS.get(it.id);
      if (!job && (it.url || detailUrl(it.id))) {
        job = jobFromPlan(it);
        JOBS.set(it.id, job);
        added++;
      }
      if (job && pickable(job)) { PICKED[it.id] = 1; hit++; }
    });

    savePicked();
    /* 注入的岗位必须立刻落盘，否则刷新页面后又只剩「计划」，列表还是空的 */
    persist();
    POOL_REV++;
    chrome.storage.local.set({ [SK.greets]: GREETS });

    /* 话术模板改过之后，旧计划里的问候语会照旧发出去 —— 明确提示一次 */
    if (plan.mv && plan.mv !== GREET_TPL) {
      NOTICE = '这份计划是用 v' + plan.mv + ' 的话术生成的，当前模板是 v' + GREET_TPL +
        '。想用新话术就回简历页点一次「生成计划」。';
    }
    paintShell();

    if (!opts.silent && hit < plan.items.length) {
      var noUrl = plan.items.filter(function (it) { return !it.url; }).length;
      if (noUrl === plan.items.length) {
        alert('这份计划里的岗位没有详情页链接，投不了。\n' +
          '在 BOSS 搜索页让面板抓到岗位后再生成计划；示例岗位只能看效果。');
      } else {
        alert('计划 ' + plan.items.length + ' 个，可投 ' + hit + ' 个。\n' +
          '另外 ' + (plan.items.length - hit) + ' 个已经投过或没有链接，已跳过。');
      }
    }
    return hit;
  }

  /* ================= 投递队列 ================= */
  var RUN = { active: false, paused: false, queue: [], idx: 0, ok: 0, fail: 0, current: null, waiting: false, guard: null, timer: null, nextAt: 0, reason: '' };
  var tickTimer = null;

  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(function () {
      if (!RUN.active) { clearInterval(tickTimer); tickTimer = null; return; }
      var el = root && root.querySelector('#jrwait');
      if (!el) return;
      if (RUN.waiting) { el.textContent = '等待详情页响应…'; return; }
      if (RUN.nextAt) {
        var left = Math.ceil((RUN.nextAt - Date.now()) / 1000);
        el.textContent = left > 0 ? ('等待 ' + left + ' 秒后继续') : '准备打开下一个…';
      }
    }, 1000);
  }

  var NOTICE = '';

  function startRun(opts) {
    opts = opts || {};
    var pool = buildPool();

    function reject(msg) {
      NOTICE = msg;
      if (!opts.silent) alert(msg);
      paintShell();
    }

    if (!pool.length) {
      var qq = currentQuery();
      var inQ = 0, urlCount = 0;
      JOBS.forEach(function (j) {
        if (!inScope(j, qq)) return;
        inQ++;
        if (j.url) urlCount++;
      });
      if (JOBS.size > 0 && inQ === 0) {
        /* 池里有岗位，但全是别的关键词搜来的 —— 说清楚，别让人以为抓取坏了 */
        reject('「' + qq + '」下还没抓到岗位（池子里 ' + JOBS.size + ' 个是别的关键词搜的，已排除）。\n' +
          '在 BOSS 里搜「' + qq + '」并按 F5 刷新一次，抓到后再点投递。');
      } else if (JOBS.size > 0 && urlCount === 0) {
        reject('收录了 ' + JOBS.size + ' 个岗位，但一个都没拿到详情页链接，投不了。\n' +
          '到 BOSS 搜索页按 F5 刷新一次让面板重抓；还不行就点上面「接口 · DOM」那格，把诊断信息发我。');
      } else {
        reject(pickedCount() === 0 && JOBS.size > 0
          ? '一个都没勾选。在列表里勾上想投的岗位，或点「全选」。'
          : '没有可投递的岗位。先在搜索页让面板抓到岗位，或用「简历匹配」生成计划。');
      }
      return;
    }
    if (stats.opened >= CFG.dailyCap) {
      reject('今日已达上限 ' + CFG.dailyCap + ' 个。可在面板上调高上限，或明天再来。');
      return;
    }
    /* 勾多了就是真要投这么多（勾选 = 投递清单），所以开跑前让用户确认一次，
     * 免得「全选」之后手滑点下去，一晚上投出去几十个。 */
    if (!opts.silent && pool.length > 20) {
      if (!confirm('这次会连续投 ' + pool.length + ' 个岗位（间隔 ' +
        Math.max(5, +CFG.autoIntervalSec || 15) + ' 秒）。\n' +
        '确认列表里勾着的都是想投的？')) return;
    }

    NOTICE = '';
    RUN = { active: true, paused: false, queue: pool, idx: 0, ok: 0, fail: 0, current: null,
      waiting: false, guard: null, timer: null, nextAt: 0, reason: '' };
    paintShell();
    startTick();
    nextJob();
  }

  /* 简历页点了「开始投递」后留下的意图：本页加载完就自动开跑。
   * 一次性、且只在 3 分钟内有意义 —— 避免用户第二天打开 BOSS 被突然投递。 */
  function maybeAutoStart() {
    chrome.storage.local.get(SK.autoStart, function (r) {
      var a = r[SK.autoStart];
      if (!a || !a.at) return;
      chrome.storage.local.remove(SK.autoStart);
      if (Date.now() - a.at > 180000) return;
      if (RUN.active) return;
      setTimeout(function () {
        if (RUN.active) return;
        if (!PLAN) { NOTICE = '投递计划丢了，回简历页重新生成一次'; paintShell(); return; }
        /* 新开的 BOSS 页面可能一个岗位都没抓到，先把计划里的岗位补进池子再开跑 */
        var hit = applyPlan(PLAN, { silent: true });
        if (!hit) {
          NOTICE = '计划里的岗位已经投过或没有链接，没有可投的了';
          paintShell();
          return;
        }
        startRun({ silent: true });
      }, 900);
    });
  }

  function nextJob() {
    if (!RUN.active || RUN.paused) return;
    if (RUN.idx >= RUN.queue.length) return finishRun('队列完成');
    if (stats.opened >= CFG.dailyCap) return finishRun('达到每日上限 ' + CFG.dailyCap);

    var job = RUN.queue[RUN.idx];
    RUN.current = job;
    RUN.waiting = true;
    RUN.nextAt = 0;
    paintShell();

    chrome.runtime.sendMessage({ type: 'jr:next', job: { id: job.id, url: job.url, title: job.title } },
      function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          onDone(job, false, '打开页面失败');
        }
      });

    clearTimeout(RUN.guard);
    RUN.guard = setTimeout(function () {
      if (RUN.waiting) onDone(job, false, '页面响应超时');
    }, 18000);
  }

  function onDone(job, ok, reason) {
    if (!RUN.waiting || !RUN.active) return;
    clearTimeout(RUN.guard);
    RUN.waiting = false;

    stats.opened++;
    stats.lastOpenAt = Date.now();
    saveStats();

    if (ok) {
      RUN.ok++;
      APPLIED[job.id] = Date.now();
      POOL_REV++;          // 投过的要退出勾选，「默认勾选」顺位往后补一个
      chrome.storage.local.set({ [SK.applied]: APPLIED });
    } else {
      RUN.fail++;
    }
    logApply(job, ok, reason);

    RUN.idx++;

    if (RUN.idx >= RUN.queue.length) { paintShell(); return finishRun('队列完成'); }
    if (!RUN.active) { paintShell(); return; }

    var gap = Math.max(5, +CFG.autoIntervalSec || 15) * 1000;
    RUN.nextAt = Date.now() + gap;
    clearTimeout(RUN.timer);
    RUN.timer = setTimeout(nextJob, gap);
    paintShell();
  }

  function finishRun(reason) {
    RUN.active = false;
    RUN.paused = false;
    RUN.waiting = false;
    RUN.nextAt = 0;
    RUN.reason = reason || '';
    clearTimeout(RUN.guard);
    clearTimeout(RUN.timer);
    clearInterval(tickTimer);
    tickTimer = null;
    chrome.runtime.sendMessage({ type: 'jr:stop' }, function () {});
    paintShell();
    chrome.storage.local.set({ [SK.applied]: APPLIED });
  }

  function logApply(job, ok, reason) {
    chrome.storage.local.get([SK.log], function (r) {
      var log = Array.isArray(r[SK.log]) ? r[SK.log] : [];
      log.unshift({
        ts: Date.now(), id: job.id, title: job.title, company: job.company,
        salary: job.salary, score: job.score, ok: !!ok, reason: reason || ''
      });
      chrome.storage.local.set({ [SK.log]: log.slice(0, 500) });
    });
  }

  /* ================= 面板 ================= */
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.wrap{position:fixed;right:16px;top:88px;width:400px;max-height:calc(100vh - 120px);z-index:2147483000;',
    ' background:rgba(16,19,26,.97);color:#e6edf7;border:1px solid rgba(120,150,200,.22);border-radius:14px;',
    ' box-shadow:0 18px 50px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;backdrop-filter:blur(14px)}',
    '.wrap.mini{width:auto}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:linear-gradient(180deg,rgba(37,99,235,.22),rgba(37,99,235,0))}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}',
    '.dot.run{background:#f0b429;box-shadow:0 0 8px #f0b429;animation:pulse 1.2s infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '.ttl{font-size:13px;font-weight:600;letter-spacing:.3px}',
    '.sub{font-size:11px;color:#8b98ad;margin-left:auto}',
    '.bar{display:flex;gap:6px;padding:0 12px 8px;flex-wrap:wrap}',
    '.kpi{font-size:11px;color:#9fb0c9;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);',
    ' border-radius:7px;padding:3px 7px}',
    '.kpi b{color:#e6edf7}',
    '.filters{display:flex;gap:6px;padding:0 12px 8px;align-items:center;flex-wrap:wrap}',
    '.pg{display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:7px;overflow:hidden;background:rgba(255,255,255,.04)}',
    '.pg i{font-style:normal;font-size:12px;line-height:1;padding:5px 7px;cursor:pointer;color:#9fb0c9;user-select:none}',
    '.pg i:hover{background:rgba(96,165,250,.25);color:#fff}',
    '.pg b{font-size:11px;font-weight:600;color:#cfe0f5;padding:0 3px;min-width:56px;text-align:center;white-space:nowrap}',
    '.pg b em{font-style:normal;color:#f0b429}',
    '.ck{flex:0 0 15px;display:flex;align-items:flex-start;justify-content:center;padding-top:6px}',
    '.ck input{width:15px;height:15px;margin:0;cursor:pointer;accent-color:#3b82f6}',
    '.ck input:disabled{cursor:not-allowed;opacity:.3}',
    '.row.on .nm{color:#fff}',
    '.chip{font-size:11px;padding:4px 8px;border-radius:7px;border:1px solid rgba(255,255,255,.1);color:#9fb0c9;cursor:pointer;background:transparent}',
    '.chip.on{background:rgba(37,99,235,.25);border-color:rgba(96,165,250,.5);color:#bfdbfe}',
    '.run{padding:9px 12px;border-top:1px solid rgba(255,255,255,.07);background:rgba(240,180,41,.06)}',
    '.run .line{display:flex;justify-content:space-between;font-size:11px;color:#c9d6e8;margin-bottom:5px}',
    '.run .line b{color:#f0b429}',
    '.track{height:4px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}',
    '.fill{height:100%;background:linear-gradient(90deg,#f0b429,#22c55e);transition:width .3s}',
    '.cur{font-size:11px;color:#8b98ad;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.notice{padding:8px 12px;border-top:1px solid rgba(255,255,255,.07);background:rgba(239,68,68,.1);',
    ' font-size:11px;line-height:1.5;color:#fca5a5}',
    '.list{overflow-y:auto;padding:0 8px 8px;flex:1}',
    '.list::-webkit-scrollbar{width:6px}',
    '.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}',
    '.row{display:flex;gap:10px;padding:9px 8px;border-radius:10px;cursor:pointer;border:1px solid transparent}',
    '.row:hover{background:rgba(255,255,255,.05);border-color:rgba(120,150,200,.2)}',
    '.row.blk{opacity:.42}',
    '.row.on{background:rgba(240,180,41,.04)}',
    '.row.now{border-color:rgba(240,180,41,.5);background:rgba(240,180,41,.07)}',
    '.sc{flex:0 0 40px;text-align:center;padding-top:2px}',
    '.sc b{display:block;font-size:17px;line-height:1;font-weight:700}',
    '.sc span{font-size:9px;color:#7b8798}',
    '.mid{flex:1;min-width:0}',
    '.t1{display:flex;gap:6px;align-items:baseline}',
    '.nm{font-size:13px;font-weight:600;color:#eaf1fb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
    '.sal{font-size:12px;font-weight:600;color:#f0b429;white-space:nowrap;margin-left:auto}',
    '.t2{font-size:11px;color:#8b98ad;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}',
    '.tg{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.06);color:#a8b6ca}',
    '.tg.p{background:rgba(34,197,94,.14);color:#7ee2a8}',
    '.tg.m{background:rgba(239,68,68,.14);color:#fca5a5}',
    '.tg.done{background:rgba(96,165,250,.16);color:#93c5fd}',
    '.tg.mt{background:rgba(167,139,250,.18);color:#c4b5fd}',
    /* 「投 3」= 勾上了、会按这个顺序投出去 */
    '.tg.pk{background:rgba(240,180,41,.18);color:#fbbf24;font-weight:600}',
    /* 分组标题：会投的 / 没勾的 / 已投的 分清楚 */
    '.sec{padding:9px 8px 2px;font-size:10.5px;color:#5f6a7d;letter-spacing:.2px}',
    '.ft{display:flex;gap:6px;padding:8px;border-top:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.2)}',
    '.btn{flex:1;font-size:11px;padding:7px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.12);',
    ' background:rgba(255,255,255,.06);color:#dbe6f5;cursor:pointer}',
    '.btn:hover{background:rgba(255,255,255,.12)}',
    '.btn.pri{background:linear-gradient(180deg,#3b82f6,#2563eb);border-color:#1d4ed8;color:#fff;font-weight:600}',
    '.btn.warn{background:linear-gradient(180deg,#f59e0b,#d97706);border-color:#b45309;color:#fff;font-weight:600}',
    '.btn.stop{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.4);color:#fca5a5}',
    '.empty{padding:26px 14px;text-align:center;font-size:12px;color:#7b8798;line-height:1.7}',
    '.scope-note{padding:8px 4px 2px;text-align:center;font-size:10.5px;color:#5f6a7d}',
    '.sbar{display:flex;gap:6px;padding:0 12px 8px}',
    '.kin{flex:1;min-width:0;background:#0a0f17;border:1px solid rgba(120,150,200,.24);border-radius:8px;',
    ' color:#e6edf7;font-size:12px;padding:6px 9px;outline:none;font-family:inherit}',
    '.kin:focus{border-color:#3b82f6}',
    '.kbtn{font-size:11px;padding:6px 11px;border-radius:8px;border:1px solid #1d4ed8;',
    ' background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;cursor:pointer;font-weight:600;flex:0 0 auto}',
    '.kbtn:hover{filter:brightness(1.08)}',
    /* 简历匹配主入口：单独一行，不跟小胶囊挤在一起 */
    '.rmatch{display:flex;align-items:center;gap:9px;margin:0 12px 8px;padding:8px 10px;border-radius:9px;',
    ' border:1px solid rgba(96,165,250,.35);background:linear-gradient(90deg,rgba(37,99,235,.22),rgba(37,99,235,.06));cursor:pointer}',
    '.rmatch:hover{background:linear-gradient(90deg,rgba(37,99,235,.34),rgba(37,99,235,.1))}',
    '.rmatch .ic{flex:0 0 20px;width:20px;height:20px;border-radius:5px;background:rgba(96,165,250,.25);',
    ' color:#bfdbfe;font-size:11px;display:flex;align-items:center;justify-content:center}',
    '.rmatch .tx{flex:1;min-width:0}',
    '.rmatch .tx b{font-size:11.5px;color:#dbeafe;font-weight:600}',
    '.rmatch .tx i{display:block;font-style:normal;font-size:10.5px;color:#8b98ad;margin-top:2px;',
    ' white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.rmatch .go{flex:0 0 auto;font-size:11px;color:#93c5fd}',
    '.ver{font-size:10px;color:#5f6a7d;margin-left:5px;font-weight:400}',
    '.mini-bar{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer}'
  ].join('');

  function ensurePanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__jobradar_host__';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:0;top:0;width:0;height:0';
    root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    root.appendChild(wrap);
    host.__wrap = wrap;
    paintShell();
  }

  function passedCount() {
    var n = 0;
    JOBS.forEach(function (j) { if (!j.blocked && !APPLIED[j.id]) n++; });
    return n;
  }

  function paintShell() {
    if (!host) return;
    var w = host.__wrap;

    // 保留关键词输入框的内容与焦点，避免抓数据时重绘把它清掉
    /* 优先显示页面实际在搜的词：用户可能直接在 BOSS 搜索框改了关键词，
     * 设置页里的值还没跟上，输入框跟着页面走才不会让人以为没改 */
    var curKw = currentQuery() || CFG.jobQuery || '';
    var wasFocus = false;
    try {
      var oldInp = root.querySelector('#jrkw');
      if (oldInp) {
        if (oldInp.value) curKw = oldInp.value;
        wasFocus = root.activeElement === oldInp;
      }
    } catch (e) { /* ignore */ }

    if (collapsed) {
      w.className = 'wrap mini';
      w.innerHTML =
        '<div class="mini-bar" data-act="expand">' +
        '<div class="dot ' + (RUN.active ? 'run' : '') + '"></div>' +
        '<div class="ttl">岗位雷达 · ' +
        (RUN.active ? RUN.idx + '/' + RUN.queue.length : JOBS.size) + '</div>' +
        '<div class="sub">展开</div></div>';
      return;
    }

    var runBlock = '';
    if (RUN.active) {
      var pct = RUN.queue.length ? Math.round((RUN.idx / RUN.queue.length) * 100) : 0;
      runBlock =
        '<div class="run">' +
        '<div class="line"><span>' + (RUN.paused ? '已暂停' : '正在投递') + ' ' + RUN.idx + '/' + RUN.queue.length + '</span>' +
        '<span>成功 <b>' + RUN.ok + '</b> · 失败 ' + RUN.fail + '</span></div>' +
        '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<div class="cur">' + esc(RUN.current ? RUN.current.title : '准备中…') + '</div>' +
        '<div class="cur" id="jrwait" style="color:#f0b429"></div>' +
        '</div>';
    } else if (NOTICE) {
      runBlock = '<div class="notice">' + esc(NOTICE) + '</div>';
    }

    var foot = RUN.active
      ? '<button class="btn ' + (RUN.paused ? 'pri' : '') + '" data-act="pause">' + (RUN.paused ? '继续' : '暂停') + '</button>' +
        '<button class="btn stop" data-act="stop">停止</button>'
      : '<button class="btn warn" data-act="start" id="jrstart">自动投递 ' + buildPool().length + ' 个</button>' +
        '<button class="btn" data-act="export">导出</button>' +
        '<button class="btn" data-act="clear">清空</button>';

    w.className = 'wrap';
    /* 可投 = 有详情页链接且还没投过。旧版本这里不显示，
     * 结果是用户看到「自动投递 0 个」完全不知道为什么。 */
    var qNow = currentQuery();
    var withUrl = 0, inScopeN = 0;
    JOBS.forEach(function (j) {
      if (!inScope(j, qNow)) return;
      inScopeN++;
      if (j.url && !APPLIED[j.id]) withUrl++;
    });
    w.innerHTML =
      '<div class="hd" data-act="collapse">' +
      '<div class="dot ' + (RUN.active ? 'run' : '') + '"></div>' +
      '<div class="ttl">岗位雷达<span class="ver">v' + VERSION + '</span></div>' +
      '<div class="sub">收起</div></div>' +
      '<div class="bar">' +
      '<div class="kpi" title="当前搜索词下的岗位数（池子里共有 ' + JOBS.size + ' 个）">收录 <b>' +
      inScopeN + '</b></div>' +
      '<div class="kpi" title="已勾选、会投递的岗位数。勾选框 = 投不投这个岗位，勾上就会投">已选 <b id="jrpick">' +
      pickedCount() + '</b></div>' +
      '<div class="kpi" title="有详情页链接、还没投过的岗位数">可投 <b>' + withUrl + '</b></div>' +
      '<div class="kpi">已投 <b>' + Object.keys(APPLIED).length + '</b></div>' +
      '<div class="kpi">今日 <b>' + stats.opened + '/' + CFG.dailyCap + '</b></div>' +
      '<div class="kpi" data-act="diag" style="cursor:pointer" title="点我复制诊断信息">接口 <b>' +
      diag.net + '</b> · DOM <b>' + diag.tries + '</b></div>' +
      '</div>' +
      '<div class="sbar">' +
      '<input id="jrkw" class="kin" placeholder="岗位关键词，如 前端 / AI 产品" value="' + esc(curKw) + '">' +
      '<button class="kbtn" data-act="search">搜索</button>' +
      '</div>' +
      /* 简历匹配：独立主入口，文案永远是这四个字，状态放在副标题里 */
      '<div class="rmatch" data-act="resume" title="上传 docx 或粘贴简历，找出最匹配的岗位并为每个岗位生成专属话术">' +
      '<span class="ic">简</span>' +
      '<span class="tx"><b>简历匹配</b><i>' +
      (PLAN ? '已同步 ' + PLAN.items.length + ' 个 · 每个岗位一对一话术，点这里查看/改'
            : '上传或粘贴简历，自动找出最匹配的岗位 + 专属打招呼语') +
      '</i></span>' +
      '<span class="go">打开 →</span>' +
      '</div>' +
      '<div class="filters">' +
      '<span class="pg" title="两次投递之间的间隔，随时可改"><i data-act="gap-">−</i>' +
      '<b>间隔 <em>' + Math.max(5, +CFG.autoIntervalSec || 15) + '</em>s</b>' +
      '<i data-act="gap+" title="加长间隔">+</i></span>' +
      '<span class="pg" title="没手动勾选时，自动勾上分数最高的前 N 个（勾这就是投递清单，勾多少投多少）"><i data-act="batch-">−</i>' +
      '<b>默认勾 <em>' + Math.max(1, +CFG.batchSize || 15) + '</em></b>' +
      '<i data-act="batch+" title="增加默认勾选数量">+</i></span>' +
      '<button class="chip" data-act="pick-all">全选</button>' +
      '<button class="chip" data-act="pick-none">全不选</button>' +
      '</div>' +
      '<div class="filters">' +
      '<button class="chip ' + (CFG.hideBlocked ? 'on' : '') + '" data-act="toggle-blocked">只看通过</button>' +
      '<button class="chip" data-act="rescan">重新打分</button>' +
      '<button class="chip" data-act="options">筛选设置</button>' +
      '</div>' +
      runBlock +
      '<div class="list"></div>' +
      '<div class="ft">' + foot + '</div>';

    listEl = root.querySelector('.list');
    paintList();

    if (wasFocus) {
      var ni = root.querySelector('#jrkw');
      if (ni) {
        ni.focus();
        try { ni.setSelectionRange(ni.value.length, ni.value.length); } catch (e) {}
      }
    }
  }

  function scoreColor(s) {
    if (s >= 80) return '#22c55e';
    if (s >= 65) return '#38bdf8';
    if (s >= 50) return '#f0b429';
    return '#ef4444';
  }

  function paintList() {
    if (!listEl) return;
    /* 岗位池是跨关键词累积的，列表必须收在当前搜索词范围内 —— 否则改完关键词
     * 还看到上一批岗位，用户会以为设置没生效（旧版本就是这个毛病）。 */
    var q = currentQuery();
    var others = [];
    var arr = Array.from(JOBS.values()).filter(function (j) {
      if (inScope(j, q)) return true;
      others.push(j);
      return false;
    }).filter(function (j) {
      return !(CFG.hideBlocked && j.blocked);
    });

    /* 列表顺序要说清「接下来会发生什么」：
     *   ① 勾着的（会投）在最上面，按真正投递的顺序（分数从高到低）
     *   ② 没勾的其次  ③ 已投过的  ④ 被排除的
     * 以前只按分数排，于是已投的、没勾的会排在勾着的上面，看着像勾选乱了。 */
    var queue = buildPool();
    var qIdx = {};
    queue.forEach(function (j, i) { qIdx[j.id] = i + 1; });
    function rankOf(j) {
      if (APPLIED[j.id]) return 3;
      if (j.blocked) return 4;
      return isPicked(j) ? 0 : 1;
    }
    var RANK = {}, CNT = { 1: 0, 3: 0, 4: 0 };
    arr.forEach(function (j) {
      RANK[j.id] = rankOf(j);
      if (CNT[RANK[j.id]] != null) CNT[RANK[j.id]]++;
    });
    arr.sort(function (a, b) {
      var d = RANK[a.id] - RANK[b.id];
      if (d) return d;
      if (RANK[a.id] === 0) return (qIdx[a.id] || 0) - (qIdx[b.id] || 0);
      return b.score - a.score;
    });
    var SEC = {
      1: '没勾选 · 不会投递',
      3: '已投过',
      4: '已排除'
    };

    var otherKw = uniqQs(others.map(function (j) { return (j.qs || []).join('/'); })).slice(0, 3).join('、');
    var offQCount = q ? arr.filter(function (j) { return !relevance(j, q); }).length : 0;

    if (!arr.length) {
      if (others.length) {
        listEl.innerHTML = '<div class="empty">' +
          '<div style="font-size:13px;color:#c9d6e8;margin-bottom:9px">' +
          '「' + esc(q) + '」下还没抓到岗位</div>' +
          (otherKw
            ? '池子里有 ' + others.length + ' 个岗位是别的关键词搜的（' + esc(otherKw) + '），已隐藏'
            : '池子里有 ' + others.length + ' 个岗位不属于这个词，已隐藏') + '<br>' +
          '<span style="color:#5f6a7d">在 BOSS 里搜「' + esc(q) + '」并按 F5 刷新，卡片就会进来</span>' +
          '</div>';
      } else if (JOBS.size > 0) {
        listEl.innerHTML = '<div class="empty">收录了 ' + JOBS.size + ' 个岗位，但都被筛掉了<br>' +
          '把「只看通过」关掉，就能看到每个岗位被排除的原因</div>';
      } else {
        listEl.innerHTML =
          '<div class="empty">' +
          '<div style="font-size:13px;color:#c9d6e8;margin-bottom:9px">还没抓到岗位</div>' +
          '<div style="display:inline-block;text-align:left;line-height:2">' +
          '① 在上面输入 <b>岗位关键词</b>，点「搜索」<br>' +
          '② 进到搜索结果页后，按 <b>F5 刷新</b> 一次<br>' +
          '③ 往下滚两屏，卡片会自动进来' +
          '</div>' +
          '<div style="margin-top:11px;color:#5f6a7d;font-size:11px">' +
          '接口响应 ' + diag.net + ' 次 · DOM 扫描 ' + diag.tries + ' 次' +
          (diag.domCards ? ' · 最近解析到 ' + diag.domCards + ' 张卡片' : '') +
          '</div></div>';
      }
      return;
    }

    var keepTop = listEl.scrollTop;
    var shownRank = -1;
    var html = '';

    arr.slice(0, 60).forEach(function (j) {
      var rk = RANK[j.id];
      /* 分组标题：一眼看出「上面这些会投、下面这些不会」 */
      if (rk !== shownRank) {
        shownRank = rk;
        if (rk !== 0 && CNT[rk]) {
          html += '<div class="sec">' + esc(SEC[rk] || '') + ' · ' + CNT[rk] + ' 个</div>';
        }
      }

      var tags = j.reasons.slice(0, 3).map(function (r) {
        return '<span class="tg ' + (r.d >= 0 ? 'p' : 'm') + '">' + (r.d >= 0 ? '+' : '') +
          r.d + ' ' + esc(r.t) + '</span>';
      }).join('');
      if (APPLIED[j.id]) tags = '<span class="tg done">已投</span>' + tags;
      else if (MATCH[j.id]) tags = '<span class="tg mt">匹配 ' + MATCH[j.id] + '</span>' + tags;
      /* 没有详情页链接就投不了，直接在行里说明，别让用户点「自动投递 0 个」发懵 */
      if (!j.url) tags = '<span class="tg m">无链接</span>' + tags;
      /* 标题/标签里压根没有搜索词 —— BOSS 的推荐位、详情页的「相似职位」常这样混进来 */
      if (q && !relevance(j, q)) tags += '<span class="tg m">词外</span>';

      var meta = [j.company, j.stage, j.scale, j.area].filter(Boolean).join(' · ');
      var isNow = RUN.active && RUN.current && RUN.current.id === j.id;
      var pk = pickable(j);
      var on = isPicked(j);
      /* 勾了就会投 —— 直接标出它是第几个投的，用户不用猜「勾了到底投不投」 */
      if (on && qIdx[j.id]) tags = '<span class="tg pk">投 ' + qIdx[j.id] + '</span>' + tags;

      var ckTip = !pk
        ? (APPLIED[j.id] ? '已经投过了，不能再勾' : (j.blocked ? '被筛除的岗位不投' : '没拿到详情页链接，投不了'))
        : '勾上 = 投递这个岗位（会出现在下面的投递清单里）；取消 = 不投';

      html += '<div class="row ' + (j.blocked ? 'blk ' : '') + (on ? 'on ' : '') + (isNow ? 'now' : '') +
        '" data-id="' + esc(j.id) + '" title="' +
        (j.url ? '点一下打开详情页：' + esc(j.url) : '没有详情页链接，投不了（刷新搜索页重抓一次）') + '">' +
        '<div class="ck" title="' + esc(ckTip) + '"><input type="checkbox" class="jrpick" data-id="' + esc(j.id) + '"' +
        (on ? ' checked' : '') + (pk ? '' : ' disabled') + '></div>' +
        '<div class="sc"><b style="color:' + scoreColor(j.score) + '">' + j.score + '</b><span>分</span></div>' +
        '<div class="mid">' +
        '<div class="t1"><span class="nm">' + esc(j.title) + '</span>' +
        '<span class="sal">' + esc(j.salary || '面议') + '</span></div>' +
        '<div class="t2">' + esc(j.blocked ? ('已排除：' + j.blockReason) : meta) + '</div>' +
        '<div class="tags">' + tags + '</div></div></div>';
    });

    /* 勾选多的时候，把「不会投的那批」的数量说清楚，免得以为漏了 */
    if (CNT[1]) {
      html += '<div class="scope-note">最上面 ' + queue.length + ' 个会依次投；这 ' + CNT[1] +
        ' 个没勾选不会投，点勾选框就能加进去</div>';
    }
    html += others.length
      ? '<div class="scope-note">' +
        (otherKw ? '已隐藏 ' + others.length + ' 个其他关键词的岗位（' + esc(otherKw) + '）'
                 : '已隐藏 ' + others.length + ' 个不属于「' + esc(q) + '」的岗位') + '</div>'
      : '';
    html += offQCount
      ? '<div class="scope-note">其中 ' + offQCount + ' 个标了「词外」：标题里没有「' + esc(q) +
        '」，多半是 BOSS 推荐位混进来的，默认不勾</div>'
      : '';

    listEl.innerHTML = html;
    listEl.scrollTop = keepTop;      // 重排/勾选后不跳回顶部
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      if (!host) { ensurePanel(); return; }
      var inp = root && root.querySelector('#jrkw');
      if (inp && root.activeElement === inp) { paintList(); return; }  // 正在输入，只刷新列表
      paintShell();
    }, 200);
  }

  function exportCsv() {
    var rows = [['分数', '职位', '公司', '薪资', '区域', '经验', '学历', '阶段', '规模', 'HR活跃', '已投', '排除原因', '链接']];
    Array.from(JOBS.values()).sort(function (a, b) { return b.score - a.score; }).forEach(function (j) {
      rows.push([j.score, j.title, j.company, j.salary, j.area, j.exp, j.degree, j.stage,
        j.scale, j.active, APPLIED[j.id] ? '是' : '', j.blocked ? j.blockReason : '', j.url]);
    });
    var csv = '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jobradar-' + todayStr() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* 打开设置页：先走 background，失败则直接开标签页兜底 */
  function openSettings() {
    openExtPage('openOptions', 'options.html');
  }

  /* 打开简历匹配页，同样是三层兜底 */
  function openResumePage() {
    openExtPage('openResume', 'resume.html');
  }

  function openExtPage(msgType, file) {
    try {
      chrome.runtime.sendMessage({ type: msgType }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          try {
            window.open(chrome.runtime.getURL(file), '_blank');
          } catch (e) {
            alert('打开页面失败，请从扩展详情里手动打开 ' + file);
          }
        }
      });
    } catch (e) {
      try { window.open(chrome.runtime.getURL(file), '_blank'); } catch (e2) {}
    }
  }

  /* 城市名 → BOSS 城市编码（可用 URL 里已有的 city 参数覆盖） */
  var CITY_CODE = {
    '北京': '101010100', '上海': '101020100', '广州': '101280100', '深圳': '101280600',
    '杭州': '101210100', '成都': '101270100', '南京': '101190100', '武汉': '101200100',
    '西安': '101110100', '苏州': '101190400', '长沙': '101250100', '郑州': '101180100',
    '天津': '101030100', '重庆': '101040100', '厦门': '101230200', '青岛': '101120200',
    '合肥': '101220100', '济南': '101120100', '福州': '101230100', '宁波': '101210400',
    '东莞': '101281600', '佛山': '101280800', '无锡': '101190200', '沈阳': '101070100',
    '大连': '101070200', '昆明': '101290100', '南昌': '101240100', '贵阳': '101260100',
    '石家庄': '101090100', '哈尔滨': '101050100'
  };

  function doSearch() {
    var inp = root.querySelector('#jrkw');
    var kw = inp ? inp.value.trim() : '';
    if (!kw) {
      alert('先填岗位关键词，比如「前端」「AI 产品经理」');
      if (inp) inp.focus();
      return;
    }
    CFG.jobQuery = kw;
    chrome.storage.sync.set({ [SK.cfg]: Object.assign({}, CFG) });

    var cityCode = param('city') || CITY_CODE[CFG.city] || '';
    location.href = 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(kw) +
      (cityCode ? '&city=' + cityCode : '');
  }

  /* 一键复制诊断信息：远程排障用（抓错数据、抓不到数据时直接发我） */
  function copyDiag() {
    var arr = Array.from(JOBS.values());
    var qNow = currentQuery();
    var inQ = arr.filter(function (j) { return inScope(j, qNow); });
    var info = {
      version: VERSION,
      url: location.href,
      /* 页面实际搜索词 vs 设置里填的 —— 两个不一致就是「改了设置但还是旧岗位」的原因 */
      currentQuery: qNow,
      pageQuery: pageQuery(),
      inCurrentQuery: inQ.length,
      offQuery: inQ.filter(function (j) { return !relevance(j, qNow); }).length,
      apiResponses: diag.net,
      domScans: diag.tries,
      domCards: diag.domCards,
      collected: arr.length,
      withUrl: inQ.filter(function (j) { return !!j.url; }).length,
      healed: diag.healed,
      cfg: { jobQuery: CFG.jobQuery, city: CFG.city, salaryFloor: CFG.salaryFloor },
      normalized: inQ.slice(0, 5).map(function (j) {
        return {
          id: j.id, title: j.title, company: j.company, salary: j.salary,
          area: j.area, score: j.score, qs: j.qs || null, url: j.url || '(空)'
        };
      }),
      otherQueries: uniqQs(arr.filter(function (j) { return !inScope(j, qNow); })
        .map(function (j) { return (j.qs || []).join('/'); })),
      sampleApi: diag.sampleApi || null,
      sampleDomCard: diag.sampleDom || ''
    };
    var txt = JSON.stringify(info, null, 2);
    try {
      navigator.clipboard.writeText(txt).then(function () {
        alert('诊断信息已复制，直接粘贴发我即可。\n\n（包含页面结构片段和抓到的薪资原文，不含账号信息）');
      }).catch(function () { window.prompt('复制下面的内容：', txt.slice(0, 4000)); });
    } catch (e) {
      window.prompt('复制下面的内容：', txt.slice(0, 4000));
    }
  }

  function bindPanel() {
    root.addEventListener('click', function (e) {
      /* 勾选框：只改选择，不触发「打开详情页」 */
      var cb = e.target.closest ? e.target.closest('input.jrpick') : null;
      if (cb) {
        e.stopPropagation();
        var jid = cb.getAttribute('data-id');
        if (jid) {
          PICKED[jid] = cb.checked ? 1 : 0;
          savePicked();
          var rw = cb.closest('.row');
          if (rw) rw.classList[cb.checked ? 'add' : 'remove']('on');
          syncPickUi();
        }
        return;
      }

      /* 点到勾选框外圈留白，也算一次勾选（不然很容易误触成打开岗位） */
      var ckBox = e.target.closest ? e.target.closest('.ck') : null;
      if (ckBox) {
        var cbIn = ckBox.querySelector('input.jrpick');
        if (cbIn && !cbIn.disabled) cbIn.click();
        e.stopPropagation();
        return;
      }

      var actEl = e.target.closest('[data-act]');
      if (actEl) {
        var act = actEl.getAttribute('data-act');
        if (act === 'expand') { collapsed = false; paintShell(); }
        else if (act === 'collapse') { collapsed = true; paintShell(); }
        else if (act === 'toggle-blocked') { CFG.hideBlocked = !CFG.hideBlocked; paintShell(); }
        else if (act === 'rescan') { rescoreAll(); }
        else if (act === 'options') { openSettings(); }
        else if (act === 'search') { doSearch(); }
        else if (act === 'diag') { copyDiag(); }
        else if (act === 'export') { exportCsv(); }
        else if (act === 'start') { startRun(); }
        else if (act === 'gap-') { stepGap(-1); }
        else if (act === 'gap+') { stepGap(1); }
        else if (act === 'batch-') { stepBatch(-1); }
        else if (act === 'batch+') { stepBatch(1); }
        else if (act === 'pick-all') { setAllPicks(true); }
        else if (act === 'pick-none') { setAllPicks(false); }
        else if (act === 'resume') { openResumePage(); }
        else if (act === 'pause') {
          RUN.paused = !RUN.paused;
          if (RUN.paused) { clearTimeout(RUN.timer); }
          else if (!RUN.waiting) { nextJob(); }
          paintShell();
        }
        else if (act === 'stop') {
          finishRun('手动停止');
        }
        else if (act === 'clear') {
          if (confirm('清空当前抓取的 ' + JOBS.size + ' 个岗位？（已投记录会保留）')) {
            JOBS.clear();
            paintShell();
            chrome.storage.local.set({ [SK.jobs]: [] });
          }
        }
        e.stopPropagation();
        return;
      }

      var row = e.target.closest('.row');
      if (row) {
        if (RUN.active) { alert('投递进行中，先停止再手动打开。'); return; }
        var job = JOBS.get(row.getAttribute('data-id'));
        if (job && job.url) {
          var sep = job.url.includes('?') ? '&' : '?';
          chrome.runtime.sendMessage({ type: 'openTab', url: job.url + sep + 'jr=1&jr_id=' + encodeURIComponent(job.id) });
        }
      }
    }, true);

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'jrkw') {
        e.preventDefault();
        doSearch();
      }
    });
  }

  /* ================= 详情页执行器 ================= */
  var reported = false;
  function report(jobId, ok, reason) {
    if (reported) return;
    reported = true;
    var payload = { jobId: jobId || '', ok: !!ok, reason: reason || '', at: Date.now() };
    // 双通道：storage 事件最可靠（跨 SW 重启、跨标签页都能收到），消息只用来加速
    try { chrome.storage.local.set({ 'jr:lastDone': payload }); } catch (e) {}
    try {
      chrome.runtime.sendMessage({
        type: 'jr:pageDone', jobId: payload.jobId, ok: payload.ok, reason: payload.reason
      });
    } catch (e) {}
  }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) && getComputedStyle(el).visibility !== 'hidden';
  }

  function waitFor(fn, timeout, interval) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var timer = setInterval(function () {
        var r = null;
        try { r = fn(); } catch (e) {}
        if (r) { clearInterval(timer); resolve(r); return; }
        if (Date.now() - t0 > timeout) { clearInterval(timer); resolve(null); }
      }, interval || 400);
    });
  }

  function findChatButton() {
    var sels = ['.btn-startchat', '.op-btn-chat', 'a[ka="job_detail_chat"]', '.job-op .btn-sure', '.btn-startchat'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && isVisible(el)) return el;
    }
    var cands = document.querySelectorAll('a, button, span.btn, div.btn');
    for (var j = 0; j < cands.length; j++) {
      var t = (cands[j].textContent || '').replace(/\s/g, '');
      if ((t === '立即沟通' || t === '继续沟通') && isVisible(cands[j])) return cands[j];
    }
    return null;
  }

  function findChatInput() {
    var sels = ['.chat-input', '#chat-input', '.chat-editor [contenteditable="true"]',
      '.chat-input-area [contenteditable="true"]', '.dialog-container .chat-input',
      '.message-editor [contenteditable="true"]', '.chat-input-box [contenteditable="true"]'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && isVisible(el)) return el;
    }
    // 兜底：只认在聊天/弹窗容器里的 contenteditable，避免误伤页面顶部的搜索框
    var generic = document.querySelectorAll('div[contenteditable="true"], textarea');
    for (var j = 0; j < generic.length && j < 12; j++) {
      var g = generic[j];
      if (!isVisible(g)) continue;
      var box = g.closest('[class*="chat"],[class*="dialog"],[class*="message"],[class*="editor"]');
      if (box) return g;
    }
    return null;
  }

  /* BOSS 点击「立即沟通」后弹的成功浮层 */
  function findSentToast() {
    var nodes = document.querySelectorAll(
      '[class*="dialog"],[class*="popup"],[class*="toast"],[class*="modal"],[class*="tip"]'
    );
    for (var i = 0; i < nodes.length && i < 40; i++) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var t = n.textContent || '';
      if (t.length < 160 && /已向BOSS发送消息|消息已发送|发送成功/.test(t)) return n;
    }
    return null;
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---- 找发送按钮：只在输入框所在的聊天容器里找，避免点到页面上别的「确定」 ---- */
  function chatScope(input) {
    var el = input;
    for (var i = 0; i < 9 && el && el !== document.body; i++) {
      var cls = (el.className && typeof el.className === 'string') ? el.className : '';
      if (/chat|dialog|message|editor|im-/i.test(cls)) return el;
      el = el.parentElement;
    }
    return (input.parentElement && input.parentElement.parentElement) || document.body;
  }

  function findSendButton(input) {
    var scope = chatScope(input) || document.body;
    var sels = ['.btn-send', '.send-btn', '[class*="send-btn"]', '[class*="btn-send"]',
      '.chat-op .btn-sure', '[class*="send"] [class*="btn"]'];
    for (var i = 0; i < sels.length; i++) {
      var b = scope.querySelector(sels[i]);
      if (b && isVisible(b)) return b;
    }
    /* BOSS 的发送按钮就是一个 <div class="btn-sure">发送</div>，按文字找最稳。
     * 倒着找：外层容器（.chat-op）的 textContent 也是「发送」，
     * 正序会先命中容器，点了白点 —— 由内向外才是真按钮。 */
    var groups = [scope, document];
    for (var g = 0; g < groups.length; g++) {
      var nodes = groups[g].querySelectorAll('button, div, span, a');
      for (var k = nodes.length - 1; k >= 0 && k > nodes.length - 260; k--) {
        var t = (nodes[k].textContent || '').replace(/\s/g, '');
        if (t === '发送' && isVisible(nodes[k])) return nodes[k];
      }
    }
    return null;
  }

  function norm(s) { return String(s || '').replace(/[\s\u200b\u00a0]/g, ''); }
  function snippet(text) { return norm(text).slice(0, 12); }

  function readInput(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    return input.textContent || '';
  }

  function clearInput(input) {
    try {
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') { setNativeValue(input, ''); return; }
      input.focus();
      var sel = window.getSelection && window.getSelection();
      if (sel) {
        var r = document.createRange();
        r.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(r);
        document.execCommand('delete', false, null);
      }
      if (norm(readInput(input))) {
        input.textContent = '';
        try {
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        } catch (e) { input.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    } catch (e) { /* ignore */ }
  }

  /* 把文字真的填进编辑器，并回头读一遍确认 —— 这一步失败就不该点发送 */
  function typeText(input, text) {
    try {
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        setNativeValue(input, text);
      } else {
        try { input.focus(); input.click(); } catch (e) {}
        clearInput(input);
        try { document.execCommand('insertText', false, text); } catch (e) {}
        if (norm(readInput(input)).indexOf(snippet(text)) < 0) {
          /* BOSS 的编辑器是框架托管的：直接改节点后必须补一个带 data 的 input 事件，
           * 否则框架的 v-model 拿不到内容，点发送只会发出空消息 */
          input.textContent = text;
          try {
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          } catch (e2) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
    } catch (e) { /* ignore */ }
    return norm(readInput(input)).indexOf(snippet(text)) >= 0;
  }

  function pressEnter(el) {
    try {
      ['keydown', 'keypress', 'keyup'].forEach(function (t) {
        el.dispatchEvent(new KeyboardEvent(t, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      });
    } catch (e) { /* ignore */ }
  }

  /* 填入 + 发送 + 校验。
   * 旧版点了按钮就返回成功，实际上 BOSS 的编辑器经常没吃进文字，
   * 结果只发出站内默认招呼语 —— 用户看到的就是「话术没替换」。
   * 现在：填不进去就不点发送；发出去了以「输入框被清空」为准。 */
  function sendGreeting(input, text) {
    return new Promise(function (resolve) {
      if (!input || !norm(text)) return resolve(false);

      typeText(input, text);

      setTimeout(function () {
        // 有些编辑器要等一拍才同步，再确认一次
        if (norm(readInput(input)).indexOf(snippet(text)) < 0) {
          typeText(input, text);
          if (norm(readInput(input)).indexOf(snippet(text)) < 0) return resolve(false);
        }

        var btn = findSendButton(input);
        if (btn) { try { btn.click(); } catch (e) {} }
        else pressEnter(input);

        setTimeout(function () {
          if (norm(readInput(input)).indexOf(snippet(text)) < 0) return resolve(true);  // 清空了 = 发出去了
          // 没清空：补一次回车 / 再点一次按钮
          pressEnter(input);
          if (btn) { try { btn.click(); } catch (e) {} }
          setTimeout(function () {
            resolve(norm(readInput(input)).indexOf(snippet(text)) < 0);
          }, 800);
        }, 700);
      }, 280);
    });
  }

  /* 「已向BOSS发送消息」浮层里那个「继续沟通」——点它才会进到真正的聊天页 */
  function findContinueButton() {
    var nodes = document.querySelectorAll(
      '[class*="dialog"] a, [class*="dialog"] button, [class*="dialog"] span,' +
      '[class*="popup"] a, [class*="popup"] button, [class*="popup"] span,' +
      '[class*="modal"] a, [class*="modal"] button'
    );
    for (var i = 0; i < nodes.length && i < 50; i++) {
      var t = (nodes[i].textContent || '').replace(/\s/g, '');
      if ((t === '继续沟通' || t === '去聊天' || t === '打开聊天' || t === '马上沟通') && isVisible(nodes[i])) {
        return nodes[i];
      }
    }
    return null;
  }

  function runDetail() {
    if (!/[?&]jr=1/.test(location.search)) return;   // 用户自己浏览，不干预
    var jobId = param('jr_id');
    sessionStorage.setItem('jr_job', jobId);         // 聊天页靠它认领「这是扩展打开的窗口」

    loadConfig().then(function () {
      /* 简历计划里给这个岗位单独生成过话术就用它，否则退回全局话术 */
      var greet = GREETS[jobId] || CFG.greeting || '';
      if (greet) sessionStorage.setItem('jr:greet', greet);
      else sessionStorage.removeItem('jr:greet');

      waitFor(findChatButton, 12000, 350).then(function (btn) {
        if (!btn) return report(jobId, false, '未找到「立即沟通」按钮');

        var label = (btn.textContent || '').replace(/\s/g, '');
        if (/继续沟通/.test(label)) return report(jobId, true, '已在沟通中（跳过）');

        btn.click();

        var t0 = Date.now(), defaultSent = false, done = false;
        var timer = setInterval(function () {
          if (done) return;

          /* ① 跳到聊天页了：话术留在 sessionStorage，交给 runChat 发送 */
          if (location.pathname.indexOf('/chat') >= 0) {
            done = true; clearInterval(timer); return;
          }

          /* ② 「已向BOSS发送消息」浮层只说明站内默认招呼语发出去了，
           *    不代表我们的话术发了 —— 记下来（决定文案用「补发」），继续等输入框 */
          if (findSentToast()) defaultSent = true;

          /* ③ 页内出现了聊天输入框 —— 就在这里把话术发出去。
           *    BOSS 点「立即沟通」会先用站内设置的默认招呼语自动发一条，
           *    这里发的是紧接着的第二条，也就是用户自己的话术。 */
          var input = findChatInput();
          if (input) {
            done = true; clearInterval(timer);
            if (!greet) return report(jobId, true, '已打招呼（这条没填话术）');
            sendGreeting(input, greet).then(function (ok) {
              /* 本页已经处理过，清掉标记，避免跳转后 runChat 再发一遍 */
              sessionStorage.removeItem('jr:greet');
              report(jobId, true, ok
                ? (defaultSent ? '已补发专属话术' : '已发送专属话术')
                : '话术没填进输入框（只发出了默认招呼语）');
            });
            return;
          }

          /* ④ 浮层里给了「继续沟通」入口 —— 点它，让页面跳到聊天页 */
          if (Date.now() - t0 > 1000) {
            var go = findContinueButton();
            if (go) { try { go.click(); } catch (e) {} }
          }

          /* ⑤ 9 秒兜底：如实上报，不谎报「已发送自定义打招呼」 */
          if (Date.now() - t0 > 9000) {
            done = true; clearInterval(timer);
            report(jobId, defaultSent, defaultSent
              ? '只发出了默认招呼语（没找到输入框）'
              : '点了沟通但没抓到输入框，不确定是否投出');
          }
        }, 260);
      });
    });
  }

  /* ================= 聊天页执行器 ================= */
  function runChat() {
    var greeting = sessionStorage.getItem('jr:greet');
    var jobId = sessionStorage.getItem('jr_job') || '';
    /* 没话术 + 没 jr_job 标记 = 用户自己打开的聊天页，不干预 */
    if (!greeting && !jobId) return;
    sessionStorage.removeItem('jr:greet');  // 先清，避免重复发送

    waitFor(findChatInput, 15000, 300).then(function (input) {
      if (!input) {
        sessionStorage.removeItem('jr_job');
        return report(jobId, false, '聊天页没找到输入框');
      }
      if (!greeting) {
        sessionStorage.removeItem('jr_job');
        return report(jobId, true, '已打招呼（这条没填话术）');
      }
      sendGreeting(input, greeting).then(function (ok) {
        sessionStorage.removeItem('jr_job');
        report(jobId, ok, ok ? '已发送专属话术' : '话术没填进输入框（只发出了默认招呼语）');
      });
    });
  }

  /* ================= 启动 ================= */
  function injectPageScript() {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('inject.js');
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.tag !== '__JOBRADAR__') return;
    if (d.type === 'joblist') { diag.net++; ingest(d.payload); }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'jr:done') {
      var job = RUN.current;
      if (job) onDone(job, msg.ok, msg.reason);
    } else if (msg.type === 'jr:workerClosed') {
      if (RUN.active) finishRun('投递窗口被关闭');
    } else if (msg.type === 'jr:startNow') {
      /* 简历页点了「开始投递」，浏览器里已经有一个 BOSS 标签页可以直接当控制器 */
      if (RUN.active) { sendResponse({ ok: false, busy: true }); return; }
      /* 这条路径不会重新加载页面，autoStart 得在这里消费掉，
       * 否则 3 分钟内打开任何 BOSS 页都会再自动投一轮 */
      chrome.storage.local.remove(SK.autoStart);
      chrome.storage.local.get(SK.plan, function (r) {
        if (r[SK.plan]) applyPlan(r[SK.plan], { silent: true });
        startRun();
        sendResponse({ ok: true, active: RUN.active });
      });
      return true;
    }
  });

  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === 'sync' && ch[SK.cfg]) {
      CFG = Object.assign({}, DEFAULT_CFG, ch[SK.cfg].newValue || {});
      /* 简历页/设置页改了节奏 → 正在跑的队列按新节奏走 */
      rescheduleGap();
      rescoreAll();
    }
    if (area === 'local' && ch[SK.applied]) {
      APPLIED = ch[SK.applied].newValue || {};
      paintShell();
    }
    // 别的标签页改了勾选才同步；自己写的跳过，避免列表滚动位置被重置
    if (area === 'local' && ch[SK.picked] && Date.now() - pickWriteAt > 1500) {
      PICKED = ch[SK.picked].newValue || {};
      paintShell();
    }
    // 简历匹配页生成并同步了计划 → 直接落成勾选 + 一对一话术
    if (area === 'local' && ch[SK.plan]) {
      var pl = ch[SK.plan].newValue;
      if (pl && pl.at && (!PLAN || pl.at !== PLAN.at)) applyPlan(pl);
    }
    if (area === 'local' && ch[SK.greets] && Date.now() - pickWriteAt > 1500) {
      GREETS = ch[SK.greets].newValue || {};
      paintList();
    }
    // 详情页/聊天页把结果写进存储，这里兜底消费 —— 即使 background 被休眠也不会卡住
    if (area === 'local' && ch['jr:lastDone']) {
      var p = ch['jr:lastDone'].newValue;
      if (p && RUN.waiting && RUN.current && p.jobId === RUN.current.id) {
        onDone(RUN.current, p.ok, p.reason);
      }
    }
  });

  function boot() {
    var path = location.pathname;
    if (path.indexOf('/job_detail/') >= 0) { runDetail(); return; }
    if (path.indexOf('/chat') >= 0) { runChat(); return; }

    loadConfig().then(function () {
      ensurePanel();
      bindPanel();
      startDomScraper();
      maybeAutoStart();

      // inject.js 已通过 world:"MAIN" 在页面主世界运行，这里只作为兜底：
      // 若 2.5 秒内一个接口响应都没收到，再尝试注入一次（CSP 拦截时无效，但 DOM 兜底照常工作）
      setTimeout(function () {
        if (diag.net === 0) injectPageScript();
      }, 2500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 60); });
  } else {
    setTimeout(boot, 60);
  }
})();
