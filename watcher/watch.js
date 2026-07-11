/**
 * مراقب طلبات بوابة فضاء 👻
 * يراقب Firestore (fada_leads) ويرسل كل طلب جديد واتساب على رقم نواف.
 *
 * أول تشغيل: يطلع QR — امسحه من واتساب (الأجهزة المرتبطة) مرة واحدة.
 * اختياري: حط ANTHROPIC_API_KEY في ملف .env هنا وبيضيف بريف ذكي لكل طلب.
 */
const {Client, LocalAuth} = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const os = require("os");

const MY_NUMBER = "966544198010"; // ← الرقم اللي توصله الطلبات
const POLL_MS = 45 * 1000;
const PROJECT = "ahdaf-influencers";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// مفتاح Claude (اختياري) من .env
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {}
const ANTHROPIC = process.env.ANTHROPIC_API_KEY || "";

// ---- توكن Google من جلسة firebase CLI (نفس حساب nawafalsawed) ----
let tokCache = {at: null, exp: 0};
async function accessToken() {
  if (tokCache.at && Date.now() < tokCache.exp) return tokCache.at;
  const cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", body});
  const d = await r.json();
  if (!d.access_token) throw new Error("فشل جلب التوكن — سوّ firebase login");
  tokCache = {at: d.access_token, exp: Date.now() + 45 * 60 * 1000};
  return d.access_token;
}

// ---- Firestore helpers ----
const gv = (f, k) => f?.[k]?.stringValue || "";
const garr = (f, k) => (f?.[k]?.arrayValue?.values || []).map((v) => v.stringValue);

async function fetchLeads() {
  const at = await accessToken();
  const r = await fetch(`${BASE}/fada_leads?pageSize=100`, {headers: {Authorization: `Bearer ${at}`}});
  const d = await r.json();
  return d.documents || [];
}

async function markNotified(docName, brief) {
  const at = await accessToken();
  const fields = {notifiedAt: {integerValue: String(Date.now())}};
  let mask = "updateMask.fieldPaths=notifiedAt";
  if (brief) {
    fields.brief = {stringValue: JSON.stringify(brief)};
    mask += "&updateMask.fieldPaths=brief";
  }
  await fetch(`https://firestore.googleapis.com/v1/${docName}?${mask}`, {
    method: "PATCH",
    headers: {Authorization: `Bearer ${at}`, "content-type": "application/json"},
    body: JSON.stringify({fields}),
  });
}

// ---- بريف Claude (اختياري) ----
async function makeBrief(lead) {
  if (!ANTHROPIC) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        system: `أنت مشرف استقبال طلبات في وكالة «فضاء» السعودية للإنتاج والتسويق وإنشاء المحتوى.
يوصلك طلب عميل جديد (JSON) عبّاه قبل اجتماعه الأول. أعد JSON فقط بلا أي نص إضافي:
{"summary":"بريف ٣-٥ أسطر بالعربي","seriousness":"عالي|متوسط|منخفض","red_flags":["نقاط انتباه"],"follow_up_questions":["٣ أسئلة للاجتماع الأول تحوله من استكشاف لإقفال"],"suggested_service_angle":"سطر: كيف تقدم فضاء عرضها لهذا العميل"}
لا تخترع معلومات. «ما حددت بعد» بالميزانية فرصة توجيه مو علامة حمراء. الأسئلة محددة بنشاط العميل.`,
        messages: [{role: "user", content: JSON.stringify(lead)}],
      }),
    });
    const d = await r.json();
    const txt = (d.content || []).filter((x) => x.type === "text").map((x) => x.text)
        .join("").replace(/```json|```/g, "").trim();
    return JSON.parse(txt);
  } catch (e) {
    console.error("  تعذّر البريف:", e.message);
    return null;
  }
}

// ---- صياغة الرسالة ----
function formatMsg(lead, brief) {
  const L = [];
  L.push("👻 *طلب جديد — بوابة فضاء*");
  L.push("");
  L.push(`*${lead.name}*${lead.brand ? " — " + lead.brand : ""}`);
  L.push(`📱 ${lead.phone}`);
  L.push(`🛠 ${lead.services.join(" + ")}`);
  L.push(`🎯 ${lead.goal || "غير محدد"}${lead.goalNote ? "\n📝 " + lead.goalNote : ""}`);
  L.push(`💰 ${lead.budget}   ⏰ ${lead.timing || "غير محدد"}`);
  if (brief) {
    L.push("");
    L.push(`📋 *البريف:*\n${brief.summary}`);
    L.push(`🌡 الجدية: ${brief.seriousness}`);
    for (const f of brief.red_flags || []) L.push(`⚠️ ${f}`);
    if ((brief.follow_up_questions || []).length) {
      L.push("");
      L.push("❓ *أسئلة للاجتماع:*");
      brief.follow_up_questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
    }
    if (brief.suggested_service_angle) L.push(`\n💡 ${brief.suggested_service_angle}`);
  }
  return L.join("\n");
}

// ---- واتساب ----
const client = new Client({
  authStrategy: new LocalAuth({dataPath: path.join(__dirname, "session")}),
  puppeteer: {headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"]},
});

client.on("qr", (qr) => {
  console.log("\n📲 امسح الكود من واتساب ← الإعدادات ← الأجهزة المرتبطة:\n");
  qrcode.generate(qr, {small: true});
});

client.on("ready", () => {
  console.log("✅ واتساب جاهز — أراقب طلبات البوابة كل ٤٥ ثانية…");
  console.log(`   الطلبات الجديدة بتوصل: ${MY_NUMBER}`);
  console.log(`   بريف Claude: ${ANTHROPIC ? "مفعّل ✨" : "غير مفعّل (حط ANTHROPIC_API_KEY في watcher/.env لتفعيله)"}`);
  poll();
  setInterval(poll, POLL_MS);
});

client.on("disconnected", (r) => {
  console.error("⚠️ انفصل واتساب:", r, "— أعد التشغيل.");
  process.exit(1);
});

let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const docs = await fetchLeads();
    for (const d of docs) {
      const f = d.fields || {};
      if (f.notifiedAt) continue; // مُرسل سابقاً
      const lead = {
        name: gv(f, "name"), brand: gv(f, "brand"), phone: gv(f, "phone"),
        services: garr(f, "services"), goal: gv(f, "goal"), goalNote: gv(f, "goalNote"),
        budget: gv(f, "budget"), timing: gv(f, "timing"),
      };
      console.log(`📥 طلب جديد: ${lead.name} (${lead.services.join("+")})`);
      const brief = await makeBrief(lead);
      await client.sendMessage(`${MY_NUMBER}@c.us`, formatMsg(lead, brief));
      await markNotified(d.name, brief);
      console.log("   ✅ أُرسل واتساب");
    }
  } catch (e) {
    console.error("⚠️ خطأ بالمراقبة (بحاول بالدورة الجاية):", e.message);
  }
  busy = false;
}

console.log("👻 مراقب بوابة فضاء — جارٍ تشغيل واتساب…");
client.initialize();
