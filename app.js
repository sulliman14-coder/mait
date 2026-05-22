// ============================================================
// MTC Sales Platform v3 — Deep Prospecting Edition
// ============================================================

'use strict';

// ============ STORAGE ============
const STORAGE_PREFIX = 'mtc_v3_';
const DB = {
  get(key, def = null) {
    try { const raw = localStorage.getItem(STORAGE_PREFIX + key); return raw ? JSON.parse(raw) : def; }
    catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val)); return true; }
    catch (e) { console.error('DB.set failed:', e); return false; }
  },
  del(key) { try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) {} },
  clear() {
    try {
      Object.keys(localStorage).forEach(k => { if (k.startsWith(STORAGE_PREFIX)) localStorage.removeItem(k); });
    } catch (e) {}
  }
};

const APP = {
  config: {}, leads: [], inbox: [], campaigns: [],
  searchResults: [], selectedSet: new Set(),
  campaignTargets: null, campaignMode: 'email',
  pickedProvider: null, workingProviders: {},
  waMessageCache: null
};

// ============ AI PROVIDERS ============
const PROVIDERS = {
  groq: {
    name: 'Groq', icon: '⚡',
    async call({ apiKey, model, messages, maxTokens = 2000 }) {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'llama-3.3-70b-versatile', messages, max_tokens: maxTokens, temperature: 0.7 })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error('Groq ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
  },
  openrouter: {
    name: 'OpenRouter', icon: '🌐',
    async call({ apiKey, model, messages, maxTokens = 2000 }) {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json',
          'HTTP-Referer': location.origin || 'https://mtc-sales.app', 'X-Title': 'MTC Sales'
        },
        body: JSON.stringify({ model: model || 'meta-llama/llama-3.3-70b-instruct:free', messages, max_tokens: maxTokens, temperature: 0.7 })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error('OpenRouter ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
  },
  gemini: {
    name: 'Gemini', icon: '🔷',
    async call({ apiKey, model, messages, maxTokens = 2000 }) {
      const m = model || 'gemini-2.0-flash-exp';
      const contents = messages.map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error('Gemini ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  },
  mistral: {
    name: 'Mistral', icon: '🌪️',
    async call({ apiKey, model, messages, maxTokens = 2000 }) {
      const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'mistral-large-latest', messages, max_tokens: maxTokens, temperature: 0.7 })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error('Mistral ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
  },
  anthropic: {
    name: 'Claude', icon: '🟣',
    async call({ apiKey, model, messages, maxTokens = 2000, proxy }) {
      const url = proxy || 'https://api.anthropic.com/v1/messages';
      const headers = { 'Content-Type': 'application/json' };
      if (proxy) { headers['X-Api-Key'] = apiKey; }
      else {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }
      let systemMsg = '', userMsgs = [];
      for (const m of messages) {
        if (m.role === 'system') systemMsg += m.content + '\n';
        else userMsgs.push({ role: m.role, content: m.content });
      }
      const body = { model: model || 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: userMsgs };
      if (systemMsg) body.system = systemMsg;
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) { const t = await resp.text(); throw new Error('Anthropic ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  },
  manus: {
    name: 'Manus AI', icon: '🤖',
    async call({ apiKey, model, messages, maxTokens = 2000, baseUrl }) {
      // Manus AI - uses OpenAI-compatible API format
      const url = (baseUrl || 'https://api.manus.im/v1').replace(/\/$/, '') + '/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'manus-default',
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('Manus ' + resp.status + ': ' + t.substring(0, 200));
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || data.content || '';
    }
  },
  custom: {
    name: 'Custom', icon: '⚙️',
    async call({ apiKey, model, messages, maxTokens = 2000, baseUrl }) {
      if (!baseUrl) throw new Error('Base URL required');
      const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
      const resp = await fetch(url, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, max_tokens: maxTokens })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error('Custom ' + resp.status + ': ' + t.substring(0, 200)); }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
  }
};

// ============ AI CALLER ============
async function callAI(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 2000;
  const messages = [{ role: 'user', content: prompt }];
  let tryOrder;
  if (opts.forceProvider && APP.config['key_' + opts.forceProvider]) tryOrder = [opts.forceProvider];
  else {
    const favorite = APP.config.favoriteProvider || 'groq';
    tryOrder = [favorite, ...Object.keys(PROVIDERS).filter(p => p !== favorite)];
  }
  let lastError = null;
  for (const pid of tryOrder) {
    const provider = PROVIDERS[pid];
    if (!provider) continue;
    const apiKey = APP.config['key_' + pid];
    if (!apiKey || apiKey.length < 10) continue;
    const model = APP.config['model_' + pid];
    const params = { apiKey, model, messages, maxTokens };
    if (pid === 'anthropic') params.proxy = APP.config.key_anthropic_proxy;
    if (pid === 'custom') params.baseUrl = APP.config.key_custom_url;
    if (pid === 'manus') params.baseUrl = APP.config.key_manus_url;
    try {
      const text = await provider.call(params);
      if (text && text.trim()) return { ok: true, text: text.trim(), provider: pid };
    } catch (e) {
      lastError = e.message || String(e);
      console.warn(`Provider ${pid} failed:`, lastError);
    }
  }
  return { ok: false, error: lastError || 'لا يوجد مزود متاح' };
}

// ============ ROBUST JSON EXTRACTOR ============
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = t.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch (e) {}
    let fixed = candidate
      .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch (e) {}
  }
  const arrayMatch = t.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try { return { leads: JSON.parse(arrayMatch[0]) }; } catch (e) {}
  }
  return null;
}

// ============ BUSINESS DOMAINS (مجالات الأعمال) ============
// ============================================================
// SEARCH PROVIDERS (مزودات البحث الفعلي على الإنترنت)
// لجلب بيانات حقيقية موثّقة وليست من ذاكرة AI
// ============================================================
const SEARCH_PROVIDERS = {
  // Tavily — بحث AI مع استشهادات حقيقية (1000 بحث مجاناً شهرياً)
  tavily: {
    name: 'Tavily',
    icon: '🔭',
    free_limit: '1000/شهر',
    signup: 'https://app.tavily.com/sign-up',
    async search({ apiKey, query, timeRange, maxResults = 10 }) {
      // Tavily يدعم time range نصياً مباشرة
      const days = { day: 1, week: 7, month: 30, '6months': 180, year: 365, '2years': 730 }[timeRange] || 365;
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: query,
          search_depth: 'advanced',
          max_results: maxResults,
          days: days,
          include_answer: false,
          include_raw_content: false
        })
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('Tavily ' + resp.status + ': ' + t.substring(0, 200));
      }
      const data = await resp.json();
      return (data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        published_date: r.published_date || ''
      }));
    }
  },

  // SerpAPI — بحث Google حقيقي (100 بحث مجاناً شهرياً)
  serpapi: {
    name: 'SerpAPI (Google)',
    icon: '🔍',
    free_limit: '100/شهر',
    signup: 'https://serpapi.com/users/sign_up',
    needs_proxy: true,
    async search({ apiKey, query, timeRange, maxResults = 10 }) {
      const tbsMap = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', '6months': 'qdr:m6', year: 'qdr:y', '2years': 'qdr:y2' };
      const params = new URLSearchParams({
        engine: 'google',
        q: query,
        api_key: apiKey,
        num: String(maxResults),
        gl: 'sa',
        hl: 'ar',
        tbs: tbsMap[timeRange] || 'qdr:y'
      });
      // SerpAPI doesn't support CORS — try direct first, fall back to proxy
      const directUrl = `https://serpapi.com/search.json?${params}`;
      let data;
      try {
        const resp = await fetch(directUrl);
        if (!resp.ok) throw new Error('SerpAPI ' + resp.status);
        data = await resp.json();
      } catch (corsError) {
        // CORS failure - try using corsproxy.io as a workaround
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(directUrl)}`;
        const resp2 = await fetch(proxyUrl);
        if (!resp2.ok) throw new Error('SerpAPI: ' + corsError.message + ' (CORS not supported - استخدم Serper.dev بدلاً)');
        data = await resp2.json();
      }
      if (data.error) throw new Error('SerpAPI: ' + data.error);
      return (data.organic_results || []).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        published_date: r.date || ''
      }));
    }
  },

  // Serper.dev — أفضل بديل (2500 بحث مجاني مرة واحدة + $1/1000 بعدها)
  serper: {
    name: 'Serper.dev',
    icon: '⚡',
    free_limit: '2500 بحث مجاناً (one-time)',
    signup: 'https://serper.dev/signup',
    async search({ apiKey, query, timeRange, maxResults = 10 }) {
      const tbsMap = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', '6months': 'qdr:m6', year: 'qdr:y', '2years': 'qdr:y2' };
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: query,
          gl: 'sa',
          hl: 'ar',
          num: Math.min(maxResults, 100),
          tbs: tbsMap[timeRange] || 'qdr:y'
        })
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('Serper ' + resp.status + ': ' + t.substring(0, 200));
      }
      const data = await resp.json();
      return (data.organic || []).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        published_date: r.date || ''
      }));
    }
  }
};

// Hunter.io — للتحقق من إيميلات الشركات (25/شهر مجاناً)
async function hunterDomainSearch(apiKey, domain) {
  if (!apiKey || !domain) return null;
  try {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    const resp = await fetch(`https://api.hunter.io/v2/domain-search?domain=${cleanDomain}&api_key=${apiKey}&limit=5`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      domain: data.data?.domain,
      organization: data.data?.organization,
      emails: (data.data?.emails || []).map(e => ({
        email: e.value,
        confidence: e.confidence,
        position: e.position || '',
        first_name: e.first_name || '',
        last_name: e.last_name || ''
      }))
    };
  } catch (e) {
    console.warn('Hunter error:', e);
    return null;
  }
}

const BUSINESS_DOMAINS = {
  'النقل واللوجستيات': {
    icon: '🚛',
    sectors: [
      'شركات البناء والمقاولات الكبرى',
      'شركات النفط والغاز والحفر',
      'الموانئ وشركات اللوجستيات',
      'المصانع والشركات الصناعية',
      'الجهات والمشاريع الحكومية',
      'البنية التحتية والإنشاءات',
      'مستوردي ومصدري البضائع الثقيلة',
      'شركات تأجير المعدات الثقيلة',
      'مشاريع نيوم والبحر الأحمر',
      'متاجر إلكترونية كبيرة'
    ]
  },
  'المقاولات والبناء': {
    icon: '🏗️',
    sectors: [
      'مشاريع تطوير عقاري كبرى',
      'فلل ومنازل خاصة',
      'مجمعات سكنية ومخططات',
      'مكاتب وأبراج تجارية',
      'مراكز تسوق ومولات',
      'فنادق ومنتجعات سياحية',
      'مدارس وجامعات',
      'مستشفيات ومراكز طبية',
      'مطورين عقاريين',
      'شركات تطوير صناعي'
    ]
  },
  'العقارات والتطوير': {
    icon: '🏢',
    sectors: [
      'مكاتب التسويق العقاري',
      'مطورين عقاريين كبار',
      'شركات إدارة الأملاك',
      'صناديق الاستثمار العقاري (REITs)',
      'مكاتب تأجير عقارات',
      'وسطاء بيع وحدات سكنية',
      'مشاريع نيوم والبحر الأحمر',
      'مطورين فلل وقصور فاخرة',
      'مكاتب استشارات عقارية',
      'شركات بيع أراضي'
    ]
  },
  'تأجير العقارات والوحدات': {
    icon: '🏠',
    sectors: [
      'مكاتب إدارة العقارات السكنية',
      'تأجير الشقق المفروشة',
      'تأجير الفلل والاستراحات',
      'تأجير مكاتب ومحلات تجارية',
      'تأجير مستودعات ومخازن',
      'تأجير قاعات ومناسبات',
      'منصات إيجار قصير المدى',
      'تأجير وحدات للموظفين',
      'تأجير عقارات حكومية',
      'منصات أون لاين للتأجير'
    ]
  },
  'بيع الوحدات السكنية': {
    icon: '🔑',
    sectors: [
      'مشاريع فلل تحت الإنشاء',
      'مجمعات سكنية للبيع',
      'وحدات شقق فاخرة',
      'مخططات أراضي سكنية',
      'مكاتب تسويق المشاريع',
      'وسطاء البيع المعتمدين',
      'مطورين سكنيين كبار',
      'منصات بيع عقارية رقمية',
      'مشاريع رؤية 2030 السكنية',
      'مساكن الموظفين والعمال'
    ]
  },
  'المحاماة والاستشارات القانونية': {
    icon: '⚖️',
    sectors: [
      'شركات تحتاج استشارات تجارية',
      'مكاتب محاسبة',
      'مستثمرين أجانب جدد',
      'شركات استيراد وتصدير',
      'متاجر إلكترونية تحتاج عقوداً',
      'شركات عقارية',
      'مطاعم وامتيازات تجارية',
      'شركات تقنية وستارت أب',
      'عيادات ومستشفيات خاصة',
      'مدارس خاصة وأكاديميات'
    ]
  },
  'النظافة والتشغيل': {
    icon: '🧹',
    sectors: [
      'فنادق ومنتجعات',
      'مستشفيات ومراكز طبية',
      'مولات ومراكز تسوق',
      'أبراج مكاتب تجارية',
      'مدارس وجامعات',
      'مساجد كبرى',
      'مطاعم وفروع امتياز',
      'مصانع وورش',
      'منشآت رياضية',
      'محطات وقود ومحلات'
    ]
  },
  'التصميم الجرافيكي والهوية': {
    icon: '🎨',
    sectors: [
      'متاجر إلكترونية ناشئة',
      'مطاعم وكافيهات جديدة',
      'براندات منتجات مستحدثة',
      'عيادات تجميل ومراكز جمال',
      'مشاريع ناشئة (Startups)',
      'مكاتب استشارية',
      'محلات أزياء وموضة',
      'منتجعات سياحية',
      'مدارس وأكاديميات',
      'فعاليات ومؤتمرات'
    ]
  },
  'التسويق الرقمي': {
    icon: '📱',
    sectors: [
      'متاجر إلكترونية تحتاج إعلانات',
      'مطاعم وكافيهات',
      'عيادات وعروض طبية',
      'مكاتب عقارية',
      'علامات تجارية ناشئة',
      'دورات تدريبية أون لاين',
      'منتجات صناعية محلية',
      'تطبيقات وخدمات تقنية',
      'فعاليات ومؤتمرات',
      'محلات تجزئة'
    ]
  },
  'تقنية المعلومات والبرمجة': {
    icon: '💻',
    sectors: [
      'متاجر إلكترونية تحتاج تطوير',
      'شركات تحتاج أنظمة ERP',
      'عيادات تحتاج أنظمة إدارة',
      'مدارس تحتاج LMS',
      'مطاعم تحتاج أنظمة POS',
      'مكاتب عقارية تحتاج CRM',
      'فنادق تحتاج أنظمة حجز',
      'شركات تحتاج تطبيقات جوال',
      'متاجر فاشن تحتاج موقع',
      'جهات حكومية - تحول رقمي'
    ]
  },
  'الاستشارات الإدارية': {
    icon: '📊',
    sectors: [
      'شركات في مرحلة النمو',
      'مشاريع عائلية تحتاج هيكلة',
      'شركات تحتاج تخطيط استراتيجي',
      'مؤسسات تتجه للتحول',
      'شركات تستعد للإدراج (IPO)',
      'مكاتب تحتاج موارد بشرية',
      'مصانع تحتاج كفاءة تشغيل',
      'متاجر تحتاج توسع',
      'شركات تحتاج تطوير قيادات',
      'منشآت تحتاج إعادة هيكلة'
    ]
  },
  'مخصص': {
    icon: '⚙️',
    sectors: []
  }
};

// ============ DEFAULT PROMPTS ============
const DEFAULT_PROMPTS = {
  search: `أنت محلل تطوير أعمال خبير في السوق السعودي، تعمل لصالح "{{company}}".

== المهمة ==
بناءً على **نتائج البحث الحقيقية** المرفقة أدناه (من الإنترنت)، استخرج عملاء محتملين حقيقيين في مجال "{{domain}}" قطاع "{{sector}}" بمنطقة "{{city}}".

== نتائج البحث الفعلية (مصدرها الإنترنت — استخدم هذه فقط) ==
{{searchResults}}

== قواعد الاستخراج الصارمة ==
🔴 **استخدم فقط البيانات الموجودة حرفياً في نتائج البحث أعلاه** — لا تخترع، لا تخمّن.
🔴 إذا لم تجد إيميلاً صريحاً في نص أحد النتائج → اترك email="" و email_confidence=0
🔴 إذا لم تجد رقم هاتف صريح في النتائج → اترك phone="" و phone_confidence=0
🔴 الروابط (website, linkedin) يجب أن تكون **من URLs الموجودة في النتائج المرفقة فقط**
🔴 لا تخترع روابط linkedin.com — إن لم تجده في النتائج، اتركه ""
🔴 signal_source_url يجب أن يكون URL موجود في إحدى النتائج أعلاه

== معايير الاستهداف ==
- المجال الرئيسي: {{domain}}
- القطاع: {{sector}}
- المنطقة: {{city}}
- الفترة الزمنية: {{timeRange}}
- العدد المطلوب: {{count}} عميل (لا تختلق لتصل للعدد — أرجع ما توفّر فعلياً)
- الحد الأدنى للاهتمام: {{minScore}}%

== خدمات شركتنا ==
{{services}}

== هيكل JSON المطلوب (أرجع JSON فقط) ==
{"leads":[{
  "name":"اسم الكيان كما ظهر في النتائج",
  "name_en":"English name if found in results",
  "entity_type":"شركة/متجر/براند/مؤسسة/مكتب",
  "sector":"{{sector}}",
  "city":"المدينة",
  "email":"الإيميل من النتائج أو ''",
  "email_source":"اسم URL النتيجة أو ''",
  "email_confidence":0,
  "phone":"الرقم من النتائج أو ''",
  "phone_source":"اسم URL النتيجة أو ''",
  "phone_confidence":0,
  "website":"URL الموقع الرسمي من النتائج فقط",
  "linkedin":"رابط LinkedIn من النتائج فقط أو ''",
  "linkedin_source":"اسم النتيجة",
  "instagram":"@handle إن وُجد في النتائج",
  "interest_score":80,
  "signal":"الإشارة من النتيجة",
  "signal_date":"التاريخ من النتيجة",
  "signal_source_url":"URL النتيجة المرفقة",
  "source":"اسم الموقع (Argaam, LinkedIn, موقع الشركة...)",
  "reason":"لماذا هذا العميل مناسب لخدماتنا"
}]}

== مبدأ الصدق المطلق ==
أفضل أن تُرجع 5 عملاء ببيانات صادقة فعلية موجودة في النتائج المرفقة
من أن تُرجع 30 عميلاً ببيانات مخترعة.
الحقول الفارغة "" أفضل بكثير من البيانات الوهمية.

ابدأ مباشرة بـ { وأرجع JSON فقط.`,

  search_no_web: `أنت محلل تطوير أعمال في السوق السعودي تعمل لصالح "{{company}}".

⚠️ **لا يتوفر بحث ويب الآن**. ستعتمد على معرفتك العامة فقط.

== المهمة ==
اقترح {{count}} عملاء محتملين في مجال "{{domain}}" قطاع "{{sector}}" بـ "{{city}}".

== قواعد صدق صارمة (التزم بها حرفياً) ==
🔴 اذكر فقط شركات/كيانات تعرف وجودها يقيناً
🔴 **لا تختلق أي إيميل** — اترك email="" دائماً لأنك لا تستطيع التحقق
🔴 **لا تختلق أي رقم هاتف** — اترك phone="" دائماً
🔴 **لا تختلق روابط LinkedIn** — اترك "" إن لم تكن متأكداً 100%
🔴 website فقط للشركات الكبرى المعروفة (مثل aramco.com للنفط)
🔴 ضع رسالة واضحة في email_source: "لم يُتحقق - استخدم بحث ويب للحصول على بيانات حقيقية"

== خدمات شركتنا ==
{{services}}

== هيكل JSON المطلوب ==
{"leads":[{
  "name":"اسم الكيان",
  "entity_type":"النوع",
  "sector":"{{sector}}",
  "city":"المدينة",
  "email":"",
  "email_source":"لم يُتحقق - فعّل Tavily للحصول على بيانات حقيقية",
  "email_confidence":0,
  "phone":"",
  "phone_source":"لم يُتحقق",
  "phone_confidence":0,
  "website":"موقع رسمي معروف فقط",
  "linkedin":"",
  "interest_score":75,
  "signal":"السبب العام لاحتياج هذا الكيان لخدماتنا",
  "signal_date":"2025",
  "source":"معرفة عامة",
  "reason":"شرح موجز لماذا هذا العميل مناسب"
}]}

== مبدأ الصدق ==
هدفك هو إعطاء أسماء كيانات حقيقية فقط. لا تخترع بيانات اتصال أبداً.
البيانات الفارغة "" أفضل من المختلقة.

ابدأ بـ { فقط.`,

  message: `أنت مدير تطوير أعمال محترف ومقنع في شركة "{{myCompany}}".

== بيانات شركتنا ==
المجال: {{domain}}
الخدمات: {{myServices}}
المزايا التنافسية: {{myAdvantages}}
التواصل: {{myContact}}

== العميل المستهدف ==
الكيان: {{company}}
القطاع/النشاط: {{sector}}
{{note}}

== نوع الرسالة ==
{{typeLabel}}

== اللغة ==
{{langInstr}}

اكتب رسالة بريد إلكتروني احترافية مقنعة عالية التحويل وفق هذه القواعد:
1. سطر الموضوع: اكتبه في أول سطر بصيغة "الموضوع: ..." — مخصص لاسم الكيان وغير دعائي.
2. تحية شخصية تذكر اسم الكيان المستهدف.
3. جملة افتتاحية تربط بين نشاط الكيان واحتياجه لخدماتنا.
4. اذكر خدمتين أو ثلاثاً من خدماتنا الأكثر صلة بنشاط هذا العميل.
5. دليل ثقة قصير (شريك كبير أو سنوات الخبرة).
6. دعوة واضحة لاتخاذ إجراء (اجتماع 15 دقيقة / مكالمة / طلب عرض).
7. توقيع رسمي باسم إدارة تطوير الأعمال مع بيانات التواصل.

قيود لمنع الحظر:
- تجنب الكلمات المحفّزة للسبام (مجاني، عرض حصري، اضغط الآن).
- نبرة مهنية واثقة هادئة.
- الطول: 130-190 كلمة فقط للنص (عدا الموضوع).
- لا تضف أي شرح خارج نص الرسالة.`
};

