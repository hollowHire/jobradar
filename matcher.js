/*
 * matcher.js —— 简历 ↔ 岗位 匹配 + 打招呼语生成（不依赖任何大模型）
 *
 * 三个纯函数式模块，浏览器和 Node 都能跑：
 *   1. parseResume(text)      简历文本 → 结构化画像（技能 / 年限 / 学历 / 期望薪资 / 城市 / bullet）
 *   2. scoreJobs(profile, xs) TF-IDF 加权的技能重合度 + 岗位名相似度 → 匹配分 + 命中证据 + 缺口
 *   3. makeGreeting(...)      命中证据 + 简历原句 → 打招呼语（只用简历原话，不改写、不编造）
 *
 * 为什么不用大模型也够用：
 *   匹配本质是「术语重合度」，属检索问题，IDF 加权比模型更稳且可解释；
 *   话术的"具体感"来自被检索出来的简历原句，而不是模型生成的措辞。
 *   代价是：读不出 JD 里的隐性要求（"能扛压""从 0 到 1"），需要人过一眼。
 */
(function (global) {
  'use strict';

  /* ============ 1. 技能词典 ============
   * [标准名, 权重, 别名...]
   * 权重 3 = 高区分度（写出来就是硬通货），2 = 中等，1 = 通用项（到处都有，不该主导排序）
   */
  var SKILLS = [
    /* 前端 */
    ['React', 3, 'react', 'react.js', 'reactjs'],
    ['Vue', 3, 'vue', 'vue.js', 'vuejs', 'vue3', 'vue2'],
    ['Angular', 2, 'angular'],
    ['Svelte', 2, 'svelte'],
    ['Next.js', 3, 'next.js', 'nextjs'],
    ['Nuxt', 2, 'nuxt', 'nuxt.js'],
    ['TypeScript', 3, 'typescript', 'ts'],
    ['JavaScript', 2, 'javascript', 'js', 'es6'],
    ['HTML/CSS', 1, 'html', 'css', 'html5', 'css3', 'sass', 'less', 'scss'],
    ['Tailwind', 2, 'tailwind', 'tailwindcss'],
    ['Webpack', 2, 'webpack'],
    ['Vite', 2, 'vite'],
    ['小程序', 2, '小程序', '微信小程序', 'miniprogram'],
    ['uni-app', 2, 'uniapp', 'uni-app'],
    ['微前端', 3, '微前端', 'qiankun', 'module federation'],
    ['性能优化', 2, '性能优化', '首屏', '懒加载', 'web vitals'],
    ['可视化', 2, '可视化', 'echarts', 'd3', 'three.js', 'webgl', 'canvas'],
    ['Node.js', 2, 'node', 'node.js', 'nodejs', 'express', 'koa', 'nestjs'],
    /* 后端 */
    ['Java', 2, 'java'],
    ['Spring Boot', 2, 'spring boot', 'springboot', 'spring'],
    ['Spring Cloud', 3, 'spring cloud', 'springcloud'],
    ['Go', 3, 'golang', 'go语言', 'go'],
    ['Python', 2, 'python'],
    ['Django', 2, 'django'],
    ['Flask', 2, 'flask'],
    ['FastAPI', 2, 'fastapi'],
    ['PHP', 2, 'php', 'laravel'],
    ['C#/.NET', 2, 'c#', '.net', 'dotnet', 'asp.net'],
    ['Rust', 3, 'rust'],
    ['C++', 2, 'c++', 'cpp'],
    ['微服务', 3, '微服务', 'microservice', '服务治理', 'dubbo'],
    ['分布式', 3, '分布式', '分布式系统', 'consistency', 'raft'],
    ['高并发', 3, '高并发', 'qps', '并发', '秒杀'],
    ['Kafka', 3, 'kafka'],
    ['RabbitMQ', 2, 'rabbitmq', 'mq', '消息队列'],
    ['Redis', 2, 'redis', '缓存'],
    ['MySQL', 2, 'mysql'],
    ['PostgreSQL', 2, 'postgresql', 'postgres', 'pg'],
    ['MongoDB', 2, 'mongodb'],
    ['Elasticsearch', 3, 'elasticsearch', 'es检索'],
    ['gRPC', 3, 'grpc'],
    ['GraphQL', 3, 'graphql'],
    ['RESTful', 1, 'restful', 'rest api', 'openapi'],
    ['系统设计', 3, '系统设计', '架构设计', '技术方案', 'ddd', '领域驱动'],
    /* 数据 / AI */
    ['机器学习', 3, '机器学习', 'machine learning', 'ml'],
    ['深度学习', 3, '深度学习', 'deep learning'],
    ['PyTorch', 3, 'pytorch'],
    ['TensorFlow', 3, 'tensorflow'],
    ['NLP', 3, 'nlp', '自然语言处理', '文本分类', '分词'],
    ['大模型', 3, '大模型', 'llm', 'gpt', '大语言模型'],
    ['RAG', 3, 'rag', '检索增强', '知识库问答'],
    ['Agent', 3, 'agent', '智能体', 'function call', 'mcp'],
    ['Prompt', 2, 'prompt', '提示词'],
    ['向量检索', 3, '向量检索', '向量数据库', 'milvus', 'pgvector', 'faiss', 'embedding', '召回'],
    ['微调', 3, '微调', 'fine-tune', 'finetune', 'lora', 'sft'],
    ['LangChain', 3, 'langchain', 'llamaindex'],
    ['多模态', 3, '多模态', 'multimodal', '文生图', '语音识别'],
    ['计算机视觉', 3, '计算机视觉', 'cv', 'opencv', 'ocr'],
    ['推荐系统', 3, '推荐系统', '召回排序', 'ctr'],
    ['数据挖掘', 2, '数据挖掘', '特征工程'],
    ['Spark', 3, 'spark', 'pyspark'],
    ['Flink', 3, 'flink', '实时计算'],
    ['Hive', 2, 'hive', '数仓', '数据仓库', 'etl'],
    ['SQL', 1, 'sql', 'hql'],
    ['Pandas', 2, 'pandas', 'numpy'],
    ['数据分析', 2, '数据分析', '数据看板', 'bi', 'tableau', 'powerbi'],
    ['指标体系', 2, '指标体系', '埋点', '数据埋点'],
    ['A/B 测试', 2, 'a/b', 'abtest', 'ab test', '实验平台'],
    /* 移动 */
    ['Android', 3, 'android', '安卓'],
    ['iOS', 3, 'ios', 'objective-c', 'swift'],
    ['Kotlin', 2, 'kotlin'],
    ['Flutter', 3, 'flutter', 'dart'],
    ['React Native', 3, 'react native', 'rn'],
    ['鸿蒙', 3, '鸿蒙', 'harmonyos', 'arkts'],
    /* 运维 / 工程效能 */
    ['Docker', 2, 'docker', '容器化'],
    ['Kubernetes', 3, 'kubernetes', 'k8s'],
    ['CI/CD', 2, 'ci/cd', 'cicd', '流水线', 'jenkins', 'gitlab ci', 'github actions'],
    ['Linux', 1, 'linux', 'shell', 'bash'],
    ['Nginx', 2, 'nginx'],
    ['云服务', 2, 'aws', '阿里云', '腾讯云', 'azure', 'gcp', '云原生'],
    ['监控告警', 2, '监控', 'prometheus', 'grafana', '可观测'],
    ['自动化测试', 2, '自动化测试', 'selenium', 'playwright', 'cypress', 'pytest'],
    ['性能测试', 2, '性能测试', '压测', 'jmeter', 'locust'],
    /* 产品 / 运营 / 设计 */
    ['需求分析', 2, '需求分析', '需求评审', '用户需求'],
    ['PRD', 2, 'prd', '产品文档', '需求文档'],
    ['用户研究', 2, '用户研究', '用户访谈', '可用性测试'],
    ['竞品分析', 2, '竞品分析', '竞品'],
    ['数据驱动', 2, '数据驱动', '数据决策'],
    ['增长', 3, '增长', 'growth', '拉新', '留存', '转化率'],
    ['用户增长', 3, '用户增长', 'aarrr'],
    ['私域', 3, '私域', '社群', '企微', 'sop'],
    ['内容运营', 2, '内容运营', '选题', '种草', '小红书'],
    ['SEO', 3, 'seo', '搜索优化', '关键词排名'],
    ['SEM', 2, 'sem', '信息流', '投放', '巨量', 'adwords'],
    ['电商', 2, '电商', '店铺', 'sku', '供应链', 'gmv'],
    ['项目管理', 2, '项目管理', 'pmp', '排期', '里程碑'],
    ['Figma', 2, 'figma'],
    ['交互设计', 2, '交互设计', '原型', 'axure', 'sketch'],
    ['视觉设计', 2, '视觉设计', 'ui设计', 'photoshop', 'illustrator'],
    /* 行业 / 场景 */
    ['SaaS', 2, 'saas', 'b端', 'to b', '企业服务'],
    ['C端', 2, 'c端', 'to c', '用户端'],
    ['支付', 2, '支付', '清结算', '对账', '交易'],
    ['金融', 2, '金融', '风控', '信贷', '证券'],
    ['出海', 2, '出海', '海外', '跨境', '国际化'],
    ['AI 应用', 3, 'ai应用', 'ai 应用', 'ai产品', 'ai 产品'],
    /* 通用 */
    ['团队管理', 2, '团队管理', '带团队', 'leader', '管理团队', '10人'],
    ['跨部门协作', 1, '跨部门', '协作', '沟通'],
    ['英语', 1, '英语', 'english', 'cet-6', '雅思', 'toefl'],
    ['敏捷开发', 1, '敏捷', 'scrum', '迭代'],
    ['从 0 到 1', 2, '从0到1', '从 0 到 1', '0-1', 'zero to one']
  ];

  var CANON = {};
  for (var si = 0; si < SKILLS.length; si++) {
    var row = SKILLS[si];
    CANON[row[0]] = { w: row[1], aliases: row.slice(2) };
  }

  /* 太泛的词不该参与匹配，否则"沟通""协作"会把所有岗位拉平 */
  var STOP = { '沟通': 1, '协作': 1, '负责': 1, '熟悉': 1, '了解': 1, '掌握': 1, '良好': 1, '优先': 1 };

  var CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州',
    '长沙', '郑州', '天津', '重庆', '厦门', '青岛', '合肥', '济南', '福州', '宁波',
    '东莞', '佛山', '无锡', '沈阳', '大连', '昆明', '南昌', '贵阳', '石家庄', '哈尔滨'];

  var ROLE_WORDS = ['前端', '后端', '服务端', '全栈', '客户端', '算法', '数据', '数据科学', '产品',
    '运营', '设计', '测试', '运维', '架构', '安全', '增长', '市场', '项目管理', 'AI'];

  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  function hasAlias(text, alias) {
    var a = lower(alias);
    if (!a) return false;
    // 纯 ASCII 别名加边界判断，避免 "go" 命中 "good"、"js" 命中 "json"
    if (/^[a-z0-9 .+#/-]+$/.test(a) && a.length <= 4) {
      var re = new RegExp('(^|[^a-z0-9+#.])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9+#]|$)');
      return re.test(text);
    }
    return text.indexOf(a) >= 0;
  }

  /* 从任意文本里认出技能（返回标准名数组，按出现顺序去重） */
  function findSkills(text) {
    var t = lower(text);
    var out = [];
    var seen = {};
    for (var k in CANON) {
      if (STOP[k]) continue;
      var aliases = CANON[k].aliases;
      var hit = false;
      for (var i = 0; i < aliases.length; i++) {
        if (hasAlias(t, aliases[i])) { hit = true; break; }
      }
      if (hit && !seen[k]) { seen[k] = 1; out.push(k); }
    }
    return out;
  }

  /* ============ 2. 简历解析 ============ */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\r/g, '')
      .replace(/[\u3000\t]/g, ' ')
      .replace(/[·•●▪]/g, '·');
  }

  var SECTION_WORDS = /^(工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|技能|专业技能|个人简介|自我评价|求职意向|实习|获奖|证书|培训|职业规划|联系方式|个人信息)[:：]?$/;

  function splitBullets(text) {
    var lines = text.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim().replace(/^[-*·•\d.、)\s]+/, '');
      if (l.length < 8 || l.length > 160) continue;
      if (SECTION_WORDS.test(l)) continue;
      if (/^[\d\s\-年月./至~—]+$/.test(l)) continue;          // 纯时间行
      if (/^(电话|邮箱|手机|微信|年龄|性别|籍贯|政治面貌)/.test(l)) continue;
      if (/@[\w.-]+\.\w+/.test(l) || /1[3-9]\d{9}/.test(l)) continue;  // 联系方式
      /* 头部信息不能当"工作成果"引用，否则话术里会出现「我之前求职意向：…」 */
      if (/^(求职意向|期望职位|期望城市|应聘岗位|目标岗位|个人信息)/.test(l)) continue;
      if (/求职意向|期望职位|期望薪资|期望城市/.test(l)) continue;
      if (/大学|学院|本科|硕士|博士|大专|学历/.test(l)) continue;
      if (/^(教育|工作|项目|技能|实习|获奖|证书)[\u4e00-\u9fa5]{0,4}[:：]?$/.test(l)) continue;
      out.push(l);
    }
    return out;
  }

  /* 只切「工作经历」这一段来算年限 —— 否则教育经历里的 2013-2017 会被当成工作年数 */
  function workSeg(text) {
    var m = text.search(/工作经历|工作经验|职业经历|任职经历|实习经历/);
    if (m < 0) return text;
    var rest = text.slice(m);
    var e = rest.slice(1).search(/教育经历|教育背景|项目经历|项目经验|专业技能|技能清单|自我评价|获奖情况/);
    return e > 0 ? rest.slice(0, e + 1) : rest;
  }

  function parseYears(text) {
    /* ① 明写 "3年经验" */
    var explicit = 0;
    var m = text.match(/(\d{1,2}(?:\.\d)?)\s*年(?:以上)?(?:工作)?经验/);
    if (m) explicit = parseFloat(m[1]);

    /* ② 日期区间累加（2019.07-2023.05） */
    var seg = workSeg(text);
    var re = /(20\d{2})\s*[.\-/年]?\s*(\d{1,2})?\s*(?:-|~|—|至|到)\s*((?:20\d{2})|至今|现在)/g;
    var months = 0, hit;
    while ((hit = re.exec(seg)) !== null) {
      var sy = +hit[1], sm = hit[2] ? +hit[2] : 1;
      var ey, em;
      if (/至今|现在/.test(hit[3])) {
        var d = new Date();
        ey = d.getFullYear(); em = d.getMonth() + 1;
      } else {
        ey = +hit[3];
        var after = seg.slice(re.lastIndex, re.lastIndex + 6).match(/^\s*[.\-/年]?\s*(\d{1,2})/);
        em = after ? +after[1] : 12;
      }
      var span = (ey - sy) * 12 + (em - sm);
      if (span > 0 && span < 360) months += span;
    }
    var computed = Math.min(30, Math.round(months / 12 * 10) / 10);
    return Math.max(explicit, computed, 0);
  }

  function parseDegree(text) {
    if (/博士|phd|doctor/i.test(text)) return '博士';
    if (/硕士|研究生|master|mba/i.test(text)) return '硕士';
    if (/本科|学士|bachelor/i.test(text)) return '本科';
    if (/大专|专科|高职/i.test(text)) return '大专';
    return '';
  }

  function parseExpectSalary(text) {
    /* 按行找，只认「期望/意向/薪资要求」这些行 —— 否则会把工作经历里的薪资当期望 */
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!/期望|意向薪资|薪资要求|目标薪资|期望薪资/.test(l)) continue;
      var m = l.match(/(\d{1,3})\s*[-~到至]\s*(\d{1,3})\s*[kK千]/);
      if (m) return { min: +m[1], max: +m[2] };
      m = l.match(/(\d{1,3})\s*[kK千]\s*(?:以上|\+)/);
      if (m) return { min: +m[1], max: Math.round(+m[1] * 1.4) };
    }
    return null;
  }

  function parseCity(text) {
    for (var i = 0; i < CITIES.length; i++) if (text.indexOf(CITIES[i]) >= 0) return CITIES[i];
    return '';
  }

  /* 岗位方向：从「求职意向」那行取；没有就退化成技能词。
   * 刻意用最短匹配 —— 宁可得到「前端工程师」，也不要「星野智能 高级前端工程师」这种连公司一起吞进去的串 */
  var TITLE_RE = /(?:高级|资深|初级|首席)?[A-Za-z\u4e00-\u9fa5]{1,5}?(?:工程师|开发|经理|专家|主管|总监|架构师|设计师|运营|研究员)/g;

  function guessTitles(text, skills) {
    var lines = String(text).split('\n');
    var out = [];

    lines.forEach(function (l) {
      if (!/求职意向|期望职位|应聘岗位|目标岗位/.test(l)) return;
      /* 先按：切开，再按分隔符拆段 —— 这样「AI 应用工程师」不会被截成「应用工程师」 */
      var seg = l.replace(/^.*?[：:]/, '');
      seg.split(/[，,、/|｜]|\s{2,}|\t/).forEach(function (part) {
        var t = part.replace(/[（(][^）)]*[）)]/g, '').trim();
        if (!t || t.length > 16) return;
        if (!new RegExp(TITLE_RE.source).test(t)) return;
        out.push(t);
      });
      if (!out.length) (l.match(TITLE_RE) || []).forEach(function (t) { out.push(t); });
    });

    if (!out.length) {
      for (var i = 0; i < lines.length && i < 12; i++) {
        var l = lines[i].trim();
        if (l.length > 40) continue;
        var m = l.match(TITLE_RE);
        if (m && m.length) { out = out.concat(m.slice(0, 2)); break; }
      }
    }

    var seen = {}, res = [];
    out.concat(skills.slice(0, 3)).forEach(function (x) {
      var t = String(x || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 16 && !seen[t]) { seen[t] = 1; res.push(t); }
    });
    return res.slice(0, 5);
  }

  function parseResume(rawText) {
    var text = norm(rawText);
    var plain = text.replace(/\n/g, ' ');
    var skills = findSkills(plain);
    var bullets = splitBullets(text).map(function (b) {
      return { text: b, skills: findSkills(b) };
    });
    return {
      raw: text,
      skills: skills,
      bullets: bullets,
      years: parseYears(text),
      degree: parseDegree(text),
      expect: parseExpectSalary(text),
      city: parseCity(text),
      titles: guessTitles(text, skills),
      chars: text.length
    };
  }

  /* ============ 3. 匹配（TF-IDF 加权重合度） ============ */
  function jobTerms(job) {
    var text = [job.title, (job.labels || []).join(' '), job.jd || '', job.industry || ''].join(' ');
    var set = {};
    findSkills(text).forEach(function (s) { set[s] = 1; });
    /* 词典之外的标签（行业黑话每天都在长）按原文当术语，权重略低 */
    (job.labels || []).forEach(function (l) {
      var t = String(l || '').trim();
      if (!t || t.length > 12) return;
      if (findSkills(t).length) return;      // 已能被词典识别
      if (STOP[t]) return;
      set['#' + t] = 1;
    });
    return Object.keys(set);
  }

  function termWeight(term, jobTextLower) {
    if (term.charAt(0) === '#') return 1.6;   // 词典外的岗位标签
    var c = CANON[term];
    return c ? c.w : 1;
  }

  function bigrams(s) {
    var t = String(s || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
    var out = {};
    for (var i = 0; i < t.length - 1; i++) out[t.slice(i, i + 2)] = 1;
    return Object.keys(out);
  }

  function titleAffinity(jobTitle, profile) {
    var jb = bigrams(jobTitle);
    if (!jb.length) return 0;
    var mine = {};
    bigrams(profile.titles.join(' ')).forEach(function (b) { mine[b] = 1; });
    bigrams(profile.skills.join(' ')).forEach(function (b) { mine[b] = 1; });
    var hit = 0;
    jb.forEach(function (b) { if (mine[b]) hit++; });
    return hit / jb.length;
  }

  /**
   * scoreJobs(profile, jobs) → 新的数组，每项 { …job, match, hits, gaps, flags }
   * 匹配分构成：技能重合 62% + 岗位名相似 38%，再按硬性条件扣分（不直接淘汰，交给人看）
   */
  function scoreJobs(profile, jobs) {
    var N = jobs.length || 1;
    var termsOf = jobs.map(jobTerms);

    /* 语料内 IDF：越少见的词越能区分岗位 */
    var df = {};
    termsOf.forEach(function (ts) {
      ts.forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    function idf(t) { return Math.log(1 + N / (1 + (df[t] || 1))); }

    var mine = {};
    profile.skills.forEach(function (s) { mine[s] = 1; });
    var rawLower = lower(profile.raw);

    var out = jobs.map(function (job, i) {
      var terms = termsOf[i];
      var totalW = 0, hitW = 0, hits = [], gaps = [];

      terms.forEach(function (t) {
        var w = idf(t) * termWeight(t, '');
        totalW += w;
        var has = t.charAt(0) === '#'
          ? rawLower.indexOf(t.slice(1).toLowerCase()) >= 0
          : !!mine[t];
        if (has) { hits.push({ k: t, w: Math.round(w * 10) / 10 }); hitW += w; }
        else gaps.push({ k: t, w: Math.round(w * 10) / 10 });
      });

      var coverage = totalW > 0 ? hitW / totalW : 0;
      var tAff = titleAffinity(job.title, profile);

      var score = 100 * (0.62 * coverage + 0.38 * tAff);

      /* 硬性条件：扣分 + 打标，不做静默淘汰 */
      var flags = [];
      var need = String(job.exp || '').match(/(\d{1,2})\s*[-~]?\s*(\d{1,2})?年/);
      if (need) {
        var needMin = +need[1];
        if (profile.years && needMin > profile.years + 1.5) {
          flags.push('要求 ' + needMin + ' 年经验，简历约 ' + profile.years + ' 年');
          score -= 8;
        }
      }
      var degRank = { '': 0, '大专': 1, '本科': 2, '硕士': 3, '博士': 4 };
      if (/硕士/.test(job.degree || '') && degRank[profile.degree] < 3) {
        flags.push('岗位要求硕士');
        score -= 6;
      }
      if (profile.expect && job.sal && job.sal.max < profile.expect.min) {
        flags.push('薪资低于期望 ' + profile.expect.min + 'K');
        score -= 5;
      }

      hits.sort(function (a, b) { return b.w - a.w; });
      gaps.sort(function (a, b) { return b.w - a.w; });

      return Object.assign({}, job, {
        match: Math.max(5, Math.min(98, Math.round(score))),
        coverage: Math.round(coverage * 100),
        titleAff: Math.round(tAff * 100),
        hits: hits,
        gaps: gaps,
        flags: flags
      });
    });

    return out.sort(function (a, b) { return b.match - a.match; });
  }

  /* ============ 4. 打招呼语生成 ============ */
  function hash(s) {
    var h = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  /* 把简历原句压到能塞进聊天框的长度。
   * 优先取「带数字/结果」的那一句 —— HR 在意的不是职责，是结果；
   * 拼不上（超长）就退化成第一句。 */
  function trimBullet(s, max) {
    max = max || 50;
    var t = String(s).replace(/^(负责|参与|主导|独立完成|完成了?|做了|从零)/, '').trim();
    var clauses = t.replace(/[。；;]$/, '').split(/[，,；;]/)
      .map(function (x) { return x.trim(); }).filter(Boolean);
    if (!clauses.length) return t.slice(0, max);

    var numIdx = -1;
    for (var i = 0; i < clauses.length; i++) {
      if (/\d/.test(clauses[i]) && /(s\b|ms|%|万|倍|k\b|qps|人|个|条|单|天)/i.test(clauses[i])) { numIdx = i; break; }
    }
    if (numIdx > 0 && (clauses[numIdx - 1] + '，' + clauses[numIdx]).length <= max) {
      return clauses[numIdx - 1] + '，' + clauses[numIdx];
    }
    if (numIdx >= 0 && clauses[numIdx].length <= max) return clauses[numIdx];

    var first = clauses[0];
    if (first.length <= max) return first;
    var cut = first.slice(0, max);
    var p = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'));
    if (p > max * 0.6) cut = cut.slice(0, p);
    return cut.replace(/[，,、]$/, '') + '…';
  }

  function endPunct(b) {
    return /[…。！？；]$/.test(b) ? b : b + '。';
  }

  function bestBullet(profile, skill) {
    var found = null;
    profile.bullets.forEach(function (b) {
      if (found) return;
      if (b.skills.indexOf(skill) >= 0) found = b;
    });
    if (!found) return null;
    return trimBullet(found.text);
  }

  /* 结尾统一「表达兴趣 + 请求沟通」，不再反问团队人数 / 分工 / 最急的事。
   * 理由：打招呼的目的是换到一句回复，不是做需求调研；
   * 反问越多，HR 越需要动脑组织答案，回复率越低。 */
  var Q_CLOSE = [
    '挺感兴趣，方便聊聊吗？',
    '这个岗位我挺感兴趣的，能聊两句吗？',
    '看着挺对口的，方便聊聊吗？',
    '感兴趣，想和您聊两句。',
    '这个方向我挺感兴趣，方便的话聊两句？',
    '感觉挺合适的，方便聊聊吗？',
    '挺想试试这个岗位，能聊两句吗？',
    '有兴趣，方便的话聊两句。'
  ];

  /**
   * makeGreeting(profile, job, idx)
   * 只用简历里的原句做证据：句句有出处，编不出假经历 —— 这是不用大模型带来的附加好处。
   */
  function makeGreeting(profile, job, idx) {
    idx = idx || 0;
    var hits = (job.hits || []).filter(function (h) { return h.k.charAt(0) !== '#'; });
    /* 一个都没命中就别硬蹭：宁可用「我是做 X 的」这种大白话，也别把不相关的技能说成"我手上的活" */
    var skillA = hits[0] ? hits[0].k : '';
    var skillB = hits[1] ? hits[1].k : '';
    if (!skillA) skillB = '';
    var bulletA = skillA ? bestBullet(profile, skillA) : null;
    var bulletB = skillB && skillB !== skillA ? bestBullet(profile, skillB) : null;

    var q = Q_CLOSE[hash(job.id || job.title) % Q_CLOSE.length];

    var skillStr = skillA ? (skillB && skillB !== skillA ? skillA + '、' + skillB : skillA) : '';

    var T = [
      /* 0 直接给证据 */
      function () {
        return (skillStr ? '你好，看到岗位要' + skillStr + '。' : '你好，') +
          (bulletA ? '我在之前项目里' + endPunct(bulletA) : '') + q;
      },
      /* 1 命中感更强 */
      function () {
        return '你好，投的是' + (job.title || '这个岗位') + (skillA ? '，' + skillA + '是我手上的活' : '') + '。' +
          (bulletA ? endPunct(bulletA) : '') + q;
      },
      /* 2 两段证据 */
      function () {
        return '你好，' + (skillStr ? skillStr + '都做过：' : '') +
          (bulletA ? endPunct(bulletA) : '') + (bulletB ? '另外' + endPunct(bulletB) : '') + q;
      },
      /* 3 求对话 */
      function () {
        return '你好，看到' + (skillStr || job.title || '这个岗位') + '这块，' +
          (bulletA ? '我之前' + endPunct(bulletA) : '我做过类似的事。') + q;
      },
      /* 4 克制型 */
      function () {
        return '你好，' + (bulletA ? endPunct(bulletA) : '') +
          (skillStr ? '对' + skillStr + '这块还算熟。' : '') + q;
      }
    ];

    var fn = T[(hash(job.id || job.title) + idx) % T.length];
    var text = fn();

    /* 兜底：一条证据都没有时，别硬编，说人话 */
    if (!bulletA) {
      text = '你好，' + (job.title || '这个岗位') + '这个岗位' +
        (profile.titles[0] ? '，我做' + profile.titles[0] + '这块' : '') +
        (profile.years ? '约 ' + profile.years + ' 年' : '') + '。' + q;
    }

    /* 收紧空白：英文术语之间留一个空格（AI Agent 不能变成 AIAgent），
     * 中文标点前后的空格去掉，连续句号合并；
     * 中英文交界处补一个空格（「投的是AI Agent」→「投的是 AI Agent」），排版更像人写的 */
    text = text.replace(/\s+/g, ' ')
      .replace(/\s+([，。、；：！？）])/g, '$1')
      .replace(/([（])\s+/g, '$1')
      .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2')
      .replace(/。{2,}/g, '。')
      .replace(/…。/g, '…')
      .trim();

    if (text.length > 170) {
      var i = text.indexOf('。', 60);
      text = i > 0 ? text.slice(0, i + 1) + q : text.slice(0, 168) + '…';
    }
    return text;
  }

  /* 从简历里提炼搜索词：岗位方向为主，技能为辅 */
  function suggestQueries(profile, n) {
    n = n || 3;
    var out = [];
    profile.titles.forEach(function (t) {
      if (out.length < n && t.length >= 2 && t.length <= 12) out.push(t);
    });
    /* 最高区分度的两三个技能，和一个方向词组合 */
    profile.skills.slice(0, 4).forEach(function (s) {
      if (out.length < n) out.push(s);
    });
    return out.slice(0, n);
  }

  /* ============ 4. 搜索词相关性 ============
   * 「这条岗位算不算这个搜索词的范围」—— 面板和简历页都要判，放在这里共用一份，
   * 免得两边各写一套又慢慢跑偏。
   *
   * 为什么要别名：用户搜「前线部署工程师」，岗位标题写「FDE」；搜「FDE」，
   * 岗位又写成「交付工程师」。只做字符串包含，两边都会判错。
   * 为什么不能只看抓取时记的搜索词：BOSS 自己的召回很松，同一个词的列表里会混进
   * 「猜你喜欢」这类结果，光看来源会把无关岗位也算进来。
   */
  var ROLE_SUFFIX = /(工程师|专家|经理|专员|顾问|助理|主管|总监|负责人|实习生|学徒)$/;
  var GENERIC_TERM = /^(工程师|专家|经理|专员|顾问|助理|主管|总监|负责人|高级|资深|中级|初级|开发|研发|岗位|职位|实习|全职|兼职|工作)$/;
  /* 中文长词切出来的 2 字片段里，这些太泛，留着会误伤 */
  var NG_GENERIC = /^(工程|程师|开发|研发|技术|管理|设计|运营|产品|销售|服务|支持|助理|专员|顾问|专家|经理|主管|总监|负责|实习|全职|兼职|高级|资深|初级|岗位|职位)$/;
  /* 缩写 ↔ 中文互认（一个组里的词互相等价） */
  var ACRO_GROUPS = [
    ['fde', '前线部署', '现场部署', '部署工程师', '交付工程师', '实施工程师', '解决方案', '技术支持', '售前', '客户成功', 'field engineer'],
    ['agent', 'ai agent', '智能体', '大模型', 'llm', 'ai 应用'],
    ['llm', '大模型', 'llm', '语言模型', '智能体', 'rag'],
    ['ai', 'ai', '人工智能', '智能体', '算法'],
    ['saas', 'saas', '企业服务', '解决方案'],
    ['qa', '测试', 'qa', 'qe', '质量', '测试开发', '自动化测试'],
    ['pm', '产品经理', '产品', 'pm'],
    ['fe', '前端', 'frontend', 'web前端'],
    ['be', '后端', 'backend', '服务端', 'java', 'go语言'],
    ['devops', '运维', 'devops', 'sre'],
    ['ui', 'ui', '视觉设计', '交互设计'],
    ['ux', 'ux', '交互设计', '用户体验'],
    ['bd', '商务', 'bd', '销售'],
    ['hr', '人力资源', 'hr', '招聘'],
    ['erp', 'erp', '企业资源计划'],
    ['crm', 'crm', '客户关系管理']
  ];

  /* 把一个搜索词展开成「等价写法」列表：原词、去掉职级后缀的词、2 字片段、缩写互认 */
  function queryAliases(q) {
    var raw = String(q || '').trim();
    if (!raw) return [];
    var out = [];
    function push(s) {
      s = String(s || '').trim().toLowerCase();
      if (s.length < 2 || GENERIC_TERM.test(s) || out.indexOf(s) >= 0) return;
      out.push(s);
    }
    function expand(tok) {
      push(tok);
      var base = tok.replace(ROLE_SUFFIX, '');
      if (base !== tok) push(base);
      if (/[\u4e00-\u9fa5]{4,}/.test(tok)) {
        for (var i = 0; i + 2 <= tok.length; i++) {
          var ng = tok.slice(i, i + 2);
          if (!NG_GENERIC.test(ng)) push(ng);
        }
      }
      /* 缩写 ↔ 中文互认分两个方向，力度不一样：
       * 搜「FDE」（英文缩写）→ 可以放宽到「交付/实施/解决方案」这些中文写法，
       *   因为用户用缩写时本来就接受这些岗位；
       * 搜「前线部署工程师」（中文全称）→ 只认自己这一串 + 缩写 FDE，
       *   不往「实施/售前」这些相邻岗位上扩，否则会把一堆不相关的又捞回来。 */
      var isAscii = /^[a-z0-9 .#+\-]+$/.test(tok);
      for (var g = 0; g < ACRO_GROUPS.length; g++) {
        var group = ACRO_GROUPS[g];
        var hit = false;
        for (var k = 0; k < group.length && !hit; k++) {
          var w = group[k];
          if (tok.indexOf(w) >= 0 || (tok.length >= 2 && w.indexOf(tok) >= 0)) hit = true;
        }
        if (!hit) continue;
        if (isAscii) group.forEach(push);
        else push(group[0]);
      }
    }
    raw.toLowerCase().split(/[\s,，、/|·+;；（）()]+/).filter(Boolean).forEach(expand);
    return out;
  }

  function hitAlias(hay, a) {
    /* 两三个字母的缩写要按「词」比，否则 email 里的 ai、campaign 里的 pm 都会误命中 */
    if (/^[a-z0-9.#+\-]{1,3}$/.test(a)) {
      var re = new RegExp('(^|[^a-z0-9])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
      return re.test(hay);
    }
    return hay.indexOf(a) >= 0;
  }

  /* 这条岗位的标题/标签里，有没有搜索词的任何一种写法 */
  function relevant(job, q) {
    if (!job) return true;
    var aliases = queryAliases(q);
    if (!aliases.length) return true;
    var hay = [
      job.title || '',
      (job.labels || []).join(' '),
      (job.skills || []).join(' '),
      job.industry || ''
    ].join(' ').toLowerCase();
    if (!hay.trim()) return true;      // 什么都没抓到，判不了，别乱排除
    for (var i = 0; i < aliases.length; i++) {
      if (hitAlias(hay, aliases[i])) return true;
    }
    return false;
  }

  var API = {
    findSkills: findSkills,
    queryAliases: queryAliases,
    relevant: relevant,
    parseResume: parseResume,
    scoreJobs: scoreJobs,
    makeGreeting: makeGreeting,
    trimBullet: trimBullet,
    suggestQueries: suggestQueries,
    SKILLS: SKILLS,
    versions: '0.8.0'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.JRMatcher = API;
})(typeof window !== 'undefined' ? window : globalThis);
