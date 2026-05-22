// ============================================================================
//  MTC Sales Backend Server
//  خادم نظام مبيعات MTC الخلفي - شركة محمد للنقليات
//
//  الوظائف:
//  1. إرسال البريد الإلكتروني عبر Gmail SMTP
//  2. تتبع فتح الرسائل (Pixel Tracking)
//  3. استقبال الردود من البريد الوارد (IMAP)
//  4. روابط إلغاء الاشتراك
//  5. إعادة الإرسال التلقائي الأسبوعي للرسائل غير المفتوحة
//  6. (اختياري) إرسال WhatsApp عبر Meta Cloud API
// ============================================================================

// --- استيراد المكتبات المطلوبة ---
const express = require('express');        // إطار العمل لإنشاء الخادم
const nodemailer = require('nodemailer');  // لإرسال البريد الإلكتروني
const cors = require('cors');              // للسماح للواجهة بالاتصال من نطاق آخر
const Imap = require('imap');              // لقراءة البريد الوارد
const cron = require('node-cron');         // لجدولة المهام التلقائية

// --- إنشاء تطبيق Express ---
const app = express();

// تفعيل CORS — يسمح للواجهة المنشورة على Vercel/Netlify بالاتصال بالخادم
// يقبل الطلبات من أي نطاق (آمن لخادم API عام)
app.use(cors());

// تفعيل قراءة JSON من الطلبات الواردة (حد أقصى 5 ميجابايت)
app.use(express.json({ limit: '60mb' })); // 60mb للسماح بمرفقات كبيرة base64 (الحد الفعلي ~40mb)

// --- قاعدة بيانات بسيطة في الذاكرة لتخزين بيانات التتبع ---
// ملاحظة: البيانات تُمسح عند إعادة تشغيل الخادم
// للحفظ الدائم، استخدم MongoDB أو PostgreSQL لاحقاً
const tracking = {};

// شكل البيانات في كل سجل:
// tracking['abc123'] = {
//   to: 'client@example.com',     // البريد المستلم
//   leadName: 'اسم الشركة',        // اسم العميل
//   sentAt: 1718000000000,         // وقت الإرسال (timestamp)
//   openedAt: null,                // وقت الفتح (null = لم يُفتح بعد)
//   unsubscribed: false,           // هل ألغى الاشتراك؟
//   resends: 0,                    // عدد مرات إعادة الإرسال
//   body: '...',                   // نص الرسالة الأصلي (لإعادة الإرسال)
//   subject: '...',                // الموضوع
//   from: '...',                   // المرسل
//   fromName: '...'                // اسم المرسل الظاهر
// }

// --- إعداد ناقل البريد عبر Gmail ---
// يستخدم بيانات SMTP من متغيرات البيئة (.env أو إعدادات Render)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,   // بريد Gmail الخاص بك
    pass: process.env.SMTP_PASS    // كلمة مرور التطبيق (16 حرف من Google)
  }
});

// التحقق من نجاح الاتصال بـ Gmail عند بدء التشغيل
transporter.verify((error) => {
  if (error) {
    console.error('❌ فشل الاتصال بـ Gmail:', error.message);
    console.error('   تأكد من صحة SMTP_USER و SMTP_PASS في متغيرات البيئة');
  } else {
    console.log('✅ الاتصال بـ Gmail جاهز');
  }
});

// ============================================================================
//  المسار 1: فحص الصحة (Health Check)
//  يستخدم للتأكد من أن الخادم يعمل
//  URL: GET /api/health
// ============================================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MTC Sales Backend',
    time: Date.now(),
    tracking_count: Object.keys(tracking).length,
    uptime_seconds: Math.floor(process.uptime())
  });
});

// مسار جذر بسيط (لاختبار الرابط)
app.get('/', (req, res) => {
  res.send(`
    <html dir="rtl">
      <head><meta charset="utf-8"><title>MTC Sales Backend</title></head>
      <body style="font-family:Arial;text-align:center;padding:40px;background:#0a1a33;color:#caa84d">
        <h1>🚀 MTC Sales Backend</h1>
        <p style="color:#eee">الخادم يعمل بنجاح</p>
        <p style="color:#888;font-size:13px">للتحقق: <a href="/api/health" style="color:#caa84d">/api/health</a></p>
      </body>
    </html>
  `);
});