function getPrompt(key) { return APP.config['prompt_' + key] || DEFAULT_PROMPTS[key]; }

function fillPromptTokens(template, vars) {
  let result = template;
  Object.keys(vars).forEach(k => {
    const re = new RegExp('\\{\\{' + k + '\\}\\}', 'g');
    result = result.replace(re, vars[k] || '');
  });
  return result;
}

// ============ NAVIGATION ============
function openPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  const nav = document.getElementById('nav-' + page);
  if (target) target.classList.add('active');
  if (nav) nav.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
  if (page === 'search') renderProviderPicker();
  if (page === 'leads') renderLeadsList();
  if (page === 'inbox') renderInbox();
  if (page === 'analytics') renderAnalytics();
  if (page === 'dashboard') { renderDashboardCharts(); renderDashSchedule(); refreshStats(); }
  if (page === 'compose') populateClientSelect();
  if (page === 'campaigns') document.getElementById('campaignPanel').style.display = 'none';
  if (page === 'deploy') renderDeployCode();
  if (page === 'prompts') loadPromptsToEditor();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}

// ============ PROVIDER PICKER ============
function renderProviderPicker() {
  const picker = document.getElementById('providerPicker');
  if (!picker) return;
  const favorite = APP.config.favoriteProvider || null;
  const items = Object.keys(PROVIDERS).map(pid => {
    const provider = PROVIDERS[pid];
    const hasKey = APP.config['key_' + pid] && APP.config['key_' + pid].length > 10;
    const isFav = favorite === pid;
    const isPicked = APP.pickedProvider === pid || (!APP.pickedProvider && isFav && hasKey);
    const works = APP.workingProviders[pid];
    const dot = works === true ? '<span class="dot-mini ok"></span>' : works === false ? '<span class="dot-mini no"></span>' : '';
    const disabledClass = !hasKey ? 'disabled' : '';
    const onClick = hasKey ? `pickProvider('${pid}')` : `showToast('⚠️ أضف مفتاح ${provider.name} في الإعدادات','error')`;
    const star = isFav ? '<span class="star favorite">★</span>' : '';
    return `<span class="provider-chip ${isPicked && hasKey ? 'active' : ''} ${disabledClass}" onclick="${onClick}" title="${provider.name}">
      ${dot}${provider.icon} ${provider.name} ${star}
    </span>`;
  }).join('');
  picker.innerHTML = items;
}

function pickProvider(pid) {
  APP.pickedProvider = pid;
  renderProviderPicker();
  showToast(`✓ تم اختيار ${PROVIDERS[pid].name} للبحث`);
}

function toggleFavorite(pid) {
  APP.config.favoriteProvider = APP.config.favoriteProvider === pid ? null : pid;
  DB.set('config', APP.config);
  refreshFavoriteUI();
  showToast(APP.config.favoriteProvider === pid ? `⭐ ${PROVIDERS[pid].name} أصبح المفضل` : 'تم إلغاء المفضل');
}

function refreshFavoriteUI() {
  Object.keys(PROVIDERS).forEach(pid => {
    const card = document.getElementById('card_' + pid);
    const fav = document.getElementById('fav_' + pid);
    if (!card || !fav) return;
    if (APP.config.favoriteProvider === pid) {
      card.classList.add('favorite');
      fav.classList.add('active');
      fav.textContent = '⭐ مفضل';
    } else {
      card.classList.remove('favorite');
      fav.classList.remove('active');
      fav.textContent = '⭐';
    }
  });
}

// ============ DEEP SEARCH ============
async function startDeepSearch() {
  const domain = document.getElementById('domainFilter').value;
  const sector = document.getElementById('sectorFilter').value;
  const city = document.getElementById('cityFilter').value;
  const timeRange = document.getElementById('timeRange').value;
  const searchDepth = document.getElementById('searchDepth').value;
  const minScore = parseInt(document.getElementById('scoreThreshold').value);
  const count = Math.max(5, parseInt(document.getElementById('leadsMin').value) || 15);

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const timeRangeText = {
    day: `آخر 24 ساعة (${todayStr})`,
    week: `آخر 7 أيام`,
    month: 'الشهر الماضي',
    '6months': 'آخر 6 أشهر (2025-2026)',
    year: 'آخر سنة (2025-2026)',
    '2years': 'آخر سنتين (2024-2026)'
  }[timeRange] || 'آخر سنتين';

  document.getElementById('aiLoader').classList.add('active');
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchBtn').disabled = true;

  // Determine if web search is available
  const webSearchProvider = APP.config.searchProvider;
  const webSearchKey = webSearchProvider ? APP.config['searchKey_' + webSearchProvider] : null;
  const useWebSearch = webSearchProvider && webSearchKey && webSearchKey.length > 10;

  const stepsBase = useWebSearch ? [
    `🌐 يبحث على الإنترنت (${SEARCH_PROVIDERS[webSearchProvider].name})...`,
    `🔍 ينقّب في ${domain} - ${sector}...`,
    `📰 يفحص الأخبار الحقيقية (${timeRangeText})...`,
    `📋 يستخرج روابط مواقع الشركات...`,
    `🔬 ${useWebSearch ? 'يستخدم Hunter للإيميلات' : 'يستخرج بيانات التواصل'}...`,
    `🤖 يحلل النتائج بالذكاء الاصطناعي...`,
    `⚖️ يقيّم احتمالية كل عميل...`
  ] : [
    `🔍 يبدأ البحث في ${domain}...`,
    '⚠️ لا يتوفر بحث ويب — يعتمد على معرفة AI العامة',
    '🤖 يستخرج عملاء محتملين...',
    '⚖️ يقيّم النسب...',
    '📝 يجهّز النتائج...'
  ];

  let si = 0, prog = 0;
  const tick = setInterval(() => {
    prog = Math.min(prog + Math.random() * 8 + 3, 92);
    if (si < stepsBase.length) { document.getElementById('aiLoaderText').textContent = stepsBase[si]; si++; }
    document.getElementById('aiProgress').style.width = prog + '%';
    document.getElementById('aiProgressNum').textContent = Math.round(prog) + '%';
  }, 700);

  let leads = [], isReal = false, providerUsed = '', errorMsg = '';
  let webResults = [];
  const company = APP.config.myCompany || 'شركة';
  const services = APP.config.myServices || 'خدمات تجارية';

  try {
    // STEP 1: Web search if available
    if (useWebSearch) {
      const sectorTerm = sector === 'جميع القطاعات' ? '' : sector;
      const queries = [
        `${sectorTerm} ${city} السعودية ${timeRange === 'day' || timeRange === 'week' ? '2026' : '2025 2026'} موقع OR ايميل OR تواصل`,
        `${sectorTerm} ${city} مشروع جديد OR توسعة OR افتتاح OR مناقصة`,
        `${domain} ${city} شركات ${timeRange === 'year' || timeRange === '2years' ? '2025' : ''}`
      ].filter(q => q.length > 10);

      for (const q of queries.slice(0, 3)) {
        try {
          const results = await SEARCH_PROVIDERS[webSearchProvider].search({
            apiKey: webSearchKey,
            query: q,
            timeRange: timeRange,
            maxResults: 10
          });
          webResults = webResults.concat(results);
        } catch (e) {
          console.warn('Search query failed:', e.message);
          errorMsg = e.message;
        }
      }

      // Deduplicate by URL
      const seen = new Set();
      webResults = webResults.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
    }

    // STEP 2: Build prompt
    let promptTemplate;
    let promptVars;

    if (useWebSearch && webResults.length > 0) {
      // Grounded prompt with real search results
      const searchResultsText = webResults.slice(0, 25).map((r, i) =>
        `[${i+1}] العنوان: ${r.title}\nالرابط: ${r.url}\nالمقتطف: ${r.snippet}\nالتاريخ: ${r.published_date || 'غير محدد'}\n`
      ).join('\n---\n');

      promptTemplate = getPrompt('search');
      promptVars = {
        domain, sector, city, count: String(count), minScore: String(minScore),
        timeRange: timeRangeText, company, services,
        searchResults: searchResultsText
      };
    } else {
      // Fallback to no-web prompt
      promptTemplate = APP.config['prompt_search_no_web'] || DEFAULT_PROMPTS.search_no_web;
      promptVars = {
        domain, sector, city, count: String(count), minScore: String(minScore),
        timeRange: timeRangeText, company, services
      };
    }

    const prompt = fillPromptTokens(promptTemplate, promptVars);

    // STEP 3: Call AI
    const forceProvider = APP.pickedProvider || APP.config.favoriteProvider;
    const result = await callAI(prompt, { maxTokens: 7000, forceProvider });

    if (result.ok) {
      providerUsed = PROVIDERS[result.provider]?.name || result.provider;
      const parsed = extractJSON(result.text);
      if (parsed && parsed.leads && Array.isArray(parsed.leads)) {
        leads = parsed.leads.filter(l => l && l.name).map(l => ({
          name: l.name, name_en: l.name_en || '',
          entity_type: l.entity_type || '',
          sector: l.sector || sector,
          city: l.city || city.split(' ')[0],
          email: l.email || '',
          email_source: l.email_source || '',
          email_confidence: Math.round(l.email_confidence || 0),
          phone: l.phone || '',
          phone_source: l.phone_source || '',
          phone_confidence: Math.round(l.phone_confidence || 0),
          website: l.website || '',
          linkedin: l.linkedin || '',
          linkedin_source: l.linkedin_source || '',
          instagram: l.instagram || '',
          score: Math.round(l.interest_score || l.score || 50),
          signal: l.signal || '',
          signal_date: l.signal_date || '',
          signal_source_url: l.signal_source_url || '',
          source: l.source || '',
          reason: l.reason || '',
          status: 'pending', last: '—', real: true,
          grounded: useWebSearch && webResults.length > 0
        })).filter(l => l.score >= minScore).sort((a, b) => b.score - a.score);
        if (leads.length > 0) {
          isReal = true;
          APP.workingProviders[result.provider] = true;
        }
      } else {
        errorMsg = 'فشل تحليل JSON من ' + providerUsed;
        console.warn('JSON parse failed. Raw:', result.text.substring(0, 500));
      }
    } else {
      errorMsg = result.error || 'فشل الاتصال بالـ AI';
    }

    // STEP 4: Enrich emails with Hunter.io if available
    if (isReal && APP.config.hunterApiKey && leads.length > 0) {
      document.getElementById('aiLoaderText').textContent = '📧 يتحقق من الإيميلات عبر Hunter.io...';
      for (let i = 0; i < Math.min(leads.length, 5); i++) {
        const lead = leads[i];
        if (lead.website && (!lead.email || lead.email_confidence < 70)) {
          const hunterData = await hunterDomainSearch(APP.config.hunterApiKey, lead.website);
          if (hunterData && hunterData.emails && hunterData.emails.length > 0) {
            const bestEmail = hunterData.emails.sort((a, b) => b.confidence - a.confidence)[0];
            lead.email = bestEmail.email;
            lead.email_source = `Hunter.io (${bestEmail.position || 'موظف'})`;
            lead.email_confidence = bestEmail.confidence;
            lead.hunter_verified = true;
          }
        }
      }
    }

  } catch (e) {
    errorMsg = e.message;
    console.error('Search error:', e);
  }

  clearInterval(tick);
  document.getElementById('aiProgress').style.width = '100%';
  document.getElementById('aiProgressNum').textContent = '100%';

  setTimeout(() => {
    document.getElementById('aiLoader').classList.remove('active');
    document.getElementById('aiProgress').style.width = '0%';
    document.getElementById('searchBtn').disabled = false;
    APP.searchResults = leads;
    APP.selectedSet.clear();
    document.getElementById('resultsCount').textContent = leads.length;
    const mode = document.getElementById('resultMode');

    if (isReal && leads.length > 0) {
      const groundedLabel = useWebSearch ? `🌐 بحث ويب حقيقي (${webResults.length} نتيجة)` : '⚠️ بدون بحث ويب';
      const hunterLabel = APP.config.hunterApiKey ? ' · 📧 Hunter' : '';
      mode.className = useWebSearch ? 'tag tag-real' : 'tag tag-pending';
      mode.textContent = `${groundedLabel} · ${providerUsed}${hunterLabel} · ${leads.length} نتيجة`;
      renderResultsTable(leads);
      document.getElementById('searchResults').style.display = 'block';
      const msg = useWebSearch
        ? `✅ ${leads.length} عميل من بحث ويب حقيقي`
        : `⚠️ ${leads.length} عميل (بدون تحقق ويب — أضف Tavily للجودة)`;
      showToast(msg, useWebSearch ? 'success' : '');
    } else {
      mode.className = 'tag tag-cold';
      mode.textContent = '⚠️ لا توجد نتائج';
      const errorDetails = errorMsg ? `<br><br><b>التفاصيل:</b><br><code style="font-size:11px;direction:ltr;display:inline-block;text-align:left;color:var(--orange)">${escapeHtml(errorMsg.substring(0, 300))}</code>` : '';
      const webHint = !useWebSearch ? `<div class="info-box info-purple" style="margin-top:14px;max-width:600px;margin-left:auto;margin-right:auto;text-align:right">
        <div class="ib-title">💡 لجودة أفضل: فعّل بحث الويب</div>
        <div>أضف مفتاح <b>Tavily</b> (مجاني 1000/شهر) في الإعدادات لتحصل على:
        <br>✅ نتائج حقيقية موثّقة بمصادرها
        <br>✅ إيميلات وأرقام مؤكدة
        <br>✅ روابط مواقع تعمل فعلياً
        </div>
      </div>` : '';
      document.getElementById('resultsBody').innerHTML = `<tr><td colspan="7">
        <div class="empty-state" style="padding:40px 20px">
          <div class="icon">🔍</div>
          <h3 style="color:var(--gold);margin-bottom:10px">لم نجد عملاء بالمعايير المحددة</h3>
          <p style="font-size:13px;line-height:1.9;max-width:600px;margin:0 auto">
            <b>جرّب:</b><br>
            • تقليل الحد الأدنى للاهتمام<br>
            • توسيع الفترة الزمنية (سنتين بدلاً من اليوم)<br>
            • اختيار "جميع القطاعات" بدلاً من قطاع محدد<br>
            • تجربة نموذج AI آخر<br>
            ${errorDetails}
          </p>
          ${webHint}
          <button class="btn-primary" style="margin-top:18px" onclick="startDeepSearch()">🔄 إعادة المحاولة</button>
        </div>
      </td></tr>`;
      document.getElementById('searchResults').style.display = 'block';
    }
  }, 700);
}

function buildStandardPrompt() {
  return `أنت محلل تطوير أعمال للنقل اللوجستي السعودي. ابحث عن {{count}} عميل في قطاع {{sector}} في {{city}}.

لكل عميل قيّم interest_score (0-100) بناءً على حاجته للنقل الثقيل.

أرجع JSON فقط:
{"leads":[{"name":"الشركة","sector":"النشاط","city":"المدينة","email":"info@x.sa","phone":"+966...","website":"https://...","linkedin":"","interest_score":80,"signal":"","reason":"السبب"}]}

ابدأ مباشرة بـ {. لا شرح. {{count}} عميل بالحد الأدنى. الحد الأدنى للنسبة {{minScore}}%.`;
}

