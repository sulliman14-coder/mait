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

// ============ DEFAULT PROMPTS ============
const DEFAULT_PROMPTS = {
  search: `أنت محلل تطوير أعمال متخصص في التنقيب العميق عن العملاء B2B للشركات السعودية، تعمل لصالح "{{company}}".

== مهمتك الأساسية ==
ليست مجرد إعطاء قائمة شركات معروفة. مهمتك هي **التنقيب الذكي والعميق** عن عملاء محتملين أظهروا مؤخراً **إشارات نية حقيقية** للحاجة إلى خدمات النقل الثقيل والتخليص الجمركي واللوجستيات.

== مصادر التنقيب التي يجب البحث فيها ==
1. **الأخبار والإعلانات الرسمية**: مشاريع جديدة أُعلن عنها، توسعات صناعية، افتتاح فروع، إنشاء مصانع
2. **المناقصات المفتوحة**: في الجهات الحكومية، شركات النفط، الموانئ، البلديات
3. **التعيينات الجديدة**: مدراء مشتريات، مدراء لوجستيات، رؤساء عمليات تم تعيينهم حديثاً
4. **النشاط على LinkedIn**: شركات نشرت عن: توسعات، نمو، توظيف بكميات، استثمارات
5. **الإحصاءات والتقارير**: شركات في قطاعات تنمو سريعاً وتحتاج نقلاً
6. **العقود والشراكات**: شركات وقّعت عقوداً كبيرة تتطلب نقل بضائع/معدات
7. **مشاريع رؤية 2030**: نيوم، البحر الأحمر، القدية، الدرعية، مشاريع ضخمة قيد التنفيذ
8. **أخبار الاستيراد والتصدير**: شركات تستورد معدات أو مواد خام بكميات كبيرة

== معايير الاستهداف ==
- القطاع: {{sector}}
- المنطقة: {{city}}
- الفترة الزمنية للإشارات: {{timeRange}}
- العدد المطلوب: {{count}} عميل (الحد الأدنى 20)
- الحد الأدنى لنسبة الاهتمام: {{minScore}}%

== تقييم نسبة الاهتمام (interest_score من 0 إلى 100) ==
1. وجود إشارة نية حديثة وقوية (40%)
2. حجم احتياج القطاع لخدمات النقل الثقيل (25%)
3. حجم الشركة وقدرتها التعاقدية (20%)
4. سهولة الوصول لصانع القرار (15%)

== خدمات شركتنا ==
{{services}}

== قواعد إخراج صارمة ==
- أرجع JSON صحيح **فقط** بدون أي شرح أو نص قبله أو بعده
- بدون \`\`\`json أو أي علامات markdown
- ابدأ مباشرة بـ { وانتهِ بـ }
- لكل عميل: قدّم تفاصيل **حقيقية** عن إشارة النية (signal)
- في حقل reason: اذكر **الإشارة المحددة** التي اكتشفتها
- في حقل source: المصدر المحتمل (Argaam, Mubasher, LinkedIn, موقع الشركة)
- في حقل website: الموقع الرسمي الفعلي للشركة
- في حقل linkedin: رابط LinkedIn للشركة
- في حقل email: بريد مؤسسي واقعي (procurement@، supply@، logistics@، contracts@)

== متطلبات حقول مصدر البيانات (مهم جداً) ==
لكل قطعة معلومات اتصال (الإيميل، الهاتف، LinkedIn) يجب توضيح **من أين حصلت عليها** و**درجة الثقة** فيها:
- email_source: من أين الإيميل؟ ("الموقع الرسمي للشركة" / "صفحة LinkedIn الرسمية" / "السجل التجاري" / "خبر صحفي" / "تقدير حسب نمط الشركة" / "Google Maps" / "Yellow Pages")
- email_confidence: درجة ثقة الإيميل من 0 إلى 100
- phone_source: من أين الرقم؟ (نفس الخيارات أعلاه)
- phone_confidence: درجة ثقة الرقم من 0 إلى 100
- linkedin_source: من أين رابط LinkedIn؟ (إن وجد)

== هيكل JSON المطلوب ==
{"leads":[{
  "name":"اسم الشركة بالعربي",
  "name_en":"Company name in English",
  "sector":"القطاع المحدد",
  "city":"المدينة",
  "email":"procurement@company.com.sa",
  "email_source":"الموقع الرسمي - صفحة اتصل بنا",
  "email_confidence":85,
  "phone":"+966501234567",
  "phone_source":"السجل التجاري + الموقع الرسمي",
  "phone_confidence":90,
  "website":"https://www.company.com.sa",
  "linkedin":"https://www.linkedin.com/company/company-name",
  "linkedin_source":"بحث LinkedIn",
  "interest_score":85,
  "signal":"الإشارة المحددة المكتشفة (مشروع/توسعة/مناقصة/تعيين)",
  "signal_date":"تاريخ تقريبي للإشارة",
  "source":"المصدر الرئيسي لإشارة النية (Argaam, Mubasher, LinkedIn, موقع رسمي)",
  "reason":"شرح مختصر لماذا هذا العميل يحتاج خدماتنا"
}]}

== قواعد الصدق ==
- إذا كان البريد تخميناً (حسب نمط الشركة)، اذكر ذلك صراحة في email_source واجعل email_confidence بين 30-60
- إذا كان رقماً مؤسسياً عاماً (السنترال)، اذكر "سنترال الشركة - الموقع الرسمي" وضع confidence 70-90
- إذا كنت غير متأكد من إيميل شخصي، استخدم بريد عام (info@، procurement@) واخفض الثقة
- لا تختلق روابط LinkedIn — اتركها فارغة إن لم تكن متأكداً

ابدأ التنقيب الآن وأرجع {{count}} عميل على الأقل. أرجع JSON فقط.`,

  message: `أنت مدير تطوير أعمال محترف ومقنع في شركة "{{myCompany}}".

== بيانات شركتنا ==
الخدمات: {{myServices}}
المزايا التنافسية: {{myAdvantages}}
التواصل: {{myContact}}

== العميل المستهدف ==
الشركة: {{company}}
القطاع/النشاط: {{sector}}
{{note}}

== نوع الرسالة ==
{{typeLabel}}

== اللغة ==
{{langInstr}}

اكتب رسالة بريد إلكتروني احترافية مقنعة عالية التحويل وفق هذه القواعد:
1. سطر الموضوع: اكتبه في أول سطر بصيغة "الموضوع: ..." — مخصص لاسم الشركة وغير دعائي.
2. تحية شخصية تذكر اسم الشركة المستهدفة.
3. جملة افتتاحية تربط بين نشاط الشركة المستهدفة واحتياجها لخدماتنا.
4. اذكر خدمتين أو ثلاثاً من خدماتنا الأكثر صلة بقطاع هذا العميل.
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
  const sector = document.getElementById('sectorFilter').value;
  const city = document.getElementById('cityFilter').value;
  const timeRange = document.getElementById('timeRange').value;
  const searchDepth = document.getElementById('searchDepth').value;
  const minScore = parseInt(document.getElementById('scoreThreshold').value);
  const count = Math.max(10, parseInt(document.getElementById('leadsMin').value) || 20);

  const timeRangeText = {
    day: 'آخر 24 ساعة', week: 'آخر 7 أيام',
    month: 'الشهر الماضي', '6months': 'آخر 6 أشهر', year: 'آخر سنة'
  }[timeRange];

  document.getElementById('aiLoader').classList.add('active');
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchBtn').disabled = true;

  const steps = searchDepth === 'deep' ? [
    `🔍 يبدأ التنقيب العميق (${timeRangeText})...`,
    '📰 يفحص الأخبار والإعلانات الرسمية...',
    '🏗️ يحلل المشاريع والتوسعات الحديثة...',
    '💼 يستخرج إشارات النية من LinkedIn والصحف...',
    '📋 يرصد المناقصات والتعيينات الجديدة...',
    '⚖️ يقيّم احتمالية كل عميل ويرتبهم...',
    '📞 يستخرج بيانات التواصل والروابط...'
  ] : ['يحلل القطاع...', 'يبحث في ' + city + '...', 'يقيّم النسب...', 'يرتب القائمة...', 'يجهّز التواصل...'];

  let si = 0, prog = 0;
  const tick = setInterval(() => {
    prog = Math.min(prog + Math.random() * 11 + 3, 92);
    if (si < steps.length) { document.getElementById('aiLoaderText').textContent = steps[si]; si++; }
    document.getElementById('aiProgress').style.width = prog + '%';
    document.getElementById('aiProgressNum').textContent = Math.round(prog) + '%';
  }, 600);

  let leads = [], isReal = false, providerUsed = '', errorMsg = '';
  const company = APP.config.myCompany || 'شركة محمد للنقليات (MTC)';
  const services = APP.config.myServices || 'نقل ثقيل، تخليص جمركي، خدمات لوجستية';

  const promptTemplate = searchDepth === 'deep' ? getPrompt('search') : buildStandardPrompt();
  const prompt = fillPromptTokens(promptTemplate, {
    sector, city, count: String(count), minScore: String(minScore),
    timeRange: timeRangeText, company, services
  });

  const forceProvider = APP.pickedProvider || APP.config.favoriteProvider;

  try {
    const result = await callAI(prompt, { maxTokens: 6000, forceProvider });
    if (result.ok) {
      providerUsed = PROVIDERS[result.provider]?.name || result.provider;
      const parsed = extractJSON(result.text);
      if (parsed && parsed.leads && Array.isArray(parsed.leads)) {
        leads = parsed.leads.filter(l => l && l.name).map(l => ({
          name: l.name, name_en: l.name_en || '',
          sector: l.sector || sector, city: l.city || city.split(' ')[0],
          email: l.email || 'info@company.com.sa',
          email_source: l.email_source || '',
          email_confidence: Math.round(l.email_confidence || 50),
          phone: l.phone || '+966500000000',
          phone_source: l.phone_source || '',
          phone_confidence: Math.round(l.phone_confidence || 50),
          website: l.website || '', linkedin: l.linkedin || '',
          linkedin_source: l.linkedin_source || '',
          score: Math.round(l.interest_score || l.score || 50),
          signal: l.signal || '', signal_date: l.signal_date || '',
          source: l.source || '', reason: l.reason || '',
          status: 'pending', last: '—', real: true
        })).filter(l => l.score >= minScore).sort((a, b) => b.score - a.score);
        if (leads.length > 0) { isReal = true; APP.workingProviders[result.provider] = true; }
      } else {
        errorMsg = 'فشل تحليل JSON من ' + providerUsed;
        console.warn('JSON parse failed. Raw:', result.text.substring(0, 500));
      }
    } else {
      errorMsg = result.error || 'فشل الاتصال';
    }
  } catch (e) {
    errorMsg = e.message;
    console.error('Search error:', e);
  }

  if (leads.length < count) {
    const demo = generateDemoLeads(sector, city, count - leads.length, minScore);
    leads = leads.concat(demo).slice(0, Math.max(count, 20));
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
    if (isReal) {
      const realCount = leads.filter(l => l.real).length;
      const depthLabel = searchDepth === 'deep' ? '🔬 تنقيب عميق' : '✓ بحث حقيقي';
      mode.className = 'tag ' + (searchDepth === 'deep' ? 'tag-deep' : 'tag-real');
      mode.textContent = `${depthLabel} · ${providerUsed} · ${realCount}/${leads.length} حقيقي`;
    } else {
      mode.className = 'tag tag-demo';
      mode.textContent = errorMsg ? `⚠️ ${errorMsg.substring(0, 60)}` : 'وضع تجريبي';
    }
    renderResultsTable(leads);
    document.getElementById('searchResults').style.display = 'block';
    showToast(`✅ ${leads.length} عميل ${isReal ? 'حقيقي' : 'تجريبي'}`, isReal ? 'success' : '');
  }, 700);
}

function buildStandardPrompt() {
  return `أنت محلل تطوير أعمال للنقل اللوجستي السعودي. ابحث عن {{count}} عميل في قطاع {{sector}} في {{city}}.

لكل عميل قيّم interest_score (0-100) بناءً على حاجته للنقل الثقيل.

أرجع JSON فقط:
{"leads":[{"name":"الشركة","sector":"النشاط","city":"المدينة","email":"info@x.sa","phone":"+966...","website":"https://...","linkedin":"","interest_score":80,"signal":"","reason":"السبب"}]}

ابدأ مباشرة بـ {. لا شرح. {{count}} عميل بالحد الأدنى. الحد الأدنى للنسبة {{minScore}}%.`;
}

function generateDemoLeads(sector, city, n, minScore) {
  const base = [
    { name: 'مجموعة بن لادن السعودية', sec: 'بناء ومقاولات', e: 'procurement@sbg.com.sa', w: 'https://www.sbg.com.sa' },
    { name: 'شركة CCECC', sec: 'مقاولات', e: 'info@ccecc-sa.com', w: 'https://www.ccecc.com.cn' },
    { name: 'السيف مهندسون مقاولون', sec: 'بناء وهندسة', e: 'projects@elseif.com', w: 'https://www.elseifsa.com' },
    { name: 'الجهاز للمقاولات', sec: 'مقاولات', e: 'supply@aljihaz.com.sa', w: 'https://www.aljihaz.com.sa' },
    { name: 'مجموعة نقوا', sec: 'صناعة وغذاء', e: 'logistics@naqua.com.sa', w: 'https://www.naqua.com.sa' },
    { name: 'شركة فيل العربية', sec: 'صناعة', e: 'ops@feal.com.sa', w: 'https://www.feal.com.sa' },
    { name: 'أرامكو السعودية', sec: 'نفط', e: 'transport@aramco.com', w: 'https://www.aramco.com' },
    { name: 'شركة سابك', sec: 'بتروكيماويات', e: 'transport@sabic.com', w: 'https://www.sabic.com' },
    { name: 'المياه الوطنية', sec: 'حكومي', e: 'procurement@nwc.com.sa', w: 'https://www.nwc.com.sa' },
    { name: 'ميناء جدة الإسلامي', sec: 'موانئ', e: 'ops@mawani.gov.sa', w: 'https://mawani.gov.sa' },
    { name: 'شركة المراعي', sec: 'غذائية', e: 'supply@almarai.com', w: 'https://www.almarai.com' },
    { name: 'الفنار للهندسة', sec: 'هندسة', e: 'projects@alfanar.com', w: 'https://www.alfanar.com' }
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = base[i % base.length];
    const sfx = i >= base.length ? ` (فرع ${city.split(' ')[0]})` : '';
    out.push({
      name: b.name + sfx, sector: b.sec, city: city.split(' ')[0],
      email: b.e,
      email_source: 'بيانات تجريبية',
      email_confidence: 0,
      phone: '+96650' + (1000000 + Math.floor(Math.random() * 8999999)),
      phone_source: 'بيانات تجريبية',
      phone_confidence: 0,
      website: b.w,
      linkedin: 'https://www.linkedin.com/company/' + b.name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 30),
      linkedin_source: 'بيانات تجريبية',
      score: Math.max(minScore, Math.floor(Math.random() * (95 - minScore)) + minScore),
      signal: 'تجريبي - أضف مفتاح AI للإشارات الحقيقية',
      source: 'demo', reason: 'وضع تجريبي',
      status: 'pending', last: '—', real: false
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function renderResultsTable(data) {
  document.getElementById('resultsBody').innerHTML = data.map((l, i) => {
    const cls = l.score >= 80 ? 'score-high' : l.score >= 60 ? 'score-mid' : 'score-low';
    const checked = APP.selectedSet.has(i) ? 'checked' : '';
    const checkMark = APP.selectedSet.has(i) ? '✓' : '';
    const links = [];
    if (l.website) links.push(`<a href="${escapeAttr(l.website)}" target="_blank" rel="noopener" class="lead-link">🌐 موقع</a>`);
    if (l.linkedin) links.push(`<a href="${escapeAttr(l.linkedin)}" target="_blank" rel="noopener" class="lead-link">💼 LinkedIn</a>`);
    const linksHtml = links.length ? links.join('') : '<span style="color:var(--text-dim);font-size:11px">—</span>';
    const signalLine = l.signal ? `<div class="lead-source">📡 ${escapeHtml(l.signal.substring(0, 100))}${l.signal_date ? ' · ' + escapeHtml(l.signal_date) : ''}</div>` : '';
    const sourceLine = l.source && l.source !== 'demo' ? `<div class="lead-source">📰 ${escapeHtml(l.source)}</div>` : '';
    const realBadge = l.real ? '<span class="tag tag-real" style="font-size:9px;padding:1px 6px;margin-right:6px">✓</span>' : '';

    // Build contact data with sources
    const emailConfClass = l.email_confidence >= 80 ? 'conf-high' : l.email_confidence >= 50 ? 'conf-mid' : 'conf-low';
    const phoneConfClass = l.phone_confidence >= 80 ? 'conf-high' : l.phone_confidence >= 50 ? 'conf-mid' : 'conf-low';
    const emailSrc = l.email_source ? `<div class="data-source"><span class="conf-dot ${emailConfClass}"></span>📧 ${escapeHtml(l.email_source.substring(0, 40))}${l.email_confidence ? ` <b>${l.email_confidence}%</b>` : ''}</div>` : '';
    const phoneSrc = l.phone_source ? `<div class="data-source"><span class="conf-dot ${phoneConfClass}"></span>📞 ${escapeHtml(l.phone_source.substring(0, 40))}${l.phone_confidence ? ` <b>${l.phone_confidence}%</b>` : ''}</div>` : '';

    return `<tr>
      <td><div class="checkbox-custom ${checked}" id="chk-${i}" onclick="toggleChk(${i})">${checkMark}</div></td>
      <td>
        <div style="font-weight:600">${realBadge}${escapeHtml(l.name)}</div>
        ${signalLine}${sourceLine}
      </td>
      <td><span class="tag tag-pending" style="font-size:10px">${escapeHtml(l.sector)}</span></td>
      <td>
        <div style="font-size:11px;direction:ltr;color:var(--text-2)">${escapeHtml(l.email)}</div>
        <div style="font-size:11px;direction:ltr;color:var(--text-dim);margin-top:2px">${escapeHtml(l.phone)}</div>
        ${emailSrc}${phoneSrc}
      </td>
      <td>${linksHtml}</td>
      <td><div class="score-bar ${cls}">
        <div class="score-fill"><div class="score-fill-inner" style="width:${l.score}%"></div></div>
        <span class="score-text">${l.score}%</span>
      </div></td>
      <td><div class="action-btns">
        <button class="btn-sm btn-view" onclick="viewLead(${i})">عرض</button>
        <button class="btn-sm btn-send" onclick="composeForResult(${i})">✍️</button>
        <button class="btn-sm btn-wa" onclick="waResult(${i})">📱</button>
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
      <div>${escapeHtml(l.signal)}${l.signal_date ? '<br><b>التاريخ:</b> ' + escapeHtml(l.signal_date) : ''}${l.source ? '<br><b>المصدر:</b> ' + escapeHtml(l.source) : ''}</div>
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
function renderLeadsList() {
  const tb = document.getElementById('leadsListBody');
  if (APP.leads.length === 0) {
    document.getElementById('leadsEmpty').style.display = 'block';
    tb.innerHTML = '';
    return;
  }
  document.getElementById('leadsEmpty').style.display = 'none';
  const sm = { pending: 'tag-pending', sent: 'tag-sent', opened: 'tag-opened', replied: 'tag-replied', cold: 'tag-cold' };
  const sl = { pending: 'لم يُرسل', sent: 'أُرسل', opened: 'فُتح', replied: 'رد ✅', cold: 'بارد' };
  tb.innerHTML = APP.leads.map((l, i) => {
    const cls = l.score >= 80 ? 'score-high' : l.score >= 60 ? 'score-mid' : 'score-low';
    const links = [];
    if (l.website) links.push(`<a href="${escapeAttr(l.website)}" target="_blank" rel="noopener" class="lead-link">🌐</a>`);
    if (l.linkedin) links.push(`<a href="${escapeAttr(l.linkedin)}" target="_blank" rel="noopener" class="lead-link">💼</a>`);
    return `<tr>
      <td>
        <div style="font-weight:600;font-size:13px">${escapeHtml(l.name)}</div>
        ${l.signal ? `<div class="lead-source">📡 ${escapeHtml(l.signal.substring(0, 60))}</div>` : ''}
      </td>
      <td><span class="tag tag-pending" style="font-size:10px">${escapeHtml(l.sector)}</span></td>
      <td>
        <div style="font-size:11px;direction:ltr;color:var(--text-dim)">${escapeHtml(l.email)}</div>
        <div style="font-size:11px;direction:ltr;color:var(--text-dim);margin-top:2px">${escapeHtml(l.phone)}</div>
      </td>
      <td>${links.join('') || '<span style="color:var(--text-dim);font-size:11px">—</span>'}</td>
      <td><div class="score-bar ${cls}" style="min-width:85px">
        <div class="score-fill"><div class="score-fill-inner" style="width:${l.score}%"></div></div>
        <span class="score-text">${l.score}%</span></div></td>
      <td><span class="tag ${sm[l.status] || 'tag-pending'}">${sl[l.status] || '—'}</span></td>
      <td><div class="action-btns">
        <button class="btn-sm btn-send" onclick="composeForLead(${i})">✍️</button>
        <button class="btn-sm btn-wa" onclick="doWA(APP.leads[${i}])">📱</button>
        <button class="btn-sm btn-danger" onclick="delLead(${i})">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

function filterLeadsList(type, btn) {
  document.querySelectorAll('#page-leads .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
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

async function sendEmailSingle() {
  const to = document.getElementById('recipientEmail').value.trim();
  if (!to) { showToast('⚠️ أدخل البريد المستلم', 'error'); return; }
  const backend = APP.config.backendUrl;
  if (!backend) { showToast('⚠️ اربط الخادم الخلفي في الإعدادات', 'error'); return; }
  const msg = document.getElementById('msgPreview').textContent;
  showToast('📤 جاري الإرسال...');
  try {
    const r = await fetch(backend.replace(/\/$/, '') + '/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body: msg, from: APP.config.senderEmail, fromName: APP.config.senderName })
    });
    if (r.ok) showToast('✅ تم الإرسال', 'success');
    else showToast('⚠️ فشل الإرسال', 'error');
  } catch (e) { showToast('⚠️ تعذّر الاتصال بالخادم', 'error'); }
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

function addAttachment(name, icon) {
  const c = document.createElement('div');
  c.className = 'att-chip';
  c.innerHTML = `${icon} ${escapeHtml(name)} <span class="remove-x" onclick="this.parentElement.remove()">✕</span>`;
  document.getElementById('attachments').appendChild(c);
  showToast('📎 تمت الإضافة');
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
  const backend = APP.config.backendUrl;
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
      if (backend) {
        try {
          const res = await fetch(backend.replace(/\/$/, '') + '/api/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: l.email, body: personalizedMsg, from: APP.config.senderEmail, fromName: APP.config.senderName, leadName: l.name })
          });
          success = res.ok;
        } catch (e) { success = false; }
      } else { await sleep(700); }
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
function renderInbox() {
  if (APP.inbox.length === 0) {
    APP.inbox = [
      { id: 1, from: 'مجموعة بن لادن السعودية', email: 'procurement@sbg.com.sa', subject: 'رد: حلول النقل الثقيل', preview: 'شكراً للتواصل، يرجى إرسال عرض سعر...', time: 'منذ ساعتين', unread: true, body: 'السادة شركة محمد للنقليات،\n\nاطلعنا على خدماتكم ونودّ عرض سعر مفصّل.\n\nإدارة المشتريات' },
      { id: 2, from: 'شركة أرامكو', email: 'transport@aramco.com', subject: 'استفسار', preview: 'نود الاستفسار...', time: 'أمس', unread: true, body: 'نود الاستفسار عن نقل الأنابيب في المنطقة الشرقية.' },
      { id: 3, from: 'مجموعة نقوا', email: 'logistics@naqua.com.sa', subject: 'Re: شراكة', preview: 'نحن مهتمون...', time: 'منذ 3 أيام', unread: false, body: 'نحن مهتمون بالتعاون. هل يمكن ترتيب اجتماع؟' }
    ];
  }
  const list = document.getElementById('inboxList');
  list.innerHTML = APP.inbox.map((m, i) => `
    <div class="inbox-item ${m.unread ? 'unread' : ''}" onclick="openInboxMsg(${i})">
      <div class="inbox-avatar">${m.unread ? '📬' : '📭'}</div>
      <div class="inbox-meta">
        <div class="inbox-sender">${escapeHtml(m.from)}</div>
        <div class="inbox-subject">${escapeHtml(m.subject)}</div>
        <div class="inbox-preview">${escapeHtml(m.preview)}</div>
      </div>
      <div class="inbox-time">${escapeHtml(m.time)}</div>
    </div>`).join('');
  document.getElementById('inboxCount').textContent = APP.inbox.filter(m => m.unread).length || '';
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
  const providers = ['groq', 'openrouter', 'gemini', 'mistral', 'anthropic', 'custom'];
  for (const pid of providers) {
    const key = document.getElementById('key_' + pid)?.value.trim();
    const model = document.getElementById('model_' + pid)?.value;
    if (key) APP.config['key_' + pid] = key;
    if (model) APP.config['model_' + pid] = model;
  }
  APP.config.key_anthropic_proxy = document.getElementById('key_anthropic_proxy')?.value.trim() || '';
  APP.config.key_custom_url = document.getElementById('key_custom_url')?.value.trim() || '';
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
  if (!APP.config.backendUrl) {
    document.getElementById('backendStatus').innerHTML = '<span style="color:var(--orange)">حُفظ — بدون خادم لا يوجد إرسال فعلي</span>';
    return;
  }
  document.getElementById('backendStatus').innerHTML = '<span style="color:var(--cyan)">⏳ يختبر...</span>';
  try {
    const r = await fetch(APP.config.backendUrl.replace(/\/$/, '') + '/api/health');
    document.getElementById('backendStatus').innerHTML = r.ok
      ? '<span style="color:var(--green)">✅ الخادم متصل</span>'
      : '<span style="color:var(--orange)">⚠️ لا يستجيب</span>';
  } catch (e) {
    document.getElementById('backendStatus').innerHTML = '<span style="color:var(--orange)">⚠️ تعذّر الوصول</span>';
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
  const all = { config: APP.config, leads: APP.leads, inbox: APP.inbox, campaigns: APP.campaigns };
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mtc-backup-' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('📥 تم التصدير', 'success');
}

function clearAllData() {
  if (!confirm('سيتم مسح جميع البيانات والمفاتيح. متأكد؟')) return;
  DB.clear();
  APP.config = {}; APP.leads = []; APP.inbox = []; APP.campaigns = [];
  showToast('🗑️ تم المسح');
  setTimeout(() => location.reload(), 800);
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
function init() {
  APP.config = DB.get('config', {}) || {};
  APP.leads = DB.get('leads', []) || [];
  APP.inbox = DB.get('inbox', []) || [];
  APP.campaigns = DB.get('campaigns', []) || [];

  const providers = ['groq', 'openrouter', 'gemini', 'mistral', 'anthropic', 'custom'];
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

  refreshFavoriteUI();

  const hasAnyKey = providers.some(p => APP.config['key_' + p] && APP.config['key_' + p].length > 10);
  updateApiStatus(hasAnyKey);
  refreshStats();
  renderDashboardCharts();
  renderDashSchedule();
  if (APP.campaigns.length) renderPastCampaigns();
}

// ============ EXPOSE TO GLOBAL ============
window.openPage = openPage;
window.toggleSidebar = toggleSidebar;
window.pickProvider = pickProvider;
window.toggleFavorite = toggleFavorite;
window.startDeepSearch = startDeepSearch;
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
window.clearAllData = clearAllData;
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