// ============================================================================
//  المسار 2: إرسال بريد إلكتروني
//  يستقبل: { to, body, from, fromName, leadName }
//  يرجع: { ok: true, id: 'abc123' }
//  URL: POST /api/send
// ============================================================================
app.post('/api/send', async (req, res) => {
  const { to, body, from, fromName, leadName, attachments } = req.body;

  // --- التحقق من البيانات الأساسية ---
  if (!to || !body) {
    return res.status(400).json({
      ok: false,
      error: 'البريد المستلم والنص مطلوبان'
    });
  }

  // --- تحضير المرفقات إن وُجدت ---
  // المرفقات تُرسل كـ base64 من الواجهة
  // nodemailer يحوّلها تلقائياً عند تمرير encoding: 'base64'
  let mailAttachments = [];
  if (Array.isArray(attachments) && attachments.length > 0) {
    mailAttachments = attachments.map(att => ({
      filename: att.filename,
      content: att.content,
      encoding: att.encoding || 'base64'
    }));
    console.log(`📎 Sending ${mailAttachments.length} attachments to ${to}`);
  }

  // --- إنشاء معرّف فريد لهذه الرسالة (لتتبع الفتح) ---
  const id = Buffer.from(to + Date.now() + Math.random()).toString('base64url').substring(0, 24);

  // --- استخراج الموضوع من أول سطر في النص ---
  // الواجهة ترسل النص مع "الموضوع: ..." في أول سطر
  const lines = body.split('\n');
  let subject = 'بخصوص خدمات النقل اللوجستي';
  let content = body;
  if (lines[0] && lines[0].includes('الموضوع:')) {
    subject = lines[0].replace(/الموضوع:/, '').trim();
    content = lines.slice(1).join('\n').trim();
  }

  // --- إضافة بيكسل التتبع (صورة 1×1 شفافة) ---
  // عندما يفتح العميل البريد، يحمّل المتصفح هذه الصورة من خادمنا
  // فنعرف أنه فتح الرسالة
  const pixelUrl = `${process.env.PUBLIC_URL}/api/track/${id}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0" alt="">`;

  // --- إضافة رابط إلغاء الاشتراك (مطلوب قانونياً ولمنع التصنيف كسبام) ---
  const unsubUrl = `${process.env.PUBLIC_URL}/api/unsub/${id}`;
  const unsub = `
    <hr style="margin-top:30px;border:0;border-top:1px solid #ddd">
    <div style="font-size:11px;color:#888;text-align:center;direction:rtl">
      إذا لم تعد ترغب باستقبال رسائلنا، يمكنك
      <a href="${unsubUrl}" style="color:#888">إلغاء الاشتراك</a>
    </div>
  `;

  // --- تحويل النص العادي إلى HTML مع تنسيق ---
  const htmlContent = `
    <div dir="rtl" style="font-family:'Tahoma',Arial,sans-serif;line-height:1.8;color:#333;max-width:600px;margin:0 auto;padding:20px">
      ${content.replace(/\n/g, '<br>')}
      ${unsub}
      ${pixel}
    </div>
  `;

  try {
    // --- الإرسال الفعلي عبر Gmail ---
    await transporter.sendMail({
      from: `"${fromName || 'MTC'}" <${process.env.SMTP_USER}>`,
      replyTo: from || process.env.SMTP_USER,
      to: to,
      subject: subject,
      html: htmlContent,
      attachments: mailAttachments, // المرفقات (إن وُجدت)
      // ترويسات لمنع التصنيف كسبام
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:${process.env.SMTP_USER}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Mailer': 'MTC Sales Platform v1.0'
      }
    });

    // --- حفظ بيانات الرسالة في التتبع ---
    tracking[id] = {
      to: to,
      leadName: leadName || '',
      sentAt: Date.now(),
      openedAt: null,
      unsubscribed: false,
      resends: 0,
      body: body,
      subject: subject,
      from: from,
      fromName: fromName
    };

    console.log(`✉️  Sent to ${to} (id: ${id})`);
    res.json({ ok: true, id: id, sentAt: tracking[id].sentAt });
  } catch (e) {
    console.error('❌ Email send error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================================
//  المسار 3: بيكسل التتبع
//  يستقبل طلب صورة، يسجّل أن العميل فتح البريد، ثم يرجع صورة شفافة 1×1
//  URL: GET /api/track/:id
// ============================================================================
app.get('/api/track/:id', (req, res) => {
  const t = tracking[req.params.id];

  // إذا كانت الرسالة موجودة ولم تُفتح من قبل، سجّل وقت الفتح
  if (t && !t.openedAt) {
    t.openedAt = Date.now();
    console.log(`📬 Email opened by ${t.to} at ${new Date(t.openedAt).toLocaleString('ar-SA')}`);
  }

  // إرجاع صورة GIF شفافة 1×1 بكسل
  const transparentPixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.send(transparentPixel);
});

// ============================================================================
//  المسار 4: إلغاء الاشتراك
//  عندما يضغط العميل على رابط "إلغاء الاشتراك" تُسجّل رغبته ويتوقف الإرسال
//  URL: GET /api/unsub/:id
// ============================================================================
app.get('/api/unsub/:id', (req, res) => {
  const t = tracking[req.params.id];
  if (t) {
    t.unsubscribed = true;
    console.log(`🚫 ${t.to} unsubscribed`);
  }

  res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>تم إلغاء الاشتراك</title>
      </head>
      <body style="font-family:'Tahoma',Arial,sans-serif;text-align:center;padding:60px 20px;background:#0a1a33;color:#eee;margin:0">
        <div style="max-width:500px;margin:0 auto;background:rgba(19,40,77,0.7);border:1px solid rgba(202,168,77,0.3);border-radius:14px;padding:40px">
          <div style="font-size:48px;margin-bottom:20px">✓</div>
          <h2 style="color:#caa84d;margin:0 0 16px">تم إلغاء اشتراكك بنجاح</h2>
          <p style="color:#b8c5dc;line-height:1.8">لن تصلك أي رسائل أخرى من شركة محمد للنقليات.</p>
          <p style="font-size:13px;color:#888;margin-top:30px">شكراً لاهتمامك السابق.</p>
        </div>
      </body>
    </html>
  `);
});

// ============================================================================
//  المسار 5: حالة التتبع
//  ترجع كل بيانات التتبع (لاستخدامها في صفحة التحليلات)
//  URL: GET /api/status
// ============================================================================
app.get('/api/status', (req, res) => {
  const all = Object.values(tracking);
  const total = all.length;
  const opened = all.filter(t => t.openedAt).length;
  const unsubscribed = all.filter(t => t.unsubscribed).length;

  res.json({
    total: total,
    opened: opened,
    unsubscribed: unsubscribed,
    open_rate: total ? Math.round((opened / total) * 100) : 0,
    details: tracking
  });
});

// ============================================================================
//  المسار 6: قراءة البريد الوارد (IMAP)
//  يجلب آخر 20 رسالة غير مقروءة من Gmail Inbox
//  URL: GET /api/inbox
// ============================================================================
app.get('/api/inbox', (req, res) => {
  const imap = new Imap({
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  const messages = [];
  let responseSent = false;

  const sendResponse = (data, status = 200) => {
    if (responseSent) return;
    responseSent = true;
    if (status === 200) res.json(data);
    else res.status(status).json(data);
  };

  imap.once('ready', () => {
    imap.openBox('INBOX', true, (err) => {
      if (err) {
        imap.end();
        return sendResponse({ error: err.message }, 500);
      }

      imap.search(['UNSEEN'], (e, results) => {
        if (e) {
          imap.end();
          return sendResponse({ error: e.message }, 500);
        }
        if (!results || !results.length) {
          imap.end();
          return sendResponse([]);
        }

        // جلب آخر 20 رسالة
        const f = imap.fetch(results.slice(-20), {
          bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
          struct: true
        });

        f.on('message', (msg) => {
          msg.on('body', (stream) => {
            let buf = '';
            stream.on('data', (d) => buf += d.toString('utf8'));
            stream.once('end', () => {
              const header = Imap.parseHeader(buf);
              messages.push({
                from: header.from?.[0] || '',
                subject: header.subject?.[0] || '',
                date: header.date?.[0] || ''
              });
            });
          });
        });

        f.once('end', () => {
          imap.end();
          sendResponse(messages);
        });

        f.once('error', (err) => {
          imap.end();
          sendResponse({ error: err.message }, 500);
        });
      });
    });
  });

  imap.once('error', (err) => {
    console.error('IMAP error:', err.message);
    sendResponse({ error: err.message }, 500);
  });

  imap.connect();
});

// ============================================================================
//  المسار 7: إرسال عبر WhatsApp Business API (اختياري)
//  يستخدم بيانات WhatsApp Cloud API من Meta
//  URL: POST /api/wa-send
// ============================================================================
app.post('/api/wa-send', async (req, res) => {
  const { to, message, phoneNumberId, accessToken } = req.body;

  if (!to || !message || !phoneNumberId || !accessToken) {
    return res.status(400).json({ ok: false, error: 'البيانات ناقصة' });
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const cleanPhone = to.replace(/\D/g, '');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: message }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ ok: false, error: data.error?.message || 'فشل الإرسال' });
    }
    res.json({ ok: true, messageId: data.messages?.[0]?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================================
//  الجدولة التلقائية: إعادة الإرسال أسبوعياً للرسائل غير المفتوحة
//  يعمل كل يوم في الساعة 10 صباحاً بتوقيت الخادم
// ============================================================================
cron.schedule('0 10 * * *', async () => {
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  let resentCount = 0;

  console.log('🔄 بدء فحص إعادة الإرسال التلقائية...');

  for (const [id, t] of Object.entries(tracking)) {
    // الشروط:
    // 1. لم تُفتح الرسالة
    // 2. لم يُلغ الاشتراك
    // 3. مرّ أسبوع على آخر إرسال
    // 4. لم نعد الإرسال أكثر من 3 مرات
    if (!t.openedAt && !t.unsubscribed && (now - t.sentAt) >= oneWeek && (t.resends || 0) < 3) {
      try {
        const newId = Buffer.from(t.to + Date.now() + '-resend').toString('base64url').substring(0, 24);

        const followupSubjects = [
          'متابعة: ' + t.subject,
          'تذكير: ' + t.subject,
          'لم تتلقَّ ردنا بعد - ' + t.subject
        ];
        const newSubject = followupSubjects[t.resends % 3];

        const pixel = `<img src="${process.env.PUBLIC_URL}/api/track/${newId}" width="1" height="1" style="display:none">`;
        const unsub = `<br><br><a href="${process.env.PUBLIC_URL}/api/unsub/${newId}" style="color:#888;font-size:11px">إلغاء الاشتراك</a>`;

        const lines = t.body.split('\n');
        const content = lines[0].includes('الموضوع:') ? lines.slice(1).join('\n').trim() : t.body;
        const html = `<div dir="rtl">${content.replace(/\n/g, '<br>')}${unsub}${pixel}</div>`;

        await transporter.sendMail({
          from: `"${t.fromName || 'MTC'}" <${process.env.SMTP_USER}>`,
          to: t.to,
          subject: newSubject,
          html: html
        });

        t.resends = (t.resends || 0) + 1;
        t.sentAt = now;
        tracking[newId] = { ...t, openedAt: null };
        resentCount++;

        console.log(`✉️ إعادة إرسال إلى ${t.to} (المحاولة ${t.resends})`);

        // تأخير 30 ثانية بين كل رسالة وأخرى
        await new Promise(r => setTimeout(r, 30000));
      } catch (e) {
        console.error(`❌ فشل إعادة الإرسال إلى ${t.to}:`, e.message);
      }
    }
  }

  console.log(`✅ انتهى الفحص. تم إعادة إرسال ${resentCount} رسالة.`);
});

// ============================================================================
//  معالجة الأخطاء العامة
// ============================================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: err.message });
});

// مسار غير موجود
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'المسار غير موجود' });
});

// ============================================================================
//  بدء تشغيل الخادم
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('  🚀 MTC Sales Backend');
  console.log('  ─────────────────────────────────────');
  console.log(`  Port:    ${PORT}`);
  console.log(`  Mode:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`  SMTP:    ${process.env.SMTP_USER || 'NOT SET'}`);
  console.log(`  PUBLIC:  ${process.env.PUBLIC_URL || 'NOT SET'}`);
  console.log('═══════════════════════════════════════');
});