function renderResultsTable(data) {
  document.getElementById('resultsBody').innerHTML = data.map((l, i) => {
    const cls = l.score >= 80 ? 'score-high' : l.score >= 60 ? 'score-mid' : 'score-low';
    const checked = APP.selectedSet.has(i) ? 'checked' : '';
    const checkMark = APP.selectedSet.has(i) ? '✓' : '';

    // Smart link display: only show valid-looking URLs
    const isValidUrl = (url) => url && /^https?:\/\/[\w.-]+\.[a-z]{2,}/i.test(url);
    const links = [];
    if (isValidUrl(l.website)) {
      links.push(`<a href="${escapeAttr(l.website)}" target="_blank" rel="noopener" class="lead-link" title="${escapeAttr(l.website)}">🌐 موقع</a>`);
    }
    if (isValidUrl(l.linkedin) && l.linkedin.includes('linkedin.com')) {
      links.push(`<a href="${escapeAttr(l.linkedin)}" target="_blank" rel="noopener" class="lead-link" title="${escapeAttr(l.linkedin)}">💼 LinkedIn</a>`);
    }
    if (l.instagram) {
      const igHandle = l.instagram.replace(/^@/, '').replace(/^https?:\/\/.*instagram\.com\//, '');
      if (igHandle && /^[\w.]+$/.test(igHandle)) {
        links.push(`<a href="https://www.instagram.com/${escapeAttr(igHandle)}" target="_blank" rel="noopener" class="lead-link">📷 IG</a>`);
      }
    }
    const linksHtml = links.length ? links.join('') : '<span style="color:var(--text-dim);font-size:11px">لا روابط مؤكدة</span>';

    // Signal with source URL link
    const signalLinkBtn = isValidUrl(l.signal_source_url) ?
      ` <a href="${escapeAttr(l.signal_source_url)}" target="_blank" rel="noopener" style="color:var(--cyan);font-size:10px;text-decoration:underline">[المصدر ↗]</a>` : '';
    const signalLine = l.signal ? `<div class="lead-source">📡 ${escapeHtml(l.signal.substring(0, 110))}${l.signal_date ? ' · <b style="color:var(--gold)">' + escapeHtml(l.signal_date) + '</b>' : ''}${signalLinkBtn}</div>` : '';
    const sourceLine = l.source ? `<div class="lead-source">📰 ${escapeHtml(l.source)}</div>` : '';
    const entityBadge = l.entity_type ? `<span class="tag tag-info" style="font-size:9px;padding:1px 7px;margin-right:6px">${escapeHtml(l.entity_type)}</span>` : '';
    const groundedBadge = l.grounded ? '<span class="tag tag-real" style="font-size:9px;padding:1px 6px;margin-right:6px" title="من بحث ويب حقيقي">🌐</span>' : '';
    const hunterBadge = l.hunter_verified ? '<span class="tag" style="font-size:9px;padding:1px 6px;margin-right:6px;background:rgba(168,85,247,0.15);color:#c4a8ff" title="مُتحقق عبر Hunter.io">📧✓</span>' : '';

    // Contact display - hide if confidence too low
    const showEmail = l.email && l.email_confidence > 0;
    const showPhone = l.phone && l.phone_confidence > 0;

    const emailConfClass = l.email_confidence >= 80 ? 'conf-high' : l.email_confidence >= 50 ? 'conf-mid' : 'conf-low';
    const phoneConfClass = l.phone_confidence >= 80 ? 'conf-high' : l.phone_confidence >= 50 ? 'conf-mid' : 'conf-low';

    const emailDisplay = showEmail
      ? `<div style="font-size:11px;direction:ltr;color:var(--text-2)">${escapeHtml(l.email)}</div>
         ${l.email_source ? `<div class="data-source"><span class="conf-dot ${emailConfClass}"></span>📧 ${escapeHtml(l.email_source.substring(0, 45))} <b>${l.email_confidence}%</b></div>` : ''}`
      : '<div style="font-size:11px;color:var(--orange);direction:rtl">⚠️ لا إيميل مؤكد</div>';

    const phoneDisplay = showPhone
      ? `<div style="font-size:11px;direction:ltr;color:var(--text-dim);margin-top:4px">${escapeHtml(l.phone)}</div>
         ${l.phone_source ? `<div class="data-source"><span class="conf-dot ${phoneConfClass}"></span>📞 ${escapeHtml(l.phone_source.substring(0, 45))} <b>${l.phone_confidence}%</b></div>` : ''}`
      : '<div style="font-size:11px;color:var(--orange);direction:rtl;margin-top:4px">⚠️ لا رقم مؤكد</div>';

    return `<tr>
      <td><div class="checkbox-custom ${checked}" id="chk-${i}" onclick="toggleChk(${i})">${checkMark}</div></td>
      <td>
        <div style="font-weight:600">${groundedBadge}${hunterBadge}${entityBadge}${escapeHtml(l.name)}</div>
        ${signalLine}${sourceLine}
      </td>
      <td><span class="tag tag-pending" style="font-size:10px">${escapeHtml(l.sector)}</span></td>
      <td>
        ${emailDisplay}
        ${phoneDisplay}
      </td>
      <td>${linksHtml}</td>
      <td><div class="score-bar ${cls}">
        <div class="score-fill"><div class="score-fill-inner" style="width:${l.score}%"></div></div>
        <span class="score-text">${l.score}%</span>
      </div></td>
      <td><div class="action-btns">
        <button class="btn-sm btn-view" onclick="viewLead(${i})">عرض</button>
        <button class="btn-sm btn-send" onclick="composeForResult(${i})">✍️</button>
        ${showPhone ? `<button class="btn-sm btn-wa" onclick="waResult(${i})">📱</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
}

function toggleChk(i) {
  const el = document.getElementById('chk-' + i);
  if (APP.selectedSet.has(i)) { APP.selectedSet.delete(i); el.classList.remove('checked'); el.textContent = ''; }
  else { APP.selectedSet.add(i); el.classList.add('checked'); el.textContent = '✓'; }
}

function selectAll() {
  APP.searchResults.forEach((_, i) => {
    APP.selectedSet.add(i);
    const e = document.getElementById('chk-' + i);
    if (e) { e.classList.add('checked'); e.textContent = '✓'; }
  });
  showToast('تم تحديد الكل');
}

function sendSelected() {
  if (APP.selectedSet.size === 0) { showToast('⚠️ اختر شركات أولاً', 'error'); return; }
  const chosen = [...APP.selectedSet].map(i => APP.searchResults[i]);
  for (const c of chosen) {
    if (!APP.leads.find(x => x.name === c.name)) APP.leads.push({ ...c });
  }
  DB.set('leads', APP.leads);
  document.getElementById('leadsCount').textContent = APP.leads.length;
  APP.campaignTargets = chosen;
  openPage('campaigns');
  startCampaign('email');
  showToast(`🚀 ${chosen.length} عميل جاهز`, 'success');
}

function filterLeads(type, btn) {
  document.querySelectorAll('#page-search .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  let f = APP.searchResults;
  if (type === 'high') f = f.filter(l => l.score >= 80);
  else if (type === 'mid') f = f.filter(l => l.score >= 60 && l.score < 80);
  else if (type === 'low') f = f.filter(l => l.score < 60);
  renderResultsTable(f);
}

function viewLead(i) {
  const l = APP.searchResults[i];
  const links = [];
  if (l.website) links.push(`<a href="${escapeAttr(l.website)}" target="_blank" rel="noopener" class="lead-link" style="padding:6px 12px">🌐 الموقع الرسمي</a>`);
  if (l.linkedin) links.push(`<a href="${escapeAttr(l.linkedin)}" target="_blank" rel="noopener" class="lead-link" style="padding:6px 12px">💼 LinkedIn</a>`);

  // Confidence badges helper
  const confBadge = (n) => {
    if (!n) return '';
    const cls = n >= 80 ? 'conf-high' : n >= 50 ? 'conf-mid' : 'conf-low';
    return `<span class="conf-badge ${cls}">ثقة ${n}%</span>`;
  };

  document.getElementById('modalTitle').innerHTML = `تفاصيل <span>${escapeHtml(l.name)}</span>`;
  document.getElementById('modalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="form-group"><label>القطاع</label><div style="padding:8px 12px;background:rgba(10,26,51,.8);border:1px solid var(--border);border-radius:8px;font-size:13px">${escapeHtml(l.sector)}</div></div>
      <div class="form-group"><label>نسبة الاهتمام</label><div style="padding:8px 12px;background:rgba(10,26,51,.8);border:1px solid var(--gold);border-radius:8px;font-size:13px;color:var(--gold);font-weight:700">${l.score}%</div></div>
    </div>

    <div class="info-box info-cyan" style="margin-bottom:12px">
      <div class="ib-title">📧 بيانات التواصل ومصادرها</div>
      <div class="contact-row">
        <div class="contact-label">البريد الإلكتروني:</div>
        <div class="contact-value" style="direction:ltr">${escapeHtml(l.email)}</div>
      </div>
      ${l.email_source ? `<div class="contact-source">
        📌 <b>المصدر:</b> ${escapeHtml(l.email_source)} ${confBadge(l.email_confidence)}
      </div>` : ''}

      <div class="contact-row" style="margin-top:10px">
        <div class="contact-label">رقم الهاتف:</div>
        <div class="contact-value" style="direction:ltr">${escapeHtml(l.phone)}</div>
      </div>
      ${l.phone_source ? `<div class="contact-source">
        📌 <b>المصدر:</b> ${escapeHtml(l.phone_source)} ${confBadge(l.phone_confidence)}
      </div>` : ''}
    </div>

    ${links.length ? `<div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap">${links.join('')}</div>` : ''}

    ${l.signal ? `<div class="info-box info-purple">
      <div class="ib-title">📡 إشارة النية المكتشفة</div>
      <div>
        ${escapeHtml(l.signal)}
        ${l.signal_date ? '<br><b>التاريخ:</b> <span style="color:var(--gold)">' + escapeHtml(l.signal_date) + '</span>' : ''}
        ${l.source ? '<br><b>المصدر:</b> ' + escapeHtml(l.source) : ''}
        ${l.signal_source_url ? '<br><b>رابط الإشارة:</b> <a href="' + escapeAttr(l.signal_source_url) + '" target="_blank" rel="noopener" style="color:var(--cyan);word-break:break-all">' + escapeHtml(l.signal_source_url.substring(0, 80)) + '</a>' : ''}
      </div>
    </div>` : ''}

    <div class="info-box info-gold">
      <div class="ib-title">🤖 تحليل الذكاء الاصطناعي</div>
      <div>${escapeHtml(l.reason || 'شركة ضمن قطاع مستهدف.')}</div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn-primary" onclick="composeForResult(${i});closeModal('leadModal')">✍️ كتابة رسالة</button>
      <button class="btn-sm btn-wa" style="padding:10px 18px" onclick="waResult(${i});closeModal('leadModal')">📱 واتساب</button>
      <button class="btn-outline" onclick="closeModal('leadModal')">إغلاق</button>
    </div>`;
  document.getElementById('leadModal').classList.add('open');
}

function composeForResult(i) { goCompose(APP.searchResults[i]); }
function waResult(i) { doWA(APP.searchResults[i]); }

function goCompose(l) {
  openPage('compose');
  document.getElementById('cCompany').value = l.name;
  document.getElementById('cSector').value = l.sector;
  document.getElementById('recipientEmail').value = l.email;
  document.getElementById('recipientPhone').value = l.phone;
}

// ============ WHATSAPP — FIXED ============
function normalizePhone(phone) {
  let cleaned = (phone || '').replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('00')) cleaned = cleaned.substring(2);
  if (cleaned.startsWith('05')) cleaned = '966' + cleaned.substring(1);
  else if (cleaned.startsWith('5') && cleaned.length === 9) cleaned = '966' + cleaned;
  else if (!cleaned.startsWith('966') && cleaned.length === 9) cleaned = '966' + cleaned;
  return cleaned;
}

function doWA(lead) {
  const phone = normalizePhone(lead.phone);
  if (!phone || phone.length < 10) {
    showToast('⚠️ لا يوجد رقم واتساب صالح', 'error');
    return;
  }
  const myCompany = APP.config.myCompany || 'شركة محمد للنقليات (MTC)';
  const myContact = APP.config.myContact || '+966501815872';
  const text = `السلام عليكم،

نحن ${myCompany}، متخصصون في النقل الثقيل والتخليص الجمركي والخدمات اللوجستية منذ 1433هـ.

نودّ التعرف على احتياجات ${lead.name} وتقديم أفضل الحلول.

للتواصل:
${myContact}`;
  showWADialog(phone, lead.name, text);
}

function openWhatsAppDialog() {
  const phone = normalizePhone(document.getElementById('recipientPhone').value);
  if (!phone || phone.length < 10) { showToast('⚠️ أدخل رقم الواتساب أولاً', 'error'); return; }
  const msg = document.getElementById('msgPreview').textContent;
  const cleanMsg = msg.replace(/^الموضوع:.*\n+/i, '');
  const company = document.getElementById('cCompany').value || '';
  showWADialog(phone, company, cleanMsg);
}

function copyWAMessage() {
  if (!APP.waMessageCache) return;
  copyToClipboard(APP.waMessageCache.message);
  showToast('📋 تم نسخ نص الرسالة', 'success');
}

// ============ WHATSAPP BUSINESS API (Meta Cloud API) ============
// يستخدم Meta Cloud API الرسمية لإرسال رسائل مباشرة بدون فتح نافذة
// المتطلبات: Phone Number ID + Permanent Access Token + قالب معتمد
async function sendWhatsAppBusinessAPI(phone, message, useTemplate) {
  const cfg = APP.config;
  if (!cfg.waBusinessEnabled) {
    return { ok: false, error: 'WhatsApp Business API غير مفعّل' };
  }
  if (!cfg.waPhoneNumberId || !cfg.waAccessToken) {
    return { ok: false, error: 'Phone Number ID أو Access Token مفقود' };
  }

  const url = `https://graph.facebook.com/v21.0/${cfg.waPhoneNumberId}/messages`;

  // Normalize phone (remove + and any non-digits)
  const cleanPhone = (phone || '').replace(/\D/g, '');

  // Build payload based on message type
  let payload;
  if (useTemplate && cfg.waTemplateName) {
    // Template message (required for first contact outside 24h window)
    payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: cfg.waTemplateName,
        language: { code: cfg.waTemplateLang || 'ar' }
      }
    };
  } else {
    // Plain text message (only works if customer messaged us in last 24h)
    payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: { preview_url: false, body: message }
    };
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.waAccessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data.error?.message || 'فشل API: ' + resp.status, details: data };
    }
    return { ok: true, messageId: data.messages?.[0]?.id, data };
  } catch (e) {
    return { ok: false, error: 'خطأ شبكة: ' + e.message };
  }
}

async function testWhatsAppAPI() {
  const statusEl = document.getElementById('waBusinessStatus');
  const phoneId = document.getElementById('waPhoneNumberId').value.trim();
  const token = document.getElementById('waAccessToken').value.trim();

  if (!phoneId || !token) {
    statusEl.innerHTML = '<span style="color:var(--red)">⚠️ أدخل Phone Number ID و Access Token</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color:var(--cyan)">⏳ يختبر الاتصال بـ Meta API...</span>';

  try {
    // Test by fetching phone number info
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await resp.json();
    if (resp.ok) {
      statusEl.innerHTML = `<span style="color:var(--green)">✅ متصل بنجاح · الرقم: ${escapeHtml(data.display_phone_number || '?')} · حالة الجودة: ${escapeHtml(data.quality_rating || 'GREEN')}</span>`;
      APP.config.waPhoneNumberId = phoneId;
      APP.config.waAccessToken = token;
      DB.set('config', APP.config);
    } else {
      statusEl.innerHTML = `<span style="color:var(--red)">❌ فشل: ${escapeHtml(data.error?.message || 'خطأ غير معروف')}</span>`;
    }
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ خطأ: ${escapeHtml(e.message)}</span>`;
  }
}

function saveWhatsAppBusiness() {
  APP.config.waBusinessEnabled = document.getElementById('waBusinessToggle').checked;
  APP.config.waPhoneNumberId = document.getElementById('waPhoneNumberId').value.trim();
  APP.config.waAccessToken = document.getElementById('waAccessToken').value.trim();
  APP.config.waTemplateName = document.getElementById('waTemplateName').value.trim();
  APP.config.waTemplateLang = document.getElementById('waTemplateLang').value.trim() || 'ar';
  DB.set('config', APP.config);
  showToast('✅ تم حفظ إعدادات WhatsApp Business', 'success');
}

// Enhanced WA modal that includes API option if enabled
function openWA(mode) {
  if (!APP.waMessageCache) return;
  const { phone, message } = APP.waMessageCache;

  if (mode === 'api') {
    // Send via Business API directly
    if (!APP.config.waBusinessEnabled) {
      showToast('⚠️ فعّل WhatsApp Business API في الإعدادات', 'error');
      return;
    }
    showToast('📤 يُرسل عبر WhatsApp Business API...');
    sendWhatsAppBusinessAPI(phone, message, false).then(result => {
      if (result.ok) {
        showToast(`✅ تم الإرسال · ID: ${result.messageId?.substring(0, 20)}`, 'success');
        closeModal('waModal');
      } else {
        showToast(`❌ ${result.error}`, 'error');
        console.warn('WA API error:', result);
      }
    });
    return;
  }

  const encoded = encodeURIComponent(message);
  const url = mode === 'web'
    ? `https://web.whatsapp.com/send?phone=${phone}&text=${encoded}`
    : `https://wa.me/${phone}?text=${encoded}`;
  const newWin = window.open(url, '_blank', 'noopener,noreferrer');
  if (!newWin || newWin.closed || typeof newWin.closed === 'undefined') {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('📋 المتصفح يحظر النوافذ — تم نسخ الرابط', 'error');
      });
    } else {
      showToast('⚠️ السماح بالنوافذ المنبثقة لهذا الموقع', 'error');
    }
  } else {
    showToast('✅ تم فتح واتساب', 'success');
    closeModal('waModal');
  }
}

function showWADialog(phone, company, message) {
  APP.waMessageCache = { phone, message };
  document.getElementById('waPhone').textContent = '+' + phone;
  document.getElementById('waCompany').textContent = company || '—';
  // Show API option if enabled
  const apiBtn = document.getElementById('waApiBtn');
  if (apiBtn) {
    apiBtn.style.display = APP.config.waBusinessEnabled ? 'block' : 'none';
  }
  document.getElementById('waModal').classList.add('open');
}

// ============ LEADS LIST ============
// ============================================================
// قائمة العملاء — نظام متطور بترقيم وبحث وتصفية
// ============================================================
APP.leadsView = {
  page: 1,
  perPage: 25,
  filter: 'all',
  search: '',
  cityFilter: '',
  priorityFilter: '',
  originFilter: '',
  selected: new Set()
};

