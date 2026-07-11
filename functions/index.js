/**
 * بوابة فضاء — المشرف الذكي
 * الواجهة تكتب الطلب مباشرة في fada_leads (قواعد create-only).
 * هذا الترغر يشتغل عند كل طلب جديد: Claude يطلّع بريف منظم للفريق
 * (ملخص + جدية + علامات حمراء + أسئلة متابعة) → يحدّث المستند → يرسل تيليغرام.
 *
 * ملاحظة: النشر يتطلب خطة Blaze. الواجهة تشتغل بدونه (الطلبات تنحفظ خام)،
 * وأول ما ينشر يبدأ يشرف على كل طلب جديد تلقائياً.
 */
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret, defineString} = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_KEY");
// اختياري — عبّهما لتفعيل إشعار تيليغرام للفريق
const TELEGRAM_TOKEN = defineString("FADA_TELEGRAM_TOKEN", {default: ""});
const TELEGRAM_CHAT = defineString("FADA_TELEGRAM_CHAT", {default: ""});

const BRIEF_PROMPT = `أنت مشرف استقبال طلبات في وكالة «فضاء» السعودية للإنتاج والتسويق وإنشاء المحتوى.
يوصلك طلب عميل جديد (JSON) عبّاه قبل اجتماعه الأول مع الفريق. جهّز بريف داخلي للفريق.
أعد JSON فقط بلا أي نص إضافي وبلا علامات برمجية:
{
 "summary": "بريف من ٣-٥ أسطر بالعربي يلخص من العميل ووش يبي ووش المتوقع",
 "seriousness": "عالي" أو "متوسط" أو "منخفض",
 "red_flags": ["أي تعارض أو نقطة انتباه — مثل ميزانية لا تناسب الطلب، أو توقيت ضيق، أو طلب غامض"],
 "follow_up_questions": ["٣ أسئلة بالضبط يسألها الفريق بالاجتماع الأول لتحويله من استكشاف إلى إقفال"],
 "suggested_service_angle": "سطر واحد: كيف تقدّم فضاء عرضها لهذا العميل بالذات"
}
القواعد:
- لا تخترع معلومات غير موجودة بالطلب. إذا الحقل فاضي قل «غير محدد».
- «ما حددت بعد» بالميزانية ليست علامة حمراء بذاتها — هي فرصة توجيه.
- اجعل الأسئلة محددة بنشاط العميل، لا أسئلة عامة.`;

exports.fadaSupervisor = onDocumentCreated(
    {
      document: "fada_leads/{leadId}",
      secrets: [ANTHROPIC_KEY],
      region: "europe-west1",
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const lead = snap.data();
      if (lead.brief) return; // مُعالج مسبقاً

      // --- البريف عبر Claude ---
      let brief = null;
      try {
        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": ANTHROPIC_KEY.value(),
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 700,
            system: BRIEF_PROMPT,
            messages: [{
              role: "user",
              content: JSON.stringify({
                services: lead.services, goal: lead.goal, goalNote: lead.goalNote,
                budget: lead.budget, timing: lead.timing,
                name: lead.name, brand: lead.brand,
              }),
            }],
          }),
        });
        const data = await aiRes.json();
        const txt = (data.content || []).filter((x) => x.type === "text")
            .map((x) => x.text).join("").trim()
            .replace(/```json|```/g, "").trim();
        brief = JSON.parse(txt);
        await snap.ref.update({brief, briefTs: Date.now()});
      } catch (e) {
        console.error("brief generation failed:", e);
      }

      // --- إشعار الفريق عبر تيليغرام ---
      const token = TELEGRAM_TOKEN.value();
      const chat = TELEGRAM_CHAT.value();
      if (!token || !chat) return;

      const flags = (brief?.red_flags || []).map((f) => `⚠️ ${f}`).join("\n");
      const qs = (brief?.follow_up_questions || [])
          .map((q, i) => `${i + 1}. ${q}`).join("\n");
      const msg = [
        `👻 *طلب جديد — بوابة فضاء*`,
        ``,
        `*${lead.name}* — ${lead.brand || "بدون جهة"}`,
        `📱 ${lead.phone}`,
        `🛠 ${(lead.services || []).join(" + ")}`,
        `🎯 ${lead.goal || "غير محدد"}${lead.goalNote ? " — " + lead.goalNote : ""}`,
        `💰 ${lead.budget}  ·  ⏰ ${lead.timing || "غير محدد"}`,
        brief ? `\n📋 *البريف:*\n${brief.summary}` : "\n(تعذّر توليد البريف — الطلب خام)",
        brief ? `\n🌡 الجدية: ${brief.seriousness}` : "",
        flags ? `\n${flags}` : "",
        qs ? `\n❓ *أسئلة للاجتماع:*\n${qs}` : "",
        brief?.suggested_service_angle ? `\n💡 ${brief.suggested_service_angle}` : "",
      ].filter(Boolean).join("\n");

      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({chat_id: chat, text: msg, parse_mode: "Markdown"}),
        });
      } catch (e) {
        console.error("telegram notify failed:", e);
      }
    });