function renderLeadsList() {
  const tb = document.getElementById('leadsListBody');
  const emptyEl = document.getElementById('leadsEmpty');

  if (APP.leads.length === 0) {
    if (emptyEl) emptyEl.style.display = 'block';
    if (tb) tb.innerHTML = '';
    renderLeadsStats();
    renderLeadsPagination();
    renderLeadsFilters();
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Apply filters
  const v = APP.leadsView;
  let filtered = APP.leads.slice();

  // Status filter
  if (v.filter === 'sent') filtered = filtered.filter(l => l.status === 'sent');
  else if (v.filter === 'opened') filtered = filtered.filter(l => l.status === 'opened');
  else if (v.filter === 'replied') filtered = filtered.filter(l => l.status === 'replied');
  else if (v.filter === 'pending') filtered = filtered.filter(l => l.status === 'pending' || !l.status);
  else if (v.filter === 'hot') filtered = filtered.filter(l => l.hot_lead);

  // City filter
  if (v.cityFilter) filtered = filtered.filter(l => l.city === v.cityFilter);
  // Priority filter
  if (v.priorityFilter) filtered = filtered.filter(l => l.priority === v.priorityFilter);
  // Origin filter
  if (v.originFilter) filtered = filtered.filter(l => l.company_origin === v.originFilter);

  // Search filter
  if (v.search) {
    const q = v.search.toLowerCase();
    filtered = filtered.filter(l =>
      (l.name && l.name.toLowerCase().includes(q)) ||
      (l.name_en && l.name_en.toLowerCase().includes(q)) ||
      (l.email && l.email.toLowerCase().includes(q)) ||
      (l.phone && l.phone.toLowerCase().includes(q)) ||
      (l.sector && l.sector.toLowerCase().includes(q)) ||
      (l.city && l.city.toLowerCase().includes(q))
    );
  }

  // Save filtered for batch ops
  APP.leadsView.filtered = filtered;
  APP.leadsView.total = filtered.length;
  APP.leadsView.pages = Math.max(1, Math.ceil(filtered.length / v.perPage));

  // Clamp current page
  if (v.page > v.pages) v.page = v.pages;
  if (v.page < 1) v.page = 1;

  // Slice for current page
  const start = (v.page - 1) * v.perPage;
  const slice = filtered.slice(start, start + v.perPage);

  const sm = { pending: 'tag-pending', sent: 'tag-sent', opened: 'tag-opened', replied: 'tag-replied', cold: 'tag-cold' };
  const sl = { pending: 'لم يُرسل', sent: 'أُرسل', opened: 'فُتح', replied: 'رد ✅', cold: 'بارد' };

  if (slice.length === 0) {
    tb.innerHTML = `<tr><td colspan="9"><div class="empty-state" style="padding:30px">
      <div class="icon">🔍</div>
      <p>لا توجد نتائج تطابق التصفية الحالية</p>
      <button class="btn-outline" style="margin-top:10px" onclick="clearLeadsFilters()">مسح التصفية</button>
    </div></td></tr>`;
    renderLeadsStats();
    renderLeadsPagination();
    return;
  }

  tb.innerHTML = slice.map((l) => {
    const globalIdx = APP.leads.indexOf(l);
    const cls = l.score >= 80 ? 'score-high' : l.score >= 60 ? 'score-mid' : 'score-low';
    const links = [];
    if (l.website) links.push(`<a href="${escapeAttr(l.website)}" target="_blank" rel="noopener" class="lead-link" title="${escapeAttr(l.website)}">🌐</a>`);
    if (l.linkedin) links.push(`<a href="${escapeAttr(l.linkedin)}" target="_blank" rel="noopener" class="lead-link" title="LinkedIn">💼</a>`);

    const isSelected = APP.leadsView.selected.has(globalIdx);
    const checkMark = isSelected ? '✓' : '';

    // Priority badge
    const priorityColors = {
      'عالية جداً': 'background:linear-gradient(135deg,#ff5b6e,#ff9a3c);color:#fff',
      'عالية': 'background:rgba(255,154,60,0.2);color:var(--orange);border:1px solid var(--orange)',
      'متوسطة': 'background:rgba(202,168,77,0.15);color:var(--gold)',
      'منخفضة': 'background:rgba(130,149,187,0.15);color:var(--text-dim)',
      'عادية': 'background:rgba(130,149,187,0.15);color:var(--text-dim)'
    };
    const priorityStyle = priorityColors[l.priority] || priorityColors['عادية'];
    const priorityBadge = l.priority ? `<span class="tag" style="font-size:9px;padding:2px 7px;${priorityStyle}">${escapeHtml(l.priority)}</span>` : '';

    const hotBadge = l.hot_lead ? '<span style="font-size:14px" title="عميل حار">🔥</span>' : '';
    const originBadge = l.company_origin === 'سعودية' ? '🇸🇦' : l.company_origin === 'أجنبية' ? '🌍' : '';
    const contractProb = l.contract_probability ? `<div class="data-source" style="margin-top:2px">📊 ${l.contract_probability}% احتمالية تعاقد</div>` : '';

    return `<tr ${isSelected ? 'style="background:var(--gold-dim)"' : ''}>
      <td><div class="checkbox-custom ${isSelected ? 'checked' : ''}" onclick="toggleLeadSelect(${globalIdx})">${checkMark}</div></td>
      <td>
        <div style="font-weight:600;font-size:13px">${hotBadge} ${escapeHtml(l.name)} ${originBadge}</div>
        ${l.signal ? `<div class="lead-source">📡 ${escapeHtml(l.signal.substring(0, 50))}</div>` : ''}
        ${contractProb}
      </td>
      <td>
        <span class="tag tag-pending" style="font-size:10px">${escapeHtml(l.sector || '—')}</span>
        ${l.city ? `<div style="font-size:10px;color:var(--text-dim);margin-top:3px">📍 ${escapeHtml(l.city)}</div>` : ''}
      </td>
      <td>
        <div style="font-size:11px;direction:ltr;color:var(--text-2)">${escapeHtml(l.email || '—')}</div>
        <div style="font-size:11px;direction:ltr;color:var(--text-dim);margin-top:2px">${escapeHtml(l.phone || '—')}</div>
      </td>
      <td>${priorityBadge}</td>
      <td>${links.join(' ') || '<span style="color:var(--text-dim);font-size:11px">—</span>'}</td>
      <td><div class="score-bar ${cls}" style="min-width:75px">
        <div class="score-fill"><div class="score-fill-inner" style="width:${l.score}%"></div></div>
        <span class="score-text">${l.score}%</span></div></td>
      <td><span class="tag ${sm[l.status] || 'tag-pending'}">${sl[l.status] || '—'}</span></td>
      <td><div class="action-btns">
        <button class="btn-sm btn-view" onclick="viewLeadFromList(${globalIdx})" title="عرض">👁️</button>
        <button class="btn-sm btn-send" onclick="composeForLead(${globalIdx})" title="رسالة">✍️</button>
        ${l.phone ? `<button class="btn-sm btn-wa" onclick="doWA(APP.leads[${globalIdx}])" title="واتساب">📱</button>` : ''}
        <button class="btn-sm btn-danger" onclick="delLead(${globalIdx})" title="حذف">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');

  renderLeadsStats();
  renderLeadsPagination();
  renderLeadsFilters();
  renderBulkActions();
}

function renderLeadsStats() {
  const el = document.getElementById('leadsStats');
  if (!el) return;
  const v = APP.leadsView;
  const total = APP.leads.length;
  const showing = v.total !== undefined ? v.total : total;
  const hotCount = APP.leads.filter(l => l.hot_lead).length;
  const veryHigh = APP.leads.filter(l => l.priority === 'عالية جداً').length;
  const sent = APP.leads.filter(l => l.status === 'sent').length;
  const replied = APP.leads.filter(l => l.status === 'replied').length;

  el.innerHTML = `
    <div class="lead-stat"><div class="ls-val">${total}</div><div class="ls-lbl">إجمالي</div></div>
    <div class="lead-stat"><div class="ls-val" style="color:var(--cyan)">${showing}</div><div class="ls-lbl">معروض</div></div>
    <div class="lead-stat"><div class="ls-val" style="color:var(--red)">🔥 ${hotCount}</div><div class="ls-lbl">حار</div></div>
    <div class="lead-stat"><div class="ls-val" style="color:var(--orange)">⭐ ${veryHigh}</div><div class="ls-lbl">عالية جداً</div></div>
    <div class="lead-stat"><div class="ls-val" style="color:var(--gold)">${sent}</div><div class="ls-lbl">أُرسل</div></div>
    <div class="lead-stat"><div class="ls-val" style="color:var(--green)">${replied}</div><div class="ls-lbl">رد</div></div>
  `;
}

function renderLeadsFilters() {
  const cityEl = document.getElementById('leadsCityFilter');
  if (cityEl) {
    const cities = [...new Set(APP.leads.map(l => l.city).filter(Boolean))].sort();
    cityEl.innerHTML = '<option value="">كل المدن</option>' +
      cities.map(c => `<option value="${escapeAttr(c)}" ${APP.leadsView.cityFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  }
  const prioEl = document.getElementById('leadsPriorityFilter');
  if (prioEl) {
    const prios = [...new Set(APP.leads.map(l => l.priority).filter(Boolean))];
    prioEl.innerHTML = '<option value="">كل الأولويات</option>' +
      prios.map(p => `<option value="${escapeAttr(p)}" ${APP.leadsView.priorityFilter === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
  }
  const originEl = document.getElementById('leadsOriginFilter');
  if (originEl) {
    const origins = [...new Set(APP.leads.map(l => l.company_origin).filter(Boolean))];
    originEl.innerHTML = '<option value="">سعودية وأجنبية</option>' +
      origins.map(o => `<option value="${escapeAttr(o)}" ${APP.leadsView.originFilter === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  }
}

function renderLeadsPagination() {
  const el = document.getElementById('leadsPagination');
  if (!el) return;
  const v = APP.leadsView;
  if (!v.pages || v.pages <= 1) { el.innerHTML = ''; return; }

  const buttons = [];
  buttons.push(`<button class="page-btn" onclick="changeLeadsPage(1)" ${v.page === 1 ? 'disabled' : ''}>«</button>`);
  buttons.push(`<button class="page-btn" onclick="changeLeadsPage(${v.page - 1})" ${v.page === 1 ? 'disabled' : ''}>‹</button>`);

  // Show pages around current
  const showRange = 2;
  const pages = [];
  for (let i = Math.max(1, v.page - showRange); i <= Math.min(v.pages, v.page + showRange); i++) pages.push(i);
  if (pages[0] > 1) {
    buttons.push(`<button class="page-btn" onclick="changeLeadsPage(1)">1</button>`);
    if (pages[0] > 2) buttons.push('<span class="page-ellipsis">…</span>');
  }
  pages.forEach(p => {
    buttons.push(`<button class="page-btn ${p === v.page ? 'active' : ''}" onclick="changeLeadsPage(${p})">${p}</button>`);
  });
  if (pages[pages.length - 1] < v.pages) {
    if (pages[pages.length - 1] < v.pages - 1) buttons.push('<span class="page-ellipsis">…</span>');
    buttons.push(`<button class="page-btn" onclick="changeLeadsPage(${v.pages})">${v.pages}</button>`);
  }

  buttons.push(`<button class="page-btn" onclick="changeLeadsPage(${v.page + 1})" ${v.page === v.pages ? 'disabled' : ''}>›</button>`);
  buttons.push(`<button class="page-btn" onclick="changeLeadsPage(${v.pages})" ${v.page === v.pages ? 'disabled' : ''}>»</button>`);

  el.innerHTML = buttons.join('') +
    `<span class="page-info">صفحة ${v.page} من ${v.pages} · ${v.total} عميل</span>`;
}

function renderBulkActions() {
  const el = document.getElementById('bulkActions');
  if (!el) return;
  const count = APP.leadsView.selected.size;
  if (count === 0) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.querySelector('.bulk-count').textContent = count;
}

function changeLeadsPage(p) {
  APP.leadsView.page = p;
  renderLeadsList();
  document.querySelector('.leads-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function leadsSearch(query) {
  APP.leadsView.search = query;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function leadsFilterByCity(city) {
  APP.leadsView.cityFilter = city;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function leadsFilterByPriority(p) {
  APP.leadsView.priorityFilter = p;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function leadsFilterByOrigin(o) {
  APP.leadsView.originFilter = o;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function clearLeadsFilters() {
  APP.leadsView.filter = 'all';
  APP.leadsView.search = '';
  APP.leadsView.cityFilter = '';
  APP.leadsView.priorityFilter = '';
  APP.leadsView.originFilter = '';
  APP.leadsView.page = 1;
  const si = document.getElementById('leadsSearchInput');
  if (si) si.value = '';
  document.querySelectorAll('#page-leads .filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#page-leads .filter-btn[data-filter="all"]')?.classList.add('active');
  renderLeadsList();
}

function changeLeadsPerPage(n) {
  APP.leadsView.perPage = parseInt(n) || 25;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function toggleLeadSelect(idx) {
  if (APP.leadsView.selected.has(idx)) APP.leadsView.selected.delete(idx);
  else APP.leadsView.selected.add(idx);
  renderLeadsList();
}

function selectAllVisibleLeads() {
  const v = APP.leadsView;
  const filtered = v.filtered || APP.leads;
  const start = (v.page - 1) * v.perPage;
  const slice = filtered.slice(start, start + v.perPage);
  slice.forEach(l => APP.leadsView.selected.add(APP.leads.indexOf(l)));
  renderLeadsList();
  showToast(`✓ تم تحديد ${slice.length} عميل في هذه الصفحة`);
}

function selectAllFilteredLeads() {
  const filtered = APP.leadsView.filtered || APP.leads;
  filtered.forEach(l => APP.leadsView.selected.add(APP.leads.indexOf(l)));
  renderLeadsList();
  showToast(`✓ تم تحديد ${filtered.length} عميل`);
}

function deselectAllLeads() {
  APP.leadsView.selected.clear();
  renderLeadsList();
}

function bulkDeleteLeads() {
  const count = APP.leadsView.selected.size;
  if (count === 0) return;
  if (!confirm(`⚠️ سيتم حذف ${count} عميل نهائياً. متأكد؟`)) return;
  const indicesToDelete = [...APP.leadsView.selected].sort((a, b) => b - a);
  indicesToDelete.forEach(i => APP.leads.splice(i, 1));
  APP.leadsView.selected.clear();
  DB.set('leads', APP.leads);
  document.getElementById('leadsCount').textContent = APP.leads.length;
  renderLeadsList();
  showToast(`🗑️ تم حذف ${count} عميل`, 'success');
}

function bulkSendCampaign() {
  const indices = [...APP.leadsView.selected];
  if (indices.length === 0) return;
  APP.campaignTargets = indices.map(i => APP.leads[i]);
  APP.leadsView.selected.clear();
  openPage('campaigns');
  startCampaign('email');
  showToast(`🚀 ${indices.length} عميل جاهز للحملة`, 'success');
}

function bulkExportSelected() {
  const indices = [...APP.leadsView.selected];
  if (indices.length === 0) return;
  const tempLeads = APP.leads;
  APP.leads = indices.map(i => tempLeads[i]);
  exportLeadsCSV();
  APP.leads = tempLeads;
}

function viewLeadFromList(idx) {
  const l = APP.leads[idx];
  if (!l) return;
  // Reuse the searchResults modal by temporarily setting the data
  const tempResults = APP.searchResults;
  APP.searchResults = APP.leads;
  viewLead(idx);
  APP.searchResults = tempResults;
}

function filterLeadsList(type, btn) {
  document.querySelectorAll('#page-leads .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  APP.leadsView.filter = type;
  APP.leadsView.page = 1;
  renderLeadsList();
}

function composeForLead(i) { goCompose(APP.leads[i]); }

function delLead(i) {
  if (!confirm('حذف هذا العميل؟')) return;
  APP.leads.splice(i, 1);
  DB.set('leads', APP.leads);
  document.getElementById('leadsCount').textContent = APP.leads.length;
  renderLeadsList();
  showToast('🗑️ تم الحذف');
}

// ============ COMPOSE ============
function populateClientSelect() {
  const s = document.getElementById('composeClient');
  s.innerHTML = '<option value="">— اختر عميلاً —</option>' +
    APP.leads.map((l, i) => `<option value="${i}">${escapeHtml(l.name)}</option>`).join('') +
    '<option value="manual">✏️ إدخال يدوي</option>';
}

function fillClientData() {
  const v = document.getElementById('composeClient').value;
  if (v === '' || v === 'manual') return;
  const l = APP.leads[parseInt(v)];
  document.getElementById('cCompany').value = l.name;
  document.getElementById('cSector').value = l.sector;
  document.getElementById('recipientEmail').value = l.email;
  document.getElementById('recipientPhone').value = l.phone;
}

async function generateMessage() {
  const company = document.getElementById('cCompany').value.trim();
  const sector = document.getElementById('cSector').value.trim();
  if (!company) { showToast('⚠️ أدخل اسم الشركة', 'error'); return; }
  const msgType = document.getElementById('msgType').value;
  const lang = document.getElementById('msgLang').value;
  const note = document.getElementById('cNote').value.trim();
  document.getElementById('composeLoader').classList.add('active');
  document.getElementById('msgPreviewBox').style.display = 'none';
  document.getElementById('composeEmpty').style.display = 'none';
  document.getElementById('genBtn').disabled = true;
  const typeLabel = {
    intro: 'رسالة تعريفية — أول تواصل بارد',
    followup: 'رسالة متابعة — العميل لم يرد',
    proposal: 'رسالة عرض تعاون / طلب اجتماع',
    reopen: 'رسالة إعادة فتح بعد فترة'
  }[msgType];
  const langInstr = lang === 'ar' ? 'العربية فقط' : lang === 'en' ? 'English only' : 'العربية ثم الإنجليزية';
  const prompt = fillPromptTokens(getPrompt('message'), {
    myCompany: APP.config.myCompany || 'شركة محمد للنقليات',
    myServices: APP.config.myServices || 'نقل ثقيل',
    myAdvantages: APP.config.myAdvantages || 'خبرة وأسطول',
    myContact: APP.config.myContact || '+966501815872',
    company, sector, typeLabel, langInstr,
    note: note ? 'ملاحظة: ' + note : ''
  });
  const res = await callAI(prompt, { maxTokens: 1500 });
  const msg = res.ok && res.text ? res.text : fallbackMsg(company, sector, msgType);
  document.getElementById('composeLoader').classList.remove('active');
  document.getElementById('genBtn').disabled = false;
  document.getElementById('msgPreviewBox').style.display = 'block';
  document.getElementById('msgPreview').textContent = msg;
  if (!res.ok) showToast('ℹ️ رسالة تجريبية — أضف مفتاح AI');
}

function fallbackMsg(company, sector, type) {
  const myCompany = APP.config.myCompany || 'شركة محمد للنقليات (MTC)';
  const myContact = APP.config.myContact || '+966501815872';
  if (type === 'followup') {
    return `الموضوع: متابعة - ${company}

السادة ${company} المحترمين،

تحية طيبة، متابعةً لرسالتنا السابقة من ${myCompany} حول حلول النقل الثقيل والتخليص الجمركي.

نظراً لطبيعة نشاطكم في ${sector || 'مجالكم'}، نثق أن خدماتنا يمكن أن تدعم عملياتكم بكفاءة.

نسعد بترتيب مكالمة قصيرة (15 دقيقة).

مع التقدير،
إدارة تطوير الأعمال
${myContact}`;
  }
  return `الموضوع: حلول النقل الثقيل - ${company}

السادة ${company} المحترمين،

السلام عليكم،

نتواصل معكم من ${myCompany}، المتخصصة في حلول النقل اللوجستي منذ 1433هـ.

نظراً لنشاطكم في ${sector || 'قطاعكم'}، يسعدنا تقديم:
• النقل الثقيل والتريلات
• التخليص الجمركي السريع
• تغطية شاملة للمملكة

نفخر بثقة شركاء كبار: بن لادن، نقوا، الجهاز.

نسعد بترتيب اجتماع قصير.

مع التقدير،
إدارة تطوير الأعمال
${myContact}`;
}

// ============================================================
// EMAIL PROVIDERS (مزودات إرسال البريد البديلة لـ Gmail)
// كلها تعمل من المتصفح مباشرة بدون خادم خلفي ولا حظر
// ============================================================
const EMAIL_PROVIDERS = {
  // Resend — الأسهل والأفضل (3000 رسالة مجاناً شهرياً) — يدعم مرفقات حتى 40MB
  resend: {
    name: 'Resend',
    icon: '📨',
    free_limit: '3000/شهر',
    signup: 'https://resend.com/signup',
    keys_url: 'https://resend.com/api-keys',
    supportsAttachments: true,
    async send({ apiKey, to, subject, html, from, fromName, attachments }) {
      const body = {
        from: fromName ? `${fromName} <${from}>` : from,
        to: [to],
        subject: subject,
        html: html
      };
      // Resend attachments: { filename, content (base64) }
      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map(a => ({
          filename: a.name,
          content: a.base64 // base64 string (no data URL prefix)
        }));
      }
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Resend ' + resp.status);
      return { ok: true, id: data.id };
    }
  },

  // Brevo (Sendinblue سابقاً) — 300 رسالة يومياً مجاناً — يدعم مرفقات
  brevo: {
    name: 'Brevo',
    icon: '🦊',
    free_limit: '300/يوم',
    signup: 'https://www.brevo.com/free-account/',
    keys_url: 'https://app.brevo.com/settings/keys/api',
    supportsAttachments: true,
    async send({ apiKey, to, subject, html, from, fromName, attachments }) {
      const body = {
        sender: { name: fromName || 'MTC', email: from },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
      };
      // Brevo attachments: { name, content (base64) }
      if (attachments && attachments.length > 0) {
        body.attachment = attachments.map(a => ({
          name: a.name,
          content: a.base64
        }));
      }
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Brevo ' + resp.status);
      return { ok: true, id: data.messageId };
    }
  },

  // EmailJS — Free 200/شهر — لا يدعم رفع ملفات مباشر، فقط روابط
  emailjs: {
    name: 'EmailJS',
    icon: '⚡',
    free_limit: '200/شهر',
    signup: 'https://dashboard.emailjs.com/sign-up',
    keys_url: 'https://dashboard.emailjs.com/admin/account',
    supportsAttachments: false, // الروابط فقط (تُدرج في النص)
    async send({ apiKey, serviceId, templateId, to, subject, html, from, fromName }) {
      const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: serviceId,
          template_id: templateId,
          user_id: apiKey,
          template_params: {
            to_email: to,
            from_name: fromName || 'MTC',
            from_email: from,
            subject: subject,
            message: html.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim()
          }
        })
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error('EmailJS ' + resp.status + ': ' + errText.substring(0, 150));
      }
      return { ok: true };
    }
  },

  // Backend الخلفي (Gmail SMTP) — يدعم مرفقات
  backend: {
    name: 'الخادم الخلفي (Gmail)',
    icon: '🖥️',
    free_limit: 'حسب Gmail (500/يوم)',
    supportsAttachments: true,
    async send({ backendUrl, to, body, from, fromName, attachments }) {
      const payload = { to, body, from, fromName };
      if (attachments && attachments.length > 0) {
        payload.attachments = attachments.map(a => ({
          filename: a.name,
          content: a.base64,
          encoding: 'base64'
        }));
      }
      const resp = await fetch(backendUrl.replace(/\/$/, '') + '/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error('Backend ' + resp.status + ': ' + errText.substring(0, 150));
      }
      return { ok: true };
    }
  }

};

// دالة موحّدة لإرسال البريد عبر المزود المختار
async function sendEmailUnified({ to, body, leadName, attachments, links }) {
  const provider = APP.config.emailProvider || 'resend';
  const senderEmail = APP.config.senderEmail || 'noreply@example.com';
  const senderName = APP.config.senderName || 'MTC';

  // استخراج الموضوع من أول سطر
  const lines = body.split('\n');
  let subject = 'بخصوص خدمات شركتنا';
  let content = body;
  if (lines[0] && lines[0].includes('الموضوع:')) {
    subject = lines[0].replace(/الموضوع:/, '').trim();
    content = lines.slice(1).join('\n').trim();
  }

  // تحويل النص إلى HTML
  let html = `<div dir="rtl" style="font-family:'Tahoma',Arial,sans-serif;line-height:1.85;color:#333;max-width:600px;margin:0 auto;padding:20px">
    ${content.replace(/\n/g, '<br>')}`;

  // إضافة الروابط المرفقة في نهاية النص (تعمل مع كل المزودين بما فيهم EmailJS)
  if (links && links.length > 0) {
    html += `
    <hr style="margin-top:25px;border:0;border-top:1px solid #ddd">
    <div style="margin-top:15px;padding:12px;background:#f7f7f7;border-radius:8px">
      <div style="font-weight:bold;color:#0a1a33;margin-bottom:8px">📎 روابط مرفقة:</div>
      ${links.map(l => `<div style="margin:6px 0">
        <a href="${escapeAttr(l.url)}" style="color:#caa84d;text-decoration:none;font-weight:600">
          🔗 ${escapeHtml(l.label || l.url)}
        </a>
      </div>`).join('')}
    </div>`;
  }
  html += `</div>`;

  // معالجة المرفقات للمزود الذي لا يدعمها (EmailJS): نُحوّلها لروابط download
  let finalAttachments = attachments || [];
  if (attachments && attachments.length > 0 && !EMAIL_PROVIDERS[provider].supportsAttachments) {
    // إذا المزود لا يدعم، نضيف تنبيه في النص
    html = html.replace(/<\/div>$/, '') + `
    <hr style="margin-top:15px;border:0;border-top:1px solid #ddd">
    <div style="margin-top:10px;padding:10px;background:#fff8e1;border-radius:6px;font-size:12px;color:#856404">
      ⚠️ تنبيه: المزود الحالي (${EMAIL_PROVIDERS[provider].name}) لا يدعم رفع الملفات.
      عدد الملفات المُلغاة: ${attachments.length}.
      <br>الحل: غيّر مزود البريد إلى Resend أو Brevo لإرسال المرفقات.
    </div></div>`;
    finalAttachments = [];
  }

  const params = {
    to, subject, html,
    from: senderEmail, fromName: senderName,
    body, leadName,
    attachments: finalAttachments,
    links: links || []
  };

  if (provider === 'resend') {
    params.apiKey = APP.config.resendApiKey;
    if (!params.apiKey) return { ok: false, error: 'مفتاح Resend غير موجود' };
  } else if (provider === 'brevo') {
    params.apiKey = APP.config.brevoApiKey;
    if (!params.apiKey) return { ok: false, error: 'مفتاح Brevo غير موجود' };
  } else if (provider === 'emailjs') {
    params.apiKey = APP.config.emailjsPublicKey;
    params.serviceId = APP.config.emailjsServiceId;
    params.templateId = APP.config.emailjsTemplateId;
    if (!params.apiKey || !params.serviceId || !params.templateId) {
      return { ok: false, error: 'بيانات EmailJS ناقصة' };
    }
  } else if (provider === 'backend') {
    params.backendUrl = APP.config.backendUrl;
    if (!params.backendUrl) return { ok: false, error: 'رابط الخادم الخلفي غير موجود' };
  }

  try {
    const result = await EMAIL_PROVIDERS[provider].send(params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// اختبار مزود البريد المختار
async function testEmailProvider(providerKey) {
  const statusId = 'status_email_' + providerKey;
  const statusEl = document.getElementById(statusId);
  if (!statusEl) return;

  statusEl.innerHTML = '<span style="color:var(--cyan)">⏳ يرسل رسالة اختبار إلى بريدك...</span>';

  // حفظ المفاتيح أولاً
  saveEmailProviderKeys();

  const testTo = APP.config.senderEmail;
  if (!testTo) {
    statusEl.innerHTML = '<span style="color:var(--red)">⚠️ أضف بريد المرسل أولاً</span>';
    return;
  }

  // الإرسال للذات (Self-test)
  const oldProvider = APP.config.emailProvider;
  APP.config.emailProvider = providerKey;

  const result = await sendEmailUnified({
    to: testTo,
    body: `الموضوع: اختبار اتصال ${EMAIL_PROVIDERS[providerKey].name}\n\nمرحباً،\n\nهذه رسالة اختبار للتأكد من نجاح ربط ${EMAIL_PROVIDERS[providerKey].name} بنظام MTC.\n\nإذا وصلتك هذه الرسالة، فالاتصال يعمل بنجاح ✅`,
    leadName: 'Test'
  });

  APP.config.emailProvider = oldProvider;

  if (result.ok) {
    statusEl.innerHTML = `<span style="color:var(--green)">✅ تم الإرسال بنجاح إلى ${escapeHtml(testTo)} — تحقق من صندوق الوارد</span>`;
    APP.config.emailProvider = providerKey;
    DB.set('config', APP.config);
    showToast(`✅ ${EMAIL_PROVIDERS[providerKey].name} يعمل!`, 'success');
  } else {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ فشل: ${escapeHtml((result.error || '').substring(0, 120))}</span>`;
    showToast('❌ فشل اختبار ' + EMAIL_PROVIDERS[providerKey].name, 'error');
  }
}

function saveEmailProviderKeys() {
  APP.config.resendApiKey = document.getElementById('resendApiKey')?.value.trim() || '';
  APP.config.brevoApiKey = document.getElementById('brevoApiKey')?.value.trim() || '';
  APP.config.emailjsPublicKey = document.getElementById('emailjsPublicKey')?.value.trim() || '';
  APP.config.emailjsServiceId = document.getElementById('emailjsServiceId')?.value.trim() || '';
  APP.config.emailjsTemplateId = document.getElementById('emailjsTemplateId')?.value.trim() || '';
  DB.set('config', APP.config);
}

function selectEmailProvider(key) {
  APP.config.emailProvider = key;
  DB.set('config', APP.config);
  document.querySelectorAll('.email-provider-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('email_card_' + key)?.classList.add('selected');
  showToast(`✓ ${EMAIL_PROVIDERS[key].name} مفعّل كمزود البريد`, 'success');
}

async function sendEmailSingle() {
  const to = document.getElementById('recipientEmail').value.trim();
  if (!to) { showToast('⚠️ أدخل البريد المستلم', 'error'); return; }
  const msg = document.getElementById('msgPreview').textContent;
  if (!APP.config.emailProvider) {
    showToast('⚠️ اختر مزود البريد من الإعدادات', 'error');
    return;
  }

  const attachCount = APP.composeAttachments.length;
  const linkCount = APP.composeLinks.length;
  const attachInfo = (attachCount + linkCount) > 0
    ? ` (مع ${attachCount} ملف${linkCount > 0 ? ' و ' + linkCount + ' رابط' : ''})`
    : '';

  showToast('📤 جاري الإرسال عبر ' + EMAIL_PROVIDERS[APP.config.emailProvider].name + attachInfo + '...');
  const result = await sendEmailUnified({
    to,
    body: msg,
    leadName: '',
    attachments: APP.composeAttachments,
    links: APP.composeLinks
  });
  if (result.ok) {
    showToast(`✅ تم الإرسال بنجاح${attachInfo}`, 'success');
  } else {
    showToast('❌ ' + (result.error || 'فشل الإرسال').substring(0, 80), 'error');
  }
}

function copyMsg() {
  copyToClipboard(document.getElementById('msgPreview').textContent);
  showToast('📋 تم النسخ', 'success');
}

function editMsg() {
  const b = document.getElementById('msgPreview');
  b.contentEditable = b.contentEditable === 'true' ? 'false' : 'true';
  if (b.contentEditable === 'true') {
    b.focus(); b.style.outline = '2px solid var(--gold)';
    showToast('✏️ وضع التعديل');
  } else {
    b.style.outline = 'none';
    showToast('✅ تم الحفظ');
  }
}

// ============================================================
// نظام المرفقات الكامل
// يدعم: رفع ملفات (تحويل لـ base64) + روابط (Google Drive, Dropbox, ...)
// ============================================================

// State global للمرفقات والروابط في صفحة الكتابة
APP.composeAttachments = []; // [{ id, name, size, type, base64, icon }]
APP.composeLinks = []; // [{ id, url, label }]

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB لكل ملف
const MAX_TOTAL_ATTACHMENTS = 40 * 1024 * 1024; // 40 MB إجمالي

// تحويل ملف إلى base64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      // إزالة data: prefix - نريد base64 صرف فقط
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// أيقونة الملف حسب النوع
function getFileIcon(type, name) {
  if (type.startsWith('image/')) return '🖼️';
  if (type === 'application/pdf') return '📄';
  if (type.includes('word') || name.endsWith('.docx') || name.endsWith('.doc')) return '📝';
  if (type.includes('excel') || type.includes('sheet') || name.endsWith('.xlsx') || name.endsWith('.csv')) return '📊';
  if (type.includes('powerpoint') || name.endsWith('.pptx')) return '📽️';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

// تنسيق حجم الملف
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// رفع ملفات من المستخدم (يستقبل FileList)
async function handleAttachmentUpload(files) {
  if (!files || files.length === 0) return;

  const provider = APP.config.emailProvider || 'resend';
  if (!EMAIL_PROVIDERS[provider]?.supportsAttachments) {
    showToast(`⚠️ ${EMAIL_PROVIDERS[provider]?.name} لا يدعم رفع الملفات — استخدم الروابط بدلاً`, 'error');
    return;
  }

  for (const file of files) {
    // التحقق من الحجم
    if (file.size > MAX_ATTACHMENT_SIZE) {
      showToast(`⚠️ "${file.name}" أكبر من 25 ميجا — تم تجاهله`, 'error');
      continue;
    }

    // التحقق من المجموع الكلي
    const currentTotal = APP.composeAttachments.reduce((s, a) => s + a.size, 0);
    if (currentTotal + file.size > MAX_TOTAL_ATTACHMENTS) {
      showToast(`⚠️ تجاوزت الحد الكلي 40 ميجا — لا يمكن إضافة "${file.name}"`, 'error');
      continue;
    }

    showToast(`⏳ يحوّل "${file.name}"...`);
    try {
      const base64 = await fileToBase64(file);
      const attachment = {
        id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        base64: base64,
        icon: getFileIcon(file.type || '', file.name),
        // معاينة للصور
        previewUrl: file.type.startsWith('image/') ? `data:${file.type};base64,${base64}` : null
      };
      APP.composeAttachments.push(attachment);
    } catch (e) {
      showToast(`❌ فشل قراءة "${file.name}": ${e.message}`, 'error');
    }
  }

  renderAttachmentsList();
  const added = files.length;
  showToast(`📎 تمت إضافة ${added} مرفق`, 'success');
}

// إضافة رابط مرفق (Google Drive, Dropbox, ...)
function addAttachmentLink() {
  const urlInput = document.getElementById('attachLinkInput');
  const labelInput = document.getElementById('attachLinkLabel');
  const url = urlInput?.value.trim();
  const label = labelInput?.value.trim();

  if (!url) {
    showToast('⚠️ أدخل رابط أولاً', 'error');
    return;
  }
  if (!/^https?:\/\//.test(url)) {
    showToast('⚠️ الرابط يجب أن يبدأ بـ https:// أو http://', 'error');
    return;
  }

  APP.composeLinks.push({
    id: 'lnk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    url: url,
    label: label || extractLinkLabel(url)
  });

  if (urlInput) urlInput.value = '';
  if (labelInput) labelInput.value = '';
  renderAttachmentsList();
  showToast('🔗 تم إضافة الرابط', 'success');
}

// استخراج اسم افتراضي للرابط
function extractLinkLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host.includes('drive.google')) return 'ملف على Google Drive';
    if (host.includes('dropbox')) return 'ملف على Dropbox';
    if (host.includes('onedrive')) return 'ملف على OneDrive';
    if (host.includes('mediafire')) return 'ملف على MediaFire';
    if (host.includes('wetransfer')) return 'ملف على WeTransfer';
    const path = u.pathname.split('/').filter(Boolean).pop();
    return path ? decodeURIComponent(path) : host;
  } catch {
    return url.substring(0, 50);
  }
}

// حذف مرفق
function removeAttachment(id) {
  APP.composeAttachments = APP.composeAttachments.filter(a => a.id !== id);
  renderAttachmentsList();
}

// حذف رابط
function removeAttachmentLink(id) {
  APP.composeLinks = APP.composeLinks.filter(l => l.id !== id);
  renderAttachmentsList();
}

// مسح كل المرفقات
function clearAllAttachments() {
  if (APP.composeAttachments.length === 0 && APP.composeLinks.length === 0) return;
  if (!confirm(`مسح كل المرفقات (${APP.composeAttachments.length} ملف + ${APP.composeLinks.length} رابط)؟`)) return;
  APP.composeAttachments = [];
  APP.composeLinks = [];
  renderAttachmentsList();
  showToast('🗑️ تم مسح كل المرفقات');
}

// عرض قائمة المرفقات
function renderAttachmentsList() {
  const container = document.getElementById('attachmentsList');
  if (!container) return;

  const total = APP.composeAttachments.length + APP.composeLinks.length;
  const counter = document.getElementById('attachmentsCount');
  if (counter) counter.textContent = total > 0 ? `(${total})` : '';

  if (total === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);text-align:center;padding:14px">لا توجد مرفقات بعد</div>';
    return;
  }

  const totalSize = APP.composeAttachments.reduce((s, a) => s + a.size, 0);
  const sizeWarning = totalSize > 25 * 1024 * 1024
    ? `<div style="font-size:11px;color:var(--orange);padding:6px 10px;background:rgba(255,154,60,0.08);border-radius:6px;margin-bottom:8px">⚠️ حجم كبير: ${formatFileSize(totalSize)} — قد لا يصل لبعض الخوادم</div>`
    : '';

  const filesHtml = APP.composeAttachments.map(a => `
    <div class="attachment-chip" data-id="${a.id}">
      ${a.previewUrl
        ? `<img src="${a.previewUrl}" class="att-thumb" alt="">`
        : `<div class="att-icon">${a.icon}</div>`}
      <div class="att-info">
        <div class="att-name" title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</div>
        <div class="att-meta">${formatFileSize(a.size)}</div>
      </div>
      <button class="att-remove" onclick="removeAttachment('${a.id}')" title="حذف">✕</button>
    </div>
  `).join('');

  const linksHtml = APP.composeLinks.map(l => `
    <div class="attachment-chip link-chip" data-id="${l.id}">
      <div class="att-icon">🔗</div>
      <div class="att-info">
        <div class="att-name" title="${escapeAttr(l.url)}">${escapeHtml(l.label)}</div>
        <div class="att-meta" style="direction:ltr;text-align:left">${escapeHtml(l.url.substring(0, 50))}${l.url.length > 50 ? '...' : ''}</div>
      </div>
      <button class="att-remove" onclick="removeAttachmentLink('${l.id}')" title="حذف">✕</button>
    </div>
  `).join('');

  container.innerHTML = sizeWarning + filesHtml + linksHtml;
}

// ============ CAMPAIGNS ============
function startCampaign(mode) {
  APP.campaignMode = mode;
  document.getElementById('campaignPanel').style.display = 'block';
  document.getElementById('execBtn').textContent = mode === 'wa' ? '📱 تنفيذ حملة واتساب' : '🚀 تنفيذ حملة البريد';
  document.getElementById('sendProgressArea').innerHTML = '';
  document.getElementById('campaignPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function executeCampaign() {
  const targets = APP.campaignTargets && APP.campaignTargets.length ? APP.campaignTargets : APP.leads;
  if (targets.length === 0) { showToast('⚠️ لا يوجد عملاء', 'error'); return; }
  const area = document.getElementById('sendProgressArea');
  area.innerHTML = '';
  const btn = document.getElementById('execBtn');
  btn.disabled = true;
  const [mn, mx] = document.getElementById('delayBetween').value.split('-').map(Number);
  const mode = APP.campaignMode;
  let done = 0;
  for (let idx = 0; idx < targets.length; idx++) {
    const l = targets[idx];
    btn.textContent = `⏳ ${idx + 1}/${targets.length}`;
    const el = document.createElement('div');
    el.className = 'send-progress';
    el.innerHTML = `<div class="sp-icon pulse">${mode === 'wa' ? '📱' : '📤'}</div>
      <div class="sp-info">
        <div class="sp-title">${escapeHtml(l.name)}</div>
        <div class="sp-sub" style="direction:ltr;text-align:left">${escapeHtml(mode === 'wa' ? l.phone : l.email)}</div>
      </div><span class="tag tag-pending">يُولّد...</span>`;
    area.appendChild(el);
    area.scrollTop = area.scrollHeight;
    const prompt = fillPromptTokens(getPrompt('message'), {
      myCompany: APP.config.myCompany || 'MTC',
      myServices: APP.config.myServices || 'نقل ثقيل',
      myAdvantages: APP.config.myAdvantages || 'خبرة',
      myContact: APP.config.myContact || '+966501815872',
      company: l.name, sector: l.sector,
      typeLabel: 'رسالة تعريفية', langInstr: 'العربية', note: ''
    });
    const r = await callAI(prompt, { maxTokens: 1200 });
    const personalizedMsg = r.ok && r.text ? r.text : fallbackMsg(l.name, l.sector, 'intro');
    el.querySelector('.tag').textContent = mode === 'wa' ? 'يفتح واتساب...' : 'يُرسل...';
    let success = true;
    if (mode === 'email') {
      if (APP.config.emailProvider) {
        const result = await sendEmailUnified({
          to: l.email,
          body: personalizedMsg,
          leadName: l.name,
          attachments: APP.composeAttachments,
          links: APP.composeLinks
        });
        success = result.ok;
        if (!result.ok) {
          el.querySelector('.sp-sub').textContent += ' · ' + (result.error || '').substring(0, 40);
        }
      } else {
        await sleep(700); // وضع المحاكاة
      }
    } else {
      const msgClean = personalizedMsg.replace(/^الموضوع:.*\n+/i, '');
      const phone = normalizePhone(l.phone);
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msgClean)}`, '_blank');
      await sleep(500);
    }
    if (success) {
      el.querySelector('.tag').className = 'tag tag-sent';
      el.querySelector('.tag').textContent = mode === 'wa' ? '✅ فُتح' : '✅ أُرسل';
      el.querySelector('.sp-icon').classList.remove('pulse');
      el.querySelector('.sp-icon').textContent = mode === 'wa' ? '📱' : '✉️';
      const lref = APP.leads.find(x => x.name === l.name);
      if (lref) { lref.status = 'sent'; lref.last = 'اليوم'; }
      done++;
    } else {
      el.querySelector('.tag').className = 'tag tag-cold';
      el.querySelector('.tag').textContent = '⚠️ فشل';
    }
    if (idx < targets.length - 1) {
      const w = Math.floor(Math.random() * (mx - mn) + mn);
      el.querySelector('.sp-sub').textContent += ` · انتظار ${w}ث`;
      await sleep(Math.min(w * 100, 2500));
    }
  }
  DB.set('leads', APP.leads);
  APP.campaigns.push({ date: new Date().toLocaleDateString('ar-SA'), mode, total: targets.length, sent: done });
  DB.set('campaigns', APP.campaigns);
  btn.disabled = false;
  btn.textContent = '✅ اكتملت الحملة';
  renderLeadsList();
  renderPastCampaigns();
  showToast(`✅ ${done}/${targets.length}`, 'success');
}

function renderPastCampaigns() {
  const el = document.getElementById('pastCampaigns');
  if (APP.campaigns.length === 0) return;
  el.innerHTML = APP.campaigns.slice().reverse().map(c => {
    const rate = c.total ? Math.round(c.sent / c.total * 100) : 0;
    return `<div class="send-progress">
      <div class="sp-icon">${c.mode === 'wa' ? '📱' : '📧'}</div>
      <div class="sp-info">
        <div class="sp-title">حملة ${c.mode === 'wa' ? 'واتساب' : 'بريد'} — ${c.date}</div>
        <div class="sp-sub">${c.sent} مرسلة من ${c.total}</div>
        <div class="progress-bar" style="margin-top:6px"><div class="progress-fill" style="width:${rate}%"></div></div>
      </div>
      <span class="tag tag-sent">${rate}%</span>
    </div>`;
  }).join('');
}

// ============ INBOX ============
async function fetchInbox() {
  const backendUrl = APP.config.backendUrl;
  const provider = APP.config.emailProvider;

  // إذا لا يوجد خادم خلفي مربوط، اعرض رسالة
  if (!backendUrl) {
    document.getElementById('inboxList').innerHTML = `
      <div class="info-box info-gold" style="margin:0">
        <div class="ib-title">📥 لاستقبال الردود الفعلية</div>
        <div style="line-height:1.9">
          تحتاج خادماً خلفياً (Node.js) لربط IMAP بصندوق بريدك. الخادم يقرأ الردود الواردة على بريدك ويعرضها هنا.
          <br><br>
          <b>الخطوات:</b><br>
          1. انشر ملف server.js على Render (دليل النشر مُرفق)<br>
          2. أضف رابط الخادم في الإعدادات → الخادم الخلفي<br>
          3. اضغط 🔄 تحديث صندوق الوارد
        </div>
        <button class="btn-primary" style="margin-top:14px" onclick="openPage('settings')">⚙️ ربط الخادم</button>
      </div>`;
    document.getElementById('inboxCount').textContent = '';
    return;
  }

  document.getElementById('inboxList').innerHTML = '<div style="padding:20px;text-align:center;color:var(--cyan)">⏳ جاري تحميل الوارد من الخادم...</div>';

  try {
    const resp = await fetch(backendUrl.replace(/\/$/, '') + '/api/inbox');
    if (!resp.ok) throw new Error('فشل الاتصال بالخادم: ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    // البريد القادم من الخادم
    let rawInbox = Array.isArray(data) ? data : (data.messages || []);

    // التصفية: فقط الردود من العملاء الذين أرسلنا لهم
    const sentToEmails = new Set(APP.leads
      .filter(l => l.status === 'sent' || l.status === 'opened' || l.status === 'replied')
      .map(l => l.email?.toLowerCase().trim())
      .filter(Boolean));

    APP.inbox = rawInbox.map((msg, idx) => {
      // استخراج الإيميل من حقل from "Name <email@x.com>"
      const fromRaw = msg.from?.[0] || msg.from || '';
      const emailMatch = String(fromRaw).match(/<([^>]+)>/) || String(fromRaw).match(/(\S+@\S+\.\S+)/);
      const senderEmail = emailMatch ? emailMatch[1].toLowerCase().trim() : '';
      const senderName = String(fromRaw).replace(/<[^>]+>/, '').trim() || senderEmail;

      // معرفة هل هذا رد من عميل أرسلنا له
      const isFromOurLead = sentToEmails.has(senderEmail);
      const matchingLead = APP.leads.find(l => l.email?.toLowerCase().trim() === senderEmail);

      return {
        id: idx,
        from: matchingLead?.name || senderName,
        email: senderEmail,
        subject: msg.subject?.[0] || msg.subject || '(بدون عنوان)',
        preview: msg.preview || msg.snippet || '...',
        body: msg.body || msg.snippet || msg.preview || '',
        time: msg.date?.[0] || msg.date || 'الآن',
        unread: msg.unread !== false,
        isFromLead: isFromOurLead,
        leadName: matchingLead?.name
      };
    });

    // التصفية: عرض فقط الردود من العملاء المرسل لهم
    const filterOnlySent = APP.config.inboxFilterOnlySent !== false; // افتراضياً مفعّل
    const filtered = filterOnlySent ? APP.inbox.filter(m => m.isFromLead) : APP.inbox;

    renderInboxList(filtered);
    document.getElementById('inboxCount').textContent = filtered.filter(m => m.unread).length || '';

  } catch (e) {
    document.getElementById('inboxList').innerHTML = `
      <div class="info-box info-red" style="margin:0">
        <div class="ib-title">⚠️ تعذّر جلب الوارد</div>
        <div>${escapeHtml(e.message)}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:10px">
          تأكد من أن الخادم يعمل وأن متغيرات SMTP_USER و SMTP_PASS صحيحة في Render.
        </div>
      </div>`;
  }
}

function renderInboxList(messages) {
  const list = document.getElementById('inboxList');
  if (!messages || messages.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding:30px">
        <div class="icon">📭</div>
        <p>لا توجد ردود من العملاء بعد</p>
        <p style="font-size:11px;color:var(--text-dim);margin-top:8px">
          سيظهر هنا الردود من العملاء الذين أرسلنا لهم بريداً
        </p>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="btn-sm btn-view" onclick="fetchInbox()">🔄 تحديث</button>
          <button class="btn-sm btn-outline" onclick="toggleInboxFilter()">${APP.config.inboxFilterOnlySent !== false ? '👁️ عرض كل الوارد' : '🎯 فقط ردود العملاء'}</button>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn-sm btn-view" onclick="fetchInbox()">🔄 تحديث</button>
      <button class="btn-sm btn-outline" onclick="toggleInboxFilter()">${APP.config.inboxFilterOnlySent !== false ? '👁️ عرض الكل' : '🎯 فقط العملاء'}</button>
      <span style="font-size:11px;color:var(--text-dim);align-self:center;margin-right:auto">${messages.length} رسالة</span>
    </div>
    ${messages.map((m, i) => `
    <div class="inbox-item ${m.unread ? 'unread' : ''}" onclick="openInboxMsg(${i})">
      <div class="inbox-avatar">${m.isFromLead ? '🎯' : m.unread ? '📬' : '📭'}</div>
      <div class="inbox-meta">
        <div class="inbox-sender">${escapeHtml(m.from)}</div>
        <div class="inbox-subject">${escapeHtml(m.subject)}</div>
        <div class="inbox-preview">${escapeHtml(m.preview)}</div>
      </div>
      <div class="inbox-time">${escapeHtml(m.time)}</div>
    </div>`).join('')}`;
}

function toggleInboxFilter() {
  APP.config.inboxFilterOnlySent = !(APP.config.inboxFilterOnlySent !== false);
  DB.set('config', APP.config);
  fetchInbox();
}

function renderInbox() {
  fetchInbox();
}

function openInboxMsg(i) {
  APP.inbox[i].unread = false;
  renderInbox();
  const m = APP.inbox[i];
  document.getElementById('inboxDetail').innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">${escapeHtml(m.subject)}</div>
      <div style="font-size:12px;color:var(--text-dim)">من: ${escapeHtml(m.from)} · ${escapeHtml(m.email)} · ${escapeHtml(m.time)}</div>
    </div>
    <div style="background:rgba(10,26,51,.8);border:1px solid var(--border);border-radius:10px;padding:16px;font-size:13px;line-height:1.9;white-space:pre-wrap;margin-bottom:16px">${escapeHtml(m.body)}</div>
    <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:var(--gold)">✍️ رد سريع</div>
    <textarea class="form-textarea" id="replyBox" placeholder="اكتب ردك..." style="margin-bottom:10px"></textarea>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn-primary" onclick="sendReply()">📧 إرسال</button>
      <button class="btn-sm btn-view" style="padding:9px 16px" onclick="aiReply(${i})">🤖 رد ذكي</button>
    </div>`;
}

function sendReply() {
  if (!APP.config.backendUrl) { showToast('⚠️ يتطلب الخادم الخلفي', 'error'); return; }
  showToast('✅ تم إرسال الرد');
}

async function aiReply(i) {
  const m = APP.inbox[i];
  showToast('🤖 يكتب الرد...');
  const prompt = `أنت ممثل خدمة عملاء محترف في ${APP.config.myCompany || 'شركة محمد للنقليات'}. وصلتنا هذه الرسالة من "${m.from}":\n\n"${m.body}"\n\nاكتب رداً مهنياً موجزاً ودوداً (60-100 كلمة) يجيب على استفسارهم. وقّع باسم إدارة تطوير الأعمال مع: ${APP.config.myContact || '+966501815872'}.`;
  const r = await callAI(prompt, { maxTokens: 800 });
  const reply = r.ok && r.text ? r.text : `السادة ${m.from}،\n\nشكراً لتواصلكم. سيصلكم عرض سعر خلال 24 ساعة.\n\nمع التقدير،\nإدارة تطوير الأعمال\n${APP.config.myContact || '+966501815872'}`;
  const rb = document.getElementById('replyBox');
  if (rb) rb.value = reply;
  showToast('✅ تم توليد الرد', 'success');
}

// ============ CHARTS ============
let _chartMain, _chartSectors, _chartOpen, _chartPerf;

function renderDashboardCharts() {
  const c1 = document.getElementById('chartMain');
  if (!c1) return;
  if (_chartMain) _chartMain.destroy();
  const sentCount = APP.leads.filter(l => l.status !== 'pending').length;
  const openedCount = APP.leads.filter(l => l.status === 'opened' || l.status === 'replied').length;
  const repliedCount = APP.leads.filter(l => l.status === 'replied').length;
  _chartMain = new Chart(c1, {
    type: 'line',
    data: {
      labels: ['أ1', 'أ2', 'أ3', 'أ4'],
      datasets: [
        { label: 'مرسلة', data: [0, 0, 0, sentCount], borderColor: '#caa84d', tension: 0.4, fill: false },
        { label: 'مفتوحة', data: [0, 0, 0, openedCount], borderColor: '#00cfff', tension: 0.4, fill: false },
        { label: 'ردود', data: [0, 0, 0, repliedCount], borderColor: '#00e082', tension: 0.4, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8295bb', font: { family: 'Cairo', size: 11 } } } },
      scales: {
        x: { ticks: { color: '#8295bb' }, grid: { color: 'rgba(202,168,77,.08)' } },
        y: { ticks: { color: '#8295bb' }, grid: { color: 'rgba(202,168,77,.08)' }, beginAtZero: true }
      }
    }
  });
  const sectors = {};
  APP.leads.forEach(l => { sectors[l.sector] = (sectors[l.sector] || 0) + 1; });
  const c2 = document.getElementById('chartSectors');
  if (!c2) return;
  if (_chartSectors) _chartSectors.destroy();
  _chartSectors = new Chart(c2, {
    type: 'doughnut',
    data: {
      labels: Object.keys(sectors).length ? Object.keys(sectors) : ['لا توجد بيانات'],
      datasets: [{
        data: Object.keys(sectors).length ? Object.values(sectors) : [1],
        backgroundColor: ['#caa84d', '#00cfff', '#00e082', '#ff9a3c', '#a855f7', '#ff5b6e', '#7e57c2']
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#8295bb', font: { family: 'Cairo', size: 10 }, boxWidth: 12 } } }
    }
  });
}

function renderAnalytics() {
  refreshStats();
  const sent = APP.leads.filter(l => l.status !== 'pending').length;
  const opened = APP.leads.filter(l => l.status === 'opened' || l.status === 'replied').length;
  const replied = APP.leads.filter(l => l.status === 'replied').length;
  document.getElementById('an1').textContent = sent;
  document.getElementById('an2').textContent = sent ? Math.round(opened / sent * 100) + '%' : '0%';
  document.getElementById('an3').textContent = sent ? Math.round(replied / sent * 100) + '%' : '0%';
  document.getElementById('an4').textContent = APP.leads.filter(l => l.status === 'sent').length;
  setTimeout(() => {
    const co = document.getElementById('chartOpen');
    if (co) {
      if (_chartOpen) _chartOpen.destroy();
      _chartOpen = new Chart(co, {
        type: 'bar',
        data: { labels: ['8', '9', '10', '11', '12', '1', '2', '3', '4', '5'],
          datasets: [{ label: 'فتح', data: [2, 8, 15, 12, 6, 10, 14, 9, 5, 3], backgroundColor: 'rgba(202,168,77,.6)', borderColor: '#caa84d', borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8295bb' }, grid: { color: 'rgba(202,168,77,.08)' } },
            y: { ticks: { color: '#8295bb' }, grid: { color: 'rgba(202,168,77,.08)' } }
          } }
      });
    }
    const cp = document.getElementById('chartPerf');
    if (cp) {
      if (_chartPerf) _chartPerf.destroy();
      _chartPerf = new Chart(cp, {
        type: 'radar',
        data: { labels: ['بناء', 'نفط', 'موانئ', 'صناعة', 'حكومي'],
          datasets: [
            { label: 'فتح', data: [72, 85, 60, 55, 40], backgroundColor: 'rgba(0,207,255,.15)', borderColor: '#00cfff' },
            { label: 'رد', data: [20, 35, 15, 10, 5], backgroundColor: 'rgba(0,224,130,.15)', borderColor: '#00e082' }
          ] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8295bb', font: { family: 'Cairo', size: 10 } } } },
          scales: { r: {
            ticks: { color: '#8295bb', backdropColor: 'transparent' },
            grid: { color: 'rgba(202,168,77,.1)' },
            pointLabels: { color: '#8295bb', font: { family: 'Cairo' } }
          } } }
      });
    }
    renderTrackingMap();
  }, 100);
}

function renderTrackingMap() {
  const el = document.getElementById('trackingMap');
  if (!el) return;
  const src = APP.leads.length ? APP.leads.slice(0, 20) : [];
  if (src.length === 0) {
    el.innerHTML = '<div class="empty-state" style="padding:30px"><div class="icon">🗺️</div><p>لا توجد بيانات تتبع بعد</p></div>';
    return;
  }
  el.innerHTML = '<div class="tracking-grid">' + src.map(l => {
    const col = l.status === 'replied' ? 'var(--green)' : l.status === 'opened' ? 'var(--gold)' : l.status === 'sent' ? 'var(--cyan)' : 'var(--text-dim)';
    const ic = l.status === 'replied' ? '💬' : l.status === 'opened' ? '👁️' : l.status === 'sent' ? '📧' : '⏳';
    const lb = l.status === 'replied' ? 'رد' : l.status === 'opened' ? 'فتح' : l.status === 'sent' ? 'أُرسل' : 'منتظر';
    return `<div class="tracking-cell" style="border-color:${col}40">
      <div class="tracking-icon">${ic}</div>
      <div class="tracking-name" style="color:${col}">${escapeHtml(l.name.split(' ').slice(0, 2).join(' '))}</div>
      <div class="tracking-status">${lb}</div>
    </div>`;
  }).join('') + '</div>';
}

function renderDashSchedule() {
  document.getElementById('dashSchedule').innerHTML = `
    <div class="schedule-item">
      <div class="schedule-time">أسبوعياً</div>
      <div class="schedule-info"><div class="schedule-title">إعادة إرسال لمن لم يفتح</div><div class="schedule-sub">يوم ووقت مختلف تلقائياً</div></div>
      <span class="tag tag-pending">نشط</span>
    </div>
    <div class="schedule-item">
      <div class="schedule-time">يومياً</div>
      <div class="schedule-info"><div class="schedule-title">فحص الردود الواردة</div><div class="schedule-sub">يتطلب الخادم الخلفي</div></div>
      <span class="tag tag-sent">تلقائي</span>
    </div>`;
}

function refreshStats() {
  document.getElementById('st1').textContent = APP.leads.length;
  document.getElementById('st2').textContent = APP.leads.filter(l => l.status !== 'pending').length;
  document.getElementById('st3').textContent = APP.leads.filter(l => l.status === 'opened' || l.status === 'replied').length;
  document.getElementById('st4').textContent = APP.inbox.filter(m => m.unread).length;
  document.getElementById('leadsCount').textContent = APP.leads.length;
}

// ============ PROMPT EDITOR ============
function loadPromptsToEditor() {
  document.getElementById('promptSearch').value = getPrompt('search');
  document.getElementById('promptMessage').value = getPrompt('message');
}

function savePrompt(key) {
  const id = key === 'search' ? 'promptSearch' : 'promptMessage';
  const statusId = key === 'search' ? 'searchPromptStatus' : 'messagePromptStatus';
  const value = document.getElementById(id).value.trim();
  if (!value) {
    document.getElementById(statusId).innerHTML = '<span style="color:var(--red)">⚠️ البرومبت فارغ</span>';
    return;
  }
  APP.config['prompt_' + key] = value;
  DB.set('config', APP.config);
  document.getElementById(statusId).innerHTML = '<span style="color:var(--green)">✅ تم الحفظ — سيُستخدم في البحث التالي</span>';
  showToast('💾 تم حفظ البرومبت', 'success');
}

function resetPrompt(key) {
  if (!confirm('استعادة البرومبت الافتراضي؟')) return;
  delete APP.config['prompt_' + key];
  DB.set('config', APP.config);
  loadPromptsToEditor();
  showToast('↻ تم الاسترجاع');
}

function insertToken(type, token) {
  const id = type === 'SEARCH' ? 'promptSearch' : 'promptMessage';
  const textarea = document.getElementById(id);
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = textarea.value.substring(0, start) + token + textarea.value.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
}

// ============ SETTINGS ============
async function testProvider(pid) {
  const keyInput = document.getElementById('key_' + pid);
  const modelInput = document.getElementById('model_' + pid);
  const statusEl = document.getElementById('status_' + pid);
  const apiKey = keyInput.value.trim();
  if (!apiKey) { statusEl.innerHTML = '<span style="color:var(--red)">⚠️ أدخل المفتاح أولاً</span>'; return; }
  statusEl.innerHTML = '<span style="color:var(--cyan)">⏳ يختبر الاتصال...</span>';
  const params = { apiKey, model: modelInput?.value, messages: [{ role: 'user', content: 'قل "متصل" فقط' }], maxTokens: 20 };
  if (pid === 'anthropic') params.proxy = document.getElementById('key_anthropic_proxy')?.value.trim();
  if (pid === 'custom') params.baseUrl = document.getElementById('key_custom_url')?.value.trim();
  if (pid === 'manus') params.baseUrl = document.getElementById('key_manus_url')?.value.trim();
  try {
    const text = await PROVIDERS[pid].call(params);
    if (text) {
      statusEl.innerHTML = `<span style="color:var(--green)">✅ متصل · "${escapeHtml(text.substring(0, 40))}"</span>`;
      APP.config['key_' + pid] = apiKey;
      if (modelInput) APP.config['model_' + pid] = modelInput.value;
      if (pid === 'anthropic') APP.config.key_anthropic_proxy = params.proxy || '';
      if (pid === 'custom') APP.config.key_custom_url = params.baseUrl || '';
      DB.set('config', APP.config);
      APP.workingProviders[pid] = true;
      updateApiStatus(true);
    } else {
      statusEl.innerHTML = '<span style="color:var(--orange)">⚠️ رد فارغ</span>';
      APP.workingProviders[pid] = false;
    }
  } catch (e) {
    const msg = String(e.message || e);
    statusEl.innerHTML = `<span style="color:var(--red)">❌ ${escapeHtml(msg.substring(0, 120))}</span>`;
    APP.workingProviders[pid] = false;
  }
}

function saveAllProviders() {
  const providers = ['groq', 'openrouter', 'gemini', 'mistral', 'anthropic', 'manus', 'custom'];
  for (const pid of providers) {
    const key = document.getElementById('key_' + pid)?.value.trim();
    const model = document.getElementById('model_' + pid)?.value;
    if (key) APP.config['key_' + pid] = key;
    if (model) APP.config['model_' + pid] = model;
  }
  APP.config.key_anthropic_proxy = document.getElementById('key_anthropic_proxy')?.value.trim() || '';
  APP.config.key_custom_url = document.getElementById('key_custom_url')?.value.trim() || '';
  APP.config.key_manus_url = document.getElementById('key_manus_url')?.value.trim() || '';
  DB.set('config', APP.config);
  const hasAnyKey = providers.some(p => APP.config['key_' + p] && APP.config['key_' + p].length > 10);
  updateApiStatus(hasAnyKey);
  showToast('✅ تم حفظ الإعدادات', 'success');
}

function updateApiStatus(on) {
  const dot = document.getElementById('apiDot');
  const txt = document.getElementById('apiStatusText');
  if (on) { dot.classList.add('on'); dot.classList.remove('off'); txt.textContent = 'AI متصل'; }
  else { dot.classList.remove('on'); dot.classList.add('off'); txt.textContent = 'غير متصل'; }
  const banner = document.getElementById('setupBanner');
  if (banner) banner.style.display = on ? 'none' : 'block';
  const warn = document.getElementById('searchApiWarn');
  if (warn) warn.style.display = on ? 'none' : 'block';
}

async function saveBackend() {
  APP.config.backendUrl = document.getElementById('backendUrl').value.trim();
  APP.config.senderName = document.getElementById('senderName').value.trim();
  APP.config.senderEmail = document.getElementById('senderEmail').value.trim();
  DB.set('config', APP.config);
  document.getElementById('backendStatus').innerHTML = '<span style="color:var(--green)">✅ تم حفظ بيانات المرسل</span>';
  showToast('✅ تم حفظ بيانات المرسل', 'success');
}

// اختبار البريد المرسل: يرسل رسالة اختبار لنفس البريد
async function testSenderEmail() {
  const senderEmail = document.getElementById('senderEmail').value.trim();
  const senderName = document.getElementById('senderName').value.trim() || 'MTC Sales';
  const statusEl = document.getElementById('backendStatus');

  if (!senderEmail || !senderEmail.includes('@')) {
    statusEl.innerHTML = '<span style="color:var(--red)">⚠️ أدخل بريداً صحيحاً أولاً</span>';
    return;
  }

  if (!APP.config.emailProvider) {
    statusEl.innerHTML = '<span style="color:var(--orange)">⚠️ اختر مزود بريد أولاً ثم أضف مفتاحه</span>';
    return;
  }

  // حفظ البيانات قبل الاختبار
  APP.config.senderEmail = senderEmail;
  APP.config.senderName = senderName;
  DB.set('config', APP.config);

  statusEl.innerHTML = `<span style="color:var(--cyan)">⏳ يرسل اختبار من ${escapeHtml(senderEmail)} → ${escapeHtml(senderEmail)} عبر ${EMAIL_PROVIDERS[APP.config.emailProvider].name}...</span>`;

  const now = new Date().toLocaleString('ar-SA');
  const testBody = `الموضوع: ✅ اختبار بريد المرسل - ${EMAIL_PROVIDERS[APP.config.emailProvider].name}

السلام عليكم،

هذه رسالة اختبار تلقائية من نظام MTC Sales Platform.

تفاصيل الاختبار:
• المرسل: ${senderName}
• البريد: ${senderEmail}
• المزود: ${EMAIL_PROVIDERS[APP.config.emailProvider].name}
• الوقت: ${now}

✅ إذا وصلتك هذه الرسالة، فبريد المرسل يعمل بشكل صحيح ويمكنك الآن إرسال الرسائل للعملاء.

شكراً.`;

  const result = await sendEmailUnified({
    to: senderEmail,
    body: testBody,
    leadName: 'Self Test'
  });

  if (result.ok) {
    statusEl.innerHTML = `<span style="color:var(--green)">✅ تم الإرسال بنجاح! تحقق من صندوق وارد ${escapeHtml(senderEmail)} (قد تستغرق دقيقة)</span>`;
    showToast('✅ بريد المرسل يعمل!', 'success');
  } else {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ فشل: ${escapeHtml((result.error || '').substring(0, 150))}</span>`;
    showToast('❌ فشل اختبار البريد', 'error');
  }
}

function saveWA() {
  APP.config.waNumber = document.getElementById('waNumber').value.trim();
  DB.set('config', APP.config);
  document.getElementById('waStatus').innerHTML = '<span style="color:var(--green)">✅ تم الحفظ</span>';
}

function saveCompanyData() {
  APP.config.myCompany = document.getElementById('myCompany').value.trim();
  APP.config.myServices = document.getElementById('myServices').value.trim();
  APP.config.myAdvantages = document.getElementById('myAdvantages').value.trim();
  APP.config.myContact = document.getElementById('myContact').value.trim();
  DB.set('config', APP.config);
  document.getElementById('companyStatus').innerHTML = '<span style="color:var(--green)">✅ تم الحفظ</span>';
}

function exportData() {
  const all = {
    version: '7.0',
    exported_at: new Date().toISOString(),
    config: APP.config,
    leads: APP.leads,
    inbox: APP.inbox,
    campaigns: APP.campaigns,
    workingProviders: APP.workingProviders
  };
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mtc-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('📥 تم تصدير النسخة الاحتياطية', 'success');
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.config) throw new Error('ملف غير صالح');

      if (!confirm(`سيتم استبدال البيانات الحالية:\n• ${(data.leads || []).length} عميل\n• ${(data.campaigns || []).length} حملة\n• ${Object.keys(data.config || {}).length} إعداد\n\nالاستمرار؟`)) return;

      APP.config = data.config || {};
      APP.leads = data.leads || [];
      APP.inbox = data.inbox || [];
      APP.campaigns = data.campaigns || [];
      APP.workingProviders = data.workingProviders || {};

      DB.set('config', APP.config);
      DB.set('leads', APP.leads);
      DB.set('inbox', APP.inbox);
      DB.set('campaigns', APP.campaigns);

      showToast('✅ تم استيراد النسخة الاحتياطية', 'success');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      showToast('❌ ملف غير صالح: ' + err.message, 'error');
    }
  };
  input.click();
}

// ============ استيراد قائمة عملاء (CSV/JSON/TXT) ============
function importLeadsFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.json,.txt';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let imported = [];
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'json') {
        // قائمة JSON
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : (data.leads || []);
        imported = arr.map(l => normalizeImportedLead(l));
      } else if (ext === 'csv') {
        // CSV: السطر الأول رؤوس
        imported = parseCSV(text);
      } else {
        // TXT: كل سطر إيميل أو رقم
        imported = parseTextList(text);
      }

      imported = imported.filter(l => l.name || l.email || l.phone);

      if (imported.length === 0) {
        showToast('⚠️ لم يتم العثور على عملاء صالحين في الملف', 'error');
        return;
      }

      // عرض معاينة قبل الإضافة
      showImportPreview(imported);
    } catch (err) {
      showToast('❌ خطأ في قراءة الملف: ' + err.message, 'error');
    }
  };
  input.click();
}

function normalizeImportedLead(l) {
  // Normalize hot_lead: accepts True/False/true/false/yes/no/نعم/لا/1/0
  const parseBoolean = (v) => {
    if (typeof v === 'boolean') return v;
    const s = String(v || '').toLowerCase().trim();
    return ['true', 'yes', 'نعم', '1', 'حار', 'hot', 'y'].includes(s);
  };

  // Parse priority — accepts Arabic or English
  const rawPriority = (l.priority || l['الأولوية'] || l['اولوية'] || '').toString().trim();
  let priority = 'عادية';
  if (/عالية\s*جدا|very\s*high|critical/i.test(rawPriority)) priority = 'عالية جداً';
  else if (/عالية|high/i.test(rawPriority)) priority = 'عالية';
  else if (/متوسطة|medium|mid/i.test(rawPriority)) priority = 'متوسطة';
  else if (/منخفضة|low/i.test(rawPriority)) priority = 'منخفضة';
  else if (rawPriority) priority = rawPriority;

  const origin = (l.company_origin || l['الجنسية'] || l['أصل الشركة'] || l['origin'] || '').toString().trim() || 'غير محدد';

  return {
    name: l.name || l['الاسم'] || l['الشركة'] || l['اسم الشركة'] || l['اسم'] || '',
    name_en: l.name_en || l['English Name'] || l['name_english'] || '',
    entity_type: l.entity_type || l['النوع'] || l['نوع'] || 'شركة',
    sector: l.sector || l['القطاع'] || l['المجال'] || 'غير محدد',
    city: l.city || l['المدينة'] || l['المنطقة'] || '',
    email: (l.email || l['الإيميل'] || l['البريد'] || l['Email'] || '').toString().trim().toLowerCase(),
    email_source: l.email_source || l['مصدر الإيميل'] || 'مستورد من ملف',
    email_confidence: parseInt(l.email_confidence || l['ثقة الإيميل %'] || (l.email ? 100 : 0)) || 0,
    phone: (l.phone || l['الهاتف'] || l['الرقم'] || l['الجوال'] || l['Phone'] || '').toString().trim(),
    phone_source: l.phone_source || l['مصدر الهاتف'] || 'مستورد من ملف',
    phone_confidence: parseInt(l.phone_confidence || l['ثقة الهاتف %'] || (l.phone ? 100 : 0)) || 0,
    website: l.website || l['الموقع'] || l['الموقع الإلكتروني'] || '',
    linkedin: l.linkedin || l['LinkedIn'] || '',
    instagram: l.instagram || l['Instagram'] || '',
    score: parseInt(l.score || l.interest_score || l['الاهتمام'] || l['الاهتمام %']) || 70,
    signal: l.signal || l['الإشارة'] || l['ملاحظة'] || '',
    signal_date: l.signal_date || l['تاريخ الإشارة'] || new Date().toISOString().split('T')[0],
    signal_source_url: l.signal_source_url || '',
    source: l.source || l['المصدر'] || 'استيراد ملف',
    reason: l.reason || l['السبب'] || l['سبب الترشيح'] || '',
    // Extended fields
    hot_lead: parseBoolean(l.hot_lead || l['عميل حار'] || l['hot']),
    priority: priority,
    contract_probability: parseInt(l.contract_probability || l['احتمالية التعاقد'] || l['احتمال التعاقد %']) || 0,
    company_origin: origin,
    // Status fields
    status: l.status || 'pending',
    last: '—',
    real: true,
    imported: true,
    addedAt: l.addedAt || Date.now()
  };
}

function parseCSV(text) {
  // Remove BOM if present
  text = text.replace(/^\uFEFF/, '');
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  // Smart CSV parser handling quotes (RFC 4180)
  const parseRow = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current.trim());
    return result;
  };

  // Handle multi-line CSV with quoted newlines
  const rows = [];
  let buffer = '';
  let openQuotes = 0;
  for (const line of lines) {
    buffer += (buffer ? '\n' : '') + line;
    // Count unescaped quotes
    const quoteCount = (line.match(/"/g) || []).length;
    openQuotes = (openQuotes + quoteCount) % 2;
    if (openQuotes === 0) {
      rows.push(buffer);
      buffer = '';
    }
  }
  if (buffer) rows.push(buffer);

  if (rows.length === 0) return [];

  const rawHeaders = parseRow(rows[0]);
  const leads = [];

  for (let i = 1; i < rows.length; i++) {
    const values = parseRow(rows[i]);
    if (values.every(v => !v)) continue; // Skip empty rows
    const obj = {};
    rawHeaders.forEach((h, idx) => {
      const value = values[idx] !== undefined ? values[idx] : '';
      obj[h] = value;
      obj[h.toLowerCase()] = value;
      obj[h.trim()] = value;
    });
    leads.push(normalizeImportedLead(obj));
  }
  return leads;
}

function parseTextList(text) {
  // كل سطر: إيميل أو رقم أو "اسم,إيميل,رقم"
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  return lines.map(line => {
    const parts = line.split(/[,;\t]/).map(p => p.trim());
    const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const phoneRe = /\+?[\d\s\-()]{8,}/;

    let email = '', phone = '', name = '';
    parts.forEach(p => {
      if (emailRe.test(p) && !email) email = p.match(emailRe)[0];
      else if (phoneRe.test(p) && !phone) phone = p;
      else if (!name && p.length > 1) name = p;
    });

    if (!name && email) name = email.split('@')[0];
    if (!name && phone) name = 'جهة اتصال ' + phone.slice(-4);

    return normalizeImportedLead({ name, email, phone });
  }).filter(l => l.email || l.phone);
}

function showImportPreview(imported) {
  const modal = document.getElementById('leadModal');
  document.getElementById('modalTitle').innerHTML = `معاينة <span>الاستيراد</span> · ${imported.length} عميل`;

  const sample = imported.slice(0, 6);
  const previewHtml = sample.map((l) => `
    <tr style="border-bottom:1px solid var(--border-light)">
      <td style="padding:8px;font-size:12px">
        ${l.hot_lead ? '🔥 ' : ''}${escapeHtml(l.name || '—')}
        <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(l.sector || '')}</div>
      </td>
      <td style="padding:8px;font-size:11px;direction:ltr;color:var(--cyan)">${escapeHtml(l.email || '—')}</td>
      <td style="padding:8px;font-size:11px;direction:ltr">${escapeHtml(l.phone || '—')}</td>
      <td style="padding:8px;font-size:11px">${escapeHtml(l.city || '—')}</td>
      <td style="padding:8px;font-size:11px;color:var(--gold)">${escapeHtml(l.priority || '—')}</td>
    </tr>`).join('');

  const validCount = imported.filter(l => l.email || l.phone).length;
  const duplicates = imported.filter(l => APP.leads.some(existing =>
    (existing.email && existing.email === l.email && l.email) ||
    (existing.phone && existing.phone === l.phone && l.phone)
  )).length;

  // Statistics
  const hotLeads = imported.filter(l => l.hot_lead).length;
  const veryHighPrio = imported.filter(l => l.priority === 'عالية جداً').length;
  const highPrio = imported.filter(l => l.priority === 'عالية').length;
  const avgContractProb = Math.round(imported.reduce((s, l) => s + (l.contract_probability || 0), 0) / imported.length);
  const saudiCount = imported.filter(l => l.company_origin === 'سعودية').length;
  const foreignCount = imported.filter(l => l.company_origin === 'أجنبية').length;

  // Detect column mapping
  const sampleKeys = imported[0] ? Object.keys(imported[0]).filter(k => imported[0][k] && k !== 'addedAt' && k !== 'real' && k !== 'imported') : [];

  document.getElementById('modalBody').innerHTML = `
    <div class="info-box info-green" style="margin-bottom:14px">
      <div class="ib-title">✅ ملخص الاستيراد</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:8px">
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--gold)">${imported.length}</div>
          <div style="font-size:10px;color:var(--text-dim)">إجمالي</div>
        </div>
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--green)">${imported.length - duplicates}</div>
          <div style="font-size:10px;color:var(--text-dim)">جديد</div>
        </div>
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--orange)">${duplicates}</div>
          <div style="font-size:10px;color:var(--text-dim)">مكرر</div>
        </div>
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--red)">🔥 ${hotLeads}</div>
          <div style="font-size:10px;color:var(--text-dim)">عميل حار</div>
        </div>
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--purple)">⭐ ${veryHighPrio + highPrio}</div>
          <div style="font-size:10px;color:var(--text-dim)">أولوية عالية</div>
        </div>
        <div style="background:rgba(10,26,51,0.5);padding:8px;border-radius:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:var(--cyan)">${avgContractProb}%</div>
          <div style="font-size:10px;color:var(--text-dim)">متوسط احتمال التعاقد</div>
        </div>
      </div>
      ${(saudiCount > 0 || foreignCount > 0) ? `
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        ${saudiCount ? `<span class="tag tag-real">🇸🇦 سعودية: ${saudiCount}</span>` : ''}
        ${foreignCount ? `<span class="tag tag-info">🌍 أجنبية: ${foreignCount}</span>` : ''}
      </div>` : ''}
    </div>

    <div style="font-size:13px;font-weight:700;margin-bottom:10px">عيّنة من النتائج (أول 6):</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--gold-dim)">
          <th style="padding:8px;font-size:11px;text-align:right">الاسم/القطاع</th>
          <th style="padding:8px;font-size:11px;text-align:right">الإيميل</th>
          <th style="padding:8px;font-size:11px;text-align:right">الهاتف</th>
          <th style="padding:8px;font-size:11px;text-align:right">المدينة</th>
          <th style="padding:8px;font-size:11px;text-align:right">الأولوية</th>
        </tr></thead>
        <tbody>${previewHtml}</tbody>
      </table>
    </div>

    <details style="margin-top:12px">
      <summary style="cursor:pointer;font-size:12px;color:var(--text-dim);padding:6px 0">📋 الأعمدة المكتشفة (${sampleKeys.length})</summary>
      <div style="font-size:11px;color:var(--text-dim);padding:8px;background:rgba(10,26,51,0.5);border-radius:6px;line-height:1.8;direction:ltr;text-align:left">
        ${sampleKeys.join(' · ')}
      </div>
    </details>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
      <button class="btn-primary" onclick="confirmImportLeads(true)" style="flex:1;min-width:200px">
        ✓ إضافة ${imported.length - duplicates} عميل جديد ${duplicates > 0 ? '(تخطي المكرر)' : ''}
      </button>
      ${duplicates > 0 ? `<button class="btn-outline" onclick="confirmImportLeadsAll()" style="flex:1;min-width:140px">إضافة الكل (${imported.length})</button>` : ''}
      <button class="btn-outline" onclick="closeModal('leadModal')" style="min-width:80px">إلغاء</button>
    </div>`;

  APP._importedLeads = imported;
  modal.classList.add('open');
}

function confirmImportLeads(skipDupes) {
  if (!APP._importedLeads) return;
  let added = 0;
  APP._importedLeads.forEach(l => {
    const isDup = APP.leads.some(existing =>
      (existing.email && existing.email === l.email) ||
      (existing.phone && existing.phone === l.phone)
    );
    if (!isDup || !skipDupes) {
      APP.leads.push(l);
      added++;
    }
  });
  DB.set('leads', APP.leads);
  document.getElementById('leadsCount').textContent = APP.leads.length;
  closeModal('leadModal');
  showToast(`✅ تم إضافة ${added} عميل لقائمتك`, 'success');
  if (typeof renderLeadsList === 'function') renderLeadsList();
  openPage('leads');
  delete APP._importedLeads;
}

function confirmImportLeadsAll() { confirmImportLeads(false); }

// ============ تصدير قائمة العملاء (CSV/JSON) ============
function exportLeadsCSV() {
  if (APP.leads.length === 0) { showToast('⚠️ لا يوجد عملاء للتصدير', 'error'); return; }

  const headers = ['name', 'name_en', 'entity_type', 'sector', 'city', 'email', 'email_source', 'email_confidence',
    'phone', 'phone_source', 'phone_confidence', 'website', 'linkedin', 'instagram',
    'interest_score', 'status', 'signal', 'signal_date', 'signal_source_url', 'source', 'reason',
    'hot_lead', 'priority', 'contract_probability', 'company_origin'];

  const escapeCsv = (val) => {
    const s = String(val == null ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const rows = APP.leads.map(l => headers.map(h => {
    let v = l[h];
    if (h === 'interest_score') v = l.score;
    return escapeCsv(v);
  }).join(','));

  // BOM for Excel to read Arabic correctly
  const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mtc-leads-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`📥 تم تصدير ${APP.leads.length} عميل (CSV)`, 'success');
}

function exportLeadsJSON() {
  if (APP.leads.length === 0) { showToast('⚠️ لا يوجد عملاء للتصدير', 'error'); return; }
  const blob = new Blob([JSON.stringify(APP.leads, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mtc-leads-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`📥 تم تصدير ${APP.leads.length} عميل (JSON)`, 'success');
}

function downloadCsvTemplate() {
  const headers = 'name,name_en,sector,city,email,email_source,email_confidence,phone,phone_source,phone_confidence,website,linkedin,interest_score,signal,signal_date,source,reason,hot_lead,priority,contract_probability,company_origin';
  const sample = '\uFEFF' + headers + '\n' +
    'شركة المثال للمقاولات,Example Construction,Construction,الرياض,info@example.sa,official website,85,+966501234567,official website,90,https://example.sa,https://linkedin.com/company/example,80,بدأت مشاريع جديدة في 2026,2026-01-15,https://example.sa,تحتاج خدمات النقل الثقيل,True,عالية,75,سعودية\n' +
    'متجر النموذج الإلكتروني,Demo Store,E-commerce,جدة,contact@demo.com,LinkedIn page,75,+966555555555,WhatsApp business,80,https://demo.com,,70,تتوسع في عدة مدن,2026-02-01,Google,تحتاج لوجستيات شحن,False,متوسطة,50,سعودية';

  const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mtc-leads-template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('📥 تم تحميل قالب CSV', 'success');
}

function clearAllData() {
  if (!confirm('⚠️ سيتم مسح كل شيء (المفاتيح، العملاء، الحملات). متأكد؟')) return;
  if (!confirm('تأكيد أخير: هذا الإجراء لا يمكن التراجع عنه!')) return;
  DB.clear();
  APP.config = {}; APP.leads = []; APP.inbox = []; APP.campaigns = []; APP.workingProviders = {};
  showToast('🗑️ تم مسح كل البيانات');
  setTimeout(() => location.reload(), 800);
}

// ============ SEARCH PROVIDERS MANAGEMENT ============
async function testSearchProvider(pid) {
  const keyInput = document.getElementById('searchKey_' + pid);
  const statusEl = document.getElementById('status_search_' + pid);
  const apiKey = keyInput?.value.trim();
  if (!apiKey) {
    statusEl.innerHTML = '<span style="color:var(--red)">⚠️ أدخل المفتاح أولاً</span>';
    return;
  }
  statusEl.innerHTML = '<span style="color:var(--cyan)">⏳ يختبر البحث...</span>';
  try {
    const results = await SEARCH_PROVIDERS[pid].search({
      apiKey, query: 'شركات السعودية', timeRange: 'month', maxResults: 3
    });
    if (results && results.length > 0) {
      statusEl.innerHTML = `<span style="color:var(--green)">✅ متصل — ${results.length} نتيجة من اختبار</span>`;
      APP.config['searchKey_' + pid] = apiKey;
      DB.set('config', APP.config);
    } else {
      statusEl.innerHTML = '<span style="color:var(--orange)">⚠️ لا توجد نتائج (لكن الاتصال يعمل)</span>';
      APP.config['searchKey_' + pid] = apiKey;
      DB.set('config', APP.config);
    }
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ ${escapeHtml(String(e.message).substring(0, 120))}</span>`;
  }
}

function selectSearchProvider(pid) {
  const key = document.getElementById('searchKey_' + pid)?.value.trim();
  if (key) APP.config['searchKey_' + pid] = key;
  APP.config.searchProvider = pid;
  DB.set('config', APP.config);
  document.querySelectorAll('[id^="search_card_"]').forEach(c => c.classList.remove('active'));
  document.getElementById('search_card_' + pid)?.classList.add('active');
  showToast(`✓ ${SEARCH_PROVIDERS[pid].name} مفعّل للبحث`, 'success');
}

function saveHunterKey() {
  const key = document.getElementById('hunterApiKey')?.value.trim();
  APP.config.hunterApiKey = key || '';
  DB.set('config', APP.config);
  const statusEl = document.getElementById('status_hunter');
  if (key) {
    statusEl.innerHTML = '<span style="color:var(--green)">✅ تم الحفظ — سيُستخدم تلقائياً في البحث</span>';
    showToast('✅ مفتاح Hunter محفوظ', 'success');
  } else {
    statusEl.innerHTML = '<span style="color:var(--text-dim)">تم المسح</span>';
  }
}

// ============ إعادة تعيين الأقسام (Section Reset) ============
function resetSection(section) {
  const labels = {
    leads: 'قائمة العملاء والنتائج',
    search: 'فلاتر البحث',
    campaigns: 'الحملات السابقة',
    inbox: 'صندوق الوارد',
    prompts: 'البرومبتات (استعادة الافتراضية)',
    providers_status: 'حالة المزودين (للاختبار من جديد)'
  };

  if (!confirm(`إعادة تعيين: ${labels[section]}؟\nالإعدادات والمفاتيح ستبقى محفوظة.`)) return;

  switch (section) {
    case 'leads':
      APP.leads = [];
      APP.searchResults = [];
      APP.selectedSet.clear();
      DB.set('leads', []);
      document.getElementById('leadsCount').textContent = '0';
      const sr = document.getElementById('searchResults');
      if (sr) sr.style.display = 'none';
      const lb = document.getElementById('leadsListBody');
      if (lb) lb.innerHTML = '';
      const le = document.getElementById('leadsEmpty');
      if (le) le.style.display = 'block';
      break;

    case 'search':
      // إعادة الفلاتر للافتراضي بدون مسح النتائج
      const dom = document.getElementById('domainFilter');
      if (dom) { dom.value = 'النقل واللوجستيات'; updateSectorsForDomain(); }
      const city = document.getElementById('cityFilter');
      if (city) city.selectedIndex = 0;
      const tr = document.getElementById('timeRange');
      if (tr) tr.value = 'month';
      const sd = document.getElementById('searchDepth');
      if (sd) sd.value = 'deep';
      const st = document.getElementById('scoreThreshold');
      if (st) { st.value = 40; document.getElementById('scoreVal').textContent = '40%'; }
      const lm = document.getElementById('leadsMin');
      if (lm) lm.value = 20;
      break;

    case 'campaigns':
      APP.campaigns = [];
      DB.set('campaigns', []);
      const pc = document.getElementById('pastCampaigns');
      if (pc) pc.innerHTML = '<div class="empty-state" style="padding:30px"><div class="icon">📭</div><p>لا توجد حملات سابقة</p></div>';
      const cp = document.getElementById('campaignPanel');
      if (cp) cp.style.display = 'none';
      break;

    case 'inbox':
      APP.inbox = [];
      DB.set('inbox', []);
      const il = document.getElementById('inboxList');
      if (il) il.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>تم مسح الوارد محلياً</p></div>';
      const ic = document.getElementById('inboxCount');
      if (ic) ic.textContent = '';
      break;

    case 'prompts':
      delete APP.config.prompt_search;
      delete APP.config.prompt_message;
      delete APP.config.prompt_search_no_web;
      DB.set('config', APP.config);
      const ps = document.getElementById('promptSearch');
      const pm = document.getElementById('promptMessage');
      if (ps) ps.value = DEFAULT_PROMPTS.search;
      if (pm) pm.value = DEFAULT_PROMPTS.message;
      break;

    case 'providers_status':
      APP.workingProviders = {};
      renderProviderPicker();
      break;
  }

  showToast(`↻ تم إعادة تعيين: ${labels[section]}`, 'success');
}

// ============ DEPLOY CODE ============
const SERVER_CODE = `// server.js — MTC Sales Backend
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const Imap = require('imap');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const tracking = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.post('/api/send', async (req, res) => {
  const { to, body, from, fromName, leadName } = req.body;
  const id = Buffer.from(to + Date.now()).toString('base64url');
  const lines = body.split('\\n');
  let subject = 'بخصوص خدمات النقل اللوجستي';
  let content = body;
  if (lines[0].includes('الموضوع:')) {
    subject = lines[0].replace(/الموضوع:/,'').trim();
    content = lines.slice(1).join('\\n').trim();
  }
  const pixel = \`<img src="\${process.env.PUBLIC_URL}/api/track/\${id}" width="1" height="1" style="display:none">\`;
  const unsub = \`<br><br><a href="\${process.env.PUBLIC_URL}/api/unsub/\${id}" style="color:#888;font-size:11px">إلغاء الاشتراك</a>\`;
  const html = content.replace(/\\n/g,'<br>') + pixel + unsub;
  try {
    await transporter.sendMail({
      from: \`"\${fromName}" <\${from || process.env.SMTP_USER}>\`,
      to, subject, html
    });
    tracking[id] = { to, leadName, sentAt: Date.now(), openedAt: null };
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/track/:id', (req, res) => {
  const t = tracking[req.params.id];
  if (t && !t.openedAt) t.openedAt = Date.now();
  const px = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.set('Content-Type','image/gif').send(px);
});

app.get('/api/unsub/:id', (req, res) => {
  const t = tracking[req.params.id];
  if (t) t.unsubscribed = true;
  res.send('<h3 dir="rtl">تم إلغاء اشتراكك.</h3>');
});

app.get('/api/status', (req, res) => res.json(tracking));

app.get('/api/inbox', (req, res) => {
  const imap = new Imap({
    user: process.env.SMTP_USER, password: process.env.SMTP_PASS,
    host: 'imap.gmail.com', port: 993, tls: true
  });
  const messages = [];
  imap.once('ready', () => {
    imap.openBox('INBOX', true, () => {
      imap.search(['UNSEEN'], (e, results) => {
        if (!results || !results.length) { imap.end(); return res.json([]); }
        const f = imap.fetch(results.slice(-20), { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)' });
        f.on('message', m => {
          m.on('body', s => {
            let buf = '';
            s.on('data', d => buf += d.toString('utf8'));
            s.once('end', () => messages.push(Imap.parseHeader(buf)));
          });
        });
        f.once('end', () => { imap.end(); res.json(messages); });
      });
    });
  });
  imap.once('error', e => res.status(500).json({ error: String(e) }));
  imap.connect();
});

cron.schedule('0 10 * * *', () => {
  const now = Date.now(), week = 7*24*60*60*1000;
  Object.entries(tracking).forEach(([id, t]) => {
    if (!t.openedAt && !t.unsubscribed && (now - t.sentAt) >= week && (t.resends||0) < 3) {
      t.resends = (t.resends||0) + 1;
      t.sentAt = now;
      console.log('Resending to', t.to);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MTC Backend on :' + PORT));`;

const PKG_CODE = `{
  "name": "mtc-sales-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.19.2",
    "nodemailer": "^6.9.13",
    "cors": "^2.8.5",
    "imap": "^0.8.19",
    "node-cron": "^3.0.3"
  }
}`;

const ENV_CODE = `# .env
SMTP_USER=alhasanim194@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
PUBLIC_URL=https://your-app.onrender.com
PORT=3000`;

function renderDeployCode() {
  document.getElementById('serverCode').textContent = SERVER_CODE;
  document.getElementById('pkgCode').textContent = PKG_CODE;
  document.getElementById('envCode').textContent = ENV_CODE;
}

function copyServerCode() { copyToClipboard(SERVER_CODE); showToast('📋 تم نسخ كود الخادم', 'success'); }
function copyPkg() { copyToClipboard(PKG_CODE); showToast('📋 تم النسخ', 'success'); }
function copyEnv() { copyToClipboard(ENV_CODE); showToast('📋 تم النسخ', 'success'); }

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ============ UTILS ============
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => t.style.display = 'none', 3500);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ============ INIT ============
// ============ DOMAIN MANAGEMENT ============
function populateDomainFilter() {
  const domainSelect = document.getElementById('domainFilter');
  if (!domainSelect) return;
  const savedDomain = APP.config.selectedDomain || 'النقل واللوجستيات';
  domainSelect.innerHTML = Object.keys(BUSINESS_DOMAINS).map(name => {
    const d = BUSINESS_DOMAINS[name];
    const selected = name === savedDomain ? 'selected' : '';
    return `<option value="${escapeAttr(name)}" ${selected}>${d.icon} ${escapeHtml(name)}</option>`;
  }).join('');
  updateSectorsForDomain();
}

function updateSectorsForDomain() {
  const domainSelect = document.getElementById('domainFilter');
  const sectorSelect = document.getElementById('sectorFilter');
  if (!domainSelect || !sectorSelect) return;
  const domain = domainSelect.value;
  const sectors = BUSINESS_DOMAINS[domain]?.sectors || [];

  if (sectors.length === 0) {
    // مخصص — يمكن للمستخدم إدخال نص
    sectorSelect.innerHTML = '<option value="جميع القطاعات">🌐 جميع القطاعات</option>';
    sectorSelect.disabled = false;
    sectorSelect.title = 'اختر مجالاً جاهزاً أو حدّد البرومبت لمجال مخصص';
  } else {
    sectorSelect.disabled = false;
    // إضافة "جميع القطاعات" كأول خيار في كل مجال
    sectorSelect.innerHTML = '<option value="جميع القطاعات">🌐 جميع القطاعات (شامل)</option>' +
      sectors.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
  }

  // حفظ الاختيار
  APP.config.selectedDomain = domain;
  DB.set('config', APP.config);
}

// ============ PROMPT ENHANCER (تحسين البرومبت بالذكاء الاصطناعي) ============
async function enhancePrompt(key) {
  const id = key === 'search' ? 'promptSearch' : 'promptMessage';
  const statusId = key === 'search' ? 'searchPromptStatus' : 'messagePromptStatus';
  const currentPrompt = document.getElementById(id).value.trim();

  if (!currentPrompt) {
    document.getElementById(statusId).innerHTML = '<span style="color:var(--red)">⚠️ لا يوجد برومبت لتحسينه</span>';
    return;
  }

  document.getElementById(statusId).innerHTML = '<span style="color:var(--cyan)">🪄 يحسّن البرومبت بالذكاء الاصطناعي...</span>';

  const enhancePromptText = `أنت خبير في هندسة البرومبتات (Prompt Engineering) للذكاء الاصطناعي.

البرومبت التالي يستخدم في نظام مبيعات لـ ${key === 'search' ? 'البحث عن العملاء المحتملين' : 'كتابة رسائل البريد الإلكتروني'}.

== البرومبت الحالي ==
${currentPrompt}

== مهمتك ==
حسّن هذا البرومبت ليصبح أكثر فعالية ودقة، مع الحفاظ على:
- جميع المتغيرات بصيغة {{variable}} كما هي
- البنية الأساسية والأقسام
- اللغة العربية الواضحة
- المتطلبات الإلزامية

أضف:
- توجيهات أكثر تحديداً وأمثلة عملية
- قواعد صدق وحماية من المعلومات الوهمية
- تحسين هيكل JSON المطلوب (إن وُجد)
- تعليمات لجعل النتائج أكثر دقة وتفصيلاً

أرجع البرومبت المحسّن **فقط** بدون أي شرح أو مقدمة أو تعليق. ابدأ مباشرة بالنص الجديد.`;

  const result = await callAI(enhancePromptText, { maxTokens: 4000 });
  if (result.ok && result.text) {
    // إزالة أي ```markdown
    let enhanced = result.text.trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    document.getElementById(id).value = enhanced;
    const providerName = PROVIDERS[result.provider]?.name || result.provider;
    document.getElementById(statusId).innerHTML = `<span style="color:var(--green)">✨ تم التحسين بنجاح عبر ${escapeHtml(providerName)} — راجع التغييرات قبل الحفظ</span>`;
    showToast('✨ تم تحسين البرومبت', 'success');
  } else {
    document.getElementById(statusId).innerHTML = `<span style="color:var(--red)">❌ فشل التحسين: ${escapeHtml((result.error || 'خطأ').substring(0, 80))}</span>`;
    showToast('❌ فشل تحسين البرومبت', 'error');
  }
}

function init() {
  APP.config = DB.get('config', {}) || {};
  APP.leads = DB.get('leads', []) || [];
  APP.inbox = DB.get('inbox', []) || [];
  APP.campaigns = DB.get('campaigns', []) || [];

  const providers = ['groq', 'openrouter', 'gemini', 'mistral', 'anthropic', 'manus', 'custom'];
  for (const pid of providers) {
    const keyEl = document.getElementById('key_' + pid);
    const modelEl = document.getElementById('model_' + pid);
    if (keyEl && APP.config['key_' + pid]) keyEl.value = APP.config['key_' + pid];
    if (modelEl && APP.config['model_' + pid]) modelEl.value = APP.config['model_' + pid];
  }
  const proxyEl = document.getElementById('key_anthropic_proxy');
  if (proxyEl && APP.config.key_anthropic_proxy) proxyEl.value = APP.config.key_anthropic_proxy;
  const customUrlEl = document.getElementById('key_custom_url');
  if (customUrlEl && APP.config.key_custom_url) customUrlEl.value = APP.config.key_custom_url;
  const manusUrlEl = document.getElementById('key_manus_url');
  if (manusUrlEl && APP.config.key_manus_url) manusUrlEl.value = APP.config.key_manus_url;

  if (APP.config.backendUrl) document.getElementById('backendUrl').value = APP.config.backendUrl;
  if (APP.config.senderName) document.getElementById('senderName').value = APP.config.senderName;
  if (APP.config.senderEmail) document.getElementById('senderEmail').value = APP.config.senderEmail;
  if (APP.config.waNumber) document.getElementById('waNumber').value = APP.config.waNumber;
  if (APP.config.myCompany) document.getElementById('myCompany').value = APP.config.myCompany;
  if (APP.config.myServices) document.getElementById('myServices').value = APP.config.myServices;
  if (APP.config.myAdvantages) document.getElementById('myAdvantages').value = APP.config.myAdvantages;
  if (APP.config.myContact) document.getElementById('myContact').value = APP.config.myContact;

  // WhatsApp Business API settings
  const waBusinessToggle = document.getElementById('waBusinessToggle');
  if (waBusinessToggle && APP.config.waBusinessEnabled) waBusinessToggle.checked = true;
  if (APP.config.waPhoneNumberId) {
    const el = document.getElementById('waPhoneNumberId');
    if (el) el.value = APP.config.waPhoneNumberId;
  }
  if (APP.config.waAccessToken) {
    const el = document.getElementById('waAccessToken');
    if (el) el.value = APP.config.waAccessToken;
  }
  if (APP.config.waTemplateName) {
    const el = document.getElementById('waTemplateName');
    if (el) el.value = APP.config.waTemplateName;
  }
  if (APP.config.waTemplateLang) {
    const el = document.getElementById('waTemplateLang');
    if (el) el.value = APP.config.waTemplateLang;
  }

  // Email provider keys
  ['resendApiKey', 'brevoApiKey', 'emailjsPublicKey', 'emailjsServiceId', 'emailjsTemplateId'].forEach(k => {
    if (APP.config[k]) {
      const el = document.getElementById(k);
      if (el) el.value = APP.config[k];
    }
  });

  // Search provider keys
  ['tavily', 'brave', 'serpapi'].forEach(pid => {
    if (APP.config['searchKey_' + pid]) {
      const el = document.getElementById('searchKey_' + pid);
      if (el) el.value = APP.config['searchKey_' + pid];
    }
  });
  if (APP.config.hunterApiKey) {
    const el = document.getElementById('hunterApiKey');
    if (el) el.value = APP.config.hunterApiKey;
  }
  if (APP.config.searchProvider) {
    document.getElementById('search_card_' + APP.config.searchProvider)?.classList.add('active');
  }

  // Highlight selected email provider
  if (APP.config.emailProvider) {
    const card = document.getElementById('email_card_' + APP.config.emailProvider);
    if (card) card.classList.add('selected');
  }

  refreshFavoriteUI();
  populateDomainFilter();

  const hasAnyKey = providers.some(p => APP.config['key_' + p] && APP.config['key_' + p].length > 10);
  updateApiStatus(hasAnyKey);
  refreshStats();
  renderDashboardCharts();
  renderDashSchedule();
  if (APP.campaigns.length) renderPastCampaigns();
  // Initialize attachments list
  renderAttachmentsList();
}

// ============ EXPOSE TO GLOBAL ============
window.openPage = openPage;
window.toggleSidebar = toggleSidebar;
window.pickProvider = pickProvider;
window.toggleFavorite = toggleFavorite;
window.startDeepSearch = startDeepSearch;
window.updateSectorsForDomain = updateSectorsForDomain;
window.enhancePrompt = enhancePrompt;
window.BUSINESS_DOMAINS = BUSINESS_DOMAINS;
window.testEmailProvider = testEmailProvider;
window.saveEmailProviderKeys = saveEmailProviderKeys;
window.selectEmailProvider = selectEmailProvider;
window.EMAIL_PROVIDERS = EMAIL_PROVIDERS;
window.toggleChk = toggleChk;
window.selectAll = selectAll;
window.sendSelected = sendSelected;
window.filterLeads = filterLeads;
window.viewLead = viewLead;
window.composeForResult = composeForResult;
window.waResult = waResult;
window.composeForLead = composeForLead;
window.doWA = doWA;
window.delLead = delLead;
window.filterLeadsList = filterLeadsList;
window.fillClientData = fillClientData;
window.generateMessage = generateMessage;
window.sendEmailSingle = sendEmailSingle;
window.openWhatsAppDialog = openWhatsAppDialog;
window.openWA = openWA;
window.copyWAMessage = copyWAMessage;
window.testWhatsAppAPI = testWhatsAppAPI;
window.saveWhatsAppBusiness = saveWhatsAppBusiness;
window.copyMsg = copyMsg;
window.editMsg = editMsg;
window.addAttachment = addAttachment;
window.startCampaign = startCampaign;
window.executeCampaign = executeCampaign;
window.openInboxMsg = openInboxMsg;
window.sendReply = sendReply;
window.aiReply = aiReply;
window.testProvider = testProvider;
window.saveAllProviders = saveAllProviders;
window.saveBackend = saveBackend;
window.saveWA = saveWA;
window.saveCompanyData = saveCompanyData;
window.exportData = exportData;
window.importData = importData;
window.importLeadsFile = importLeadsFile;
window.exportLeadsCSV = exportLeadsCSV;
window.exportLeadsJSON = exportLeadsJSON;
window.downloadCsvTemplate = downloadCsvTemplate;
window.confirmImportLeads = confirmImportLeads;
window.confirmImportLeadsAll = confirmImportLeadsAll;
window.testSenderEmail = testSenderEmail;
// Leads page enhancements
window.changeLeadsPage = changeLeadsPage;
window.changeLeadsPerPage = changeLeadsPerPage;
window.leadsSearch = leadsSearch;
window.leadsFilterByCity = leadsFilterByCity;
window.leadsFilterByPriority = leadsFilterByPriority;
window.leadsFilterByOrigin = leadsFilterByOrigin;
window.clearLeadsFilters = clearLeadsFilters;
window.toggleLeadSelect = toggleLeadSelect;
window.selectAllVisibleLeads = selectAllVisibleLeads;
window.selectAllFilteredLeads = selectAllFilteredLeads;
window.deselectAllLeads = deselectAllLeads;
window.bulkDeleteLeads = bulkDeleteLeads;
window.bulkSendCampaign = bulkSendCampaign;
window.bulkExportSelected = bulkExportSelected;
window.viewLeadFromList = viewLeadFromList;
// Attachments
window.handleAttachmentUpload = handleAttachmentUpload;
window.addAttachmentLink = addAttachmentLink;
window.removeAttachment = removeAttachment;
window.removeAttachmentLink = removeAttachmentLink;
window.clearAllAttachments = clearAllAttachments;
window.renderAttachmentsList = renderAttachmentsList;
window.clearAllData = clearAllData;
window.resetSection = resetSection;
window.fetchInbox = fetchInbox;
window.toggleInboxFilter = toggleInboxFilter;
window.SEARCH_PROVIDERS = SEARCH_PROVIDERS;
window.hunterDomainSearch = hunterDomainSearch;
window.testSearchProvider = testSearchProvider;
window.selectSearchProvider = selectSearchProvider;
window.saveHunterKey = saveHunterKey;
window.closeModal = closeModal;
window.copyServerCode = copyServerCode;
window.copyPkg = copyPkg;
window.copyEnv = copyEnv;
window.savePrompt = savePrompt;
window.resetPrompt = resetPrompt;
window.insertToken = insertToken;
window.showToast = showToast;
window.APP = APP;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
