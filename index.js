/**
 * NID Service Bot - WhatsApp Cloud API Version
 * Advanced Automation: Dynamic PHP Session Login, Double-Layer Balance Control & MongoDB History
 */

require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FormData = require("form-data");
const puppeteer = require("puppeteer");
const { MongoClient } = require("mongodb");

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  // WhatsApp Cloud API
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION: "v21.0",

  // আপনার ওয়েবসাইটের ক্রেডেনশিয়ালস
  PHP_SITE_BASE_URL: process.env.PHP_SITE_BASE_URL || "https://my-gov-bd.site",
  PHP_BOT_EMAIL: "irfanbot@gmail.com",
  PHP_BOT_PASS: "p@@ss: irfan2002",

  // MongoDB Connection URI
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://sazzadpc4_db_user:Xr53oHTfLujIKDlw@cluster0.mongodb.net/?retryWrites=true&w=majority",
};

// Global Variables for State
let db, usersColl, statsColl, settingsColl, historyColl;
let phpSessionCookies = ""; // সাইটের লাইভ সেশন কুকি স্টোর করার জন্য

// ========== MONGODB SETUP ==========
async function connectMongoDB() {
  try {
    const client = new MongoClient(CONFIG.MONGO_URI);
    await client.connect();
    db = client.db("nid_whatsapp_bot");
    
    // কালেকশনস ডিফাইন
    usersColl = db.collection("users");
    statsColl = db.collection("stats");
    settingsColl = db.collection("settings");
    historyColl = db.collection("history"); // আলাদা ইউজার হিস্ট্রি ট্র্যাকিংয়ের জন্য

    console.log("✅ MongoDB Connected & Database Initialized.");
    
    // ডিফল্ট সেটিংস চেক বা তৈরি
    const settings = await settingsColl.findOne({ _id: "bot_settings" });
    if (!settings) {
      await settingsColl.insertOne({ _id: "bot_settings", cardPrice: 10 }); // ডিফল্ট ১০ টাকা রেট
    }
  } catch (e) {
    console.error("❌ MongoDB Connection Failed! Bot will retry or exit.", e.message);
    process.exit(1);
  }
}

// ========== AUTOMATED WEBSITE LOGIN ==========
// এই ফাংশনটি আপনার ওয়েবসাইটের লগইন পেজে গিয়ে রিয়েল সেশন কুকি কালেক্ট করে নিয়ে আসবে
async function loginToPhpSite() {
  try {
    console.log("🔐 Website-এ লগইন সেশন তৈরি করার চেষ্টা করা হচ্ছে...");
    const params = new URLSearchParams();
    
    // আপনার সাইটের লগইন ফর্মের নাম অনুযায়ী ইনপুট নেম (সাধারণত email/username এবং password হয়)
    params.append("email", CONFIG.PHP_BOT_EMAIL); 
    params.append("password", CONFIG.PHP_BOT_PASS);
    params.append("login", "submit"); // যদি সাবমিট বাটন ভ্যালু থাকে

    const response = await axios.post(`${CONFIG.PHP_SITE_BASE_URL}/index.php`, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0, // রিডাইরেক্ট হওয়া আটকে কুকি নেওয়া
      validateStatus: (status) => status >= 200 && status < 400
    });

    // রেসপন্স হেডার থেকে PHPSESSID এবং user_id কুকি ফিল্টার করা
    const cookies = response.headers["set-cookie"];
    if (cookies && cookies.length > 0) {
      phpSessionCookies = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল! নতুন সেশন কুকি জেনারেট হয়েছে:", phpSessionCookies);
      return true;
    }
    
    // যদি রিডাইরেক্ট না হয়ে ডিরেক্ট সাকসেস দেয় (যেমন AJAX লগইন)
    if (response.data) {
      const cookies = response.headers["set-cookie"];
      if(cookies) {
         phpSessionCookies = cookies.map(c => c.split(";")[0]).join("; ");
         return true;
      }
    }
    
    console.error("❌ লগইন রেসপন্সে কোনো কুকি পাওয়া যায়নি।");
    return false;
  } catch (error) {
    // কিছু ক্ষেত্রে ৩0২ রিডাইরেক্ট হেডার থেকে কুকি পাওয়া যায়
    if (error.response && error.response.headers["set-cookie"]) {
      phpSessionCookies = error.response.headers["set-cookie"].map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল (Redirect-Based Cookie Captured).");
      return true;
    }
    console.error("❌ ওয়েবসাইট লগইন এপিআই ফেইল হয়েছে:", error.message);
    return false;
  }
}

// ========== STRICT USER & BALANCE MANAGEMENT ==========
function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0")) n = "880" + n.slice(1);
  if (!n.startsWith("880") && n.length === 10) n = "880" + n;
  return n;
}

async function isAllowed(number) {
  const user = await usersColl.findOne({ number: normalizeNumber(number) });
  return user && user.active !== false;
}

async function getUserBalance(number) {
  const user = await usersColl.findOne({ number: normalizeNumber(number) });
  return user ? (user.balance || 0) : 0;
}

async function getCardPrice() {
  const settings = await settingsColl.findOne({ _id: "bot_settings" });
  return settings ? settings.cardPrice : 0;
}

// আলাদা ইউজার হিস্ট্রি ডাটাবেজে স্টোর করার ফাংশন
async function logToHistory(number, nid, dob, status, charge, balanceAfter, remarks) {
  await historyColl.insertOne({
    number: normalizeNumber(number),
    nid: nid,
    dob: dob,
    status: status, // 'success' অথবা 'failed'
    charge: charge,
    balanceAfterCut: balanceAfter,
    remarks: remarks,
    timestamp: new Date()
  });
}

// ========== WHATSAPP CLOUD API HELPERS ==========
const WA_BASE    = `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = () => ({ Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" });

async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}

async function markRead(messageId) {
  try { await axios.post(`${WA_BASE}/messages`, { messaging_product: "whatsapp", status: "read", message_id: messageId }, { headers: WA_HEADERS() }); } catch {}
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp", to, type: "document", document: { id: mediaId, filename, caption }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendDocument error:", e.response?.data || e.message); }
}

// ========== LIVE SERVER SEARCH & PUPPETEER ENGINE ==========

// ১. সাইটের insert_un_server_24.php ফাইলে সার্চ এক্সিকিউট করা
async function searchNIDOnServer(nid, dob) {
  try {
    if (!phpSessionCookies) {
      await loginToPhpSite(); // যদি কুকি না থাকে, আগে লগইন করবে
    }

    const params = new URLSearchParams();
    params.append("nid", nid);
    params.append("dob", dob);

    const response = await axios.post(`${CONFIG.PHP_SITE_BASE_URL}/insert_un_server_24.php`, params.toString(), {
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": phpSessionCookies // সংগৃহীত রিয়েল এডমিন/বট সেশন কুকি
      },
      timeout: 50000
    });

    return response.data;
  } catch (error) {
    console.error("Axios Search Error:", error.message);
    // যদি সেশন মারা যায় (Session Expired), পুনরায় লগইন করে আরেকবার ট্রাই করবে
    if (error.response && (error.response.status === 401 || error.response.status === 302)) {
      console.log("🔄 সেশন এক্সপায়ার হয়েছে। রি-লগইন করা হচ্ছে...");
      const loginOk = await loginToPhpSite();
      if (loginOk) return await searchNIDOnServer(nid, dob); // রি-ট্রাই
    }
    return { status: "error", message: "ওয়েবসাইট সার্ভারে সংযোগ করা সম্ভব হচ্ছে না।" };
  }
}

// ২. Puppeteer দিয়ে লাইভ পেজ ভিজিট এবং PDF রেন্ডার
async function renderNIDToPdf(nid, dob) {
  const targetUrl = `${CONFIG.PHP_SITE_BASE_URL}/server_download_v2_24.php?nid=${nid}&id=${dob}`;
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1241, height: 1755, deviceScaleFactor: 2 });

    // Puppeteer ব্রাউজারে সেশন কুকি ইনজেক্ট করা যাতে ডাউনলোড পেজ সরাসরি ওপেন হয়
    if (phpSessionCookies) {
      const cookieArray = phpSessionCookies.split(";").map(pair => {
        const [name, value] = pair.trim().split("=");
        return {
          name: name,
          value: value,
          domain: new URL(CONFIG.PHP_SITE_BASE_URL).hostname,
          path: "/"
        };
      });
      for (const cookie of cookieArray) {
        if(cookie.name && cookie.value) await page.setCookie(cookie);
      }
    }

    await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 1500)); // ফন্ট লোড সেফটি বাফার

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      preferCSSPageSize: true
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ========== WHATSAPP INCOMING MESSAGE HANDLER ==========
async function handleIncoming(msg) {
  const from  = msg.from;
  const msgId = msg.id;
  markRead(msgId);

  if (msg.type === "text") {
    const text = msg.text.body.trim();
    const lowerText = text.toLowerCase();

    if (lowerText === ".ping" || lowerText === "ping") return sendText(from, "🟢 Pong! Bot সচল আছে।");
    if (lowerText === ".status" || lowerText === "status") {
      if (!(await isAllowed(from))) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
      const bal   = await getUserBalance(from);
      const price = await getCardPrice();
      return sendText(from, `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
    }

    // RegEx দিয়ে ডেটা এক্সট্রাক্ট করা
    const nidRegex = /(\d{10}|\d{17})/;
    const dobRegex = /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/;

    const hasNid = text.match(nidRegex);
    const hasDob = text.match(dobRegex);

    if (hasNid && hasDob) {
      if (!(await isAllowed(from))) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");

      const price = await getCardPrice();
      const currentBalance = await getUserBalance(from);

      // 🛡️ স্তর ১: বটের লেভেলে কঠোর ব্যালেন্স চেক
      if (price > 0 && currentBalance < price) {
        await logToHistory(from, hasNid[0], hasDob[0], "failed", 0, currentBalance, "Insufficient Bot Balance");
        return sendText(from, `❌ আপনার বটের ব্যালেন্স কম! একটি কার্ডের জন্য ${price} টাকা প্রয়োজন।\nআপনার বর্তমান ব্যালেন্স: ${currentBalance} টাকা।`);
      }

      const nid = hasNid[0];
      const dob = hasDob[0];

      await sendText(from, `🔍 NID: ${nid} সার্ভারে খোঁজা হচ্ছে... অনুগ্রহ করে একটু অপেক্ষা করুন।`);

      try {
        // ধাপ ১: ওয়েবসাইট ব্যাকএন্ডে রিকোয়েস্ট দিয়ে চেক করা
        const searchResult = await searchNIDOnServer(nid, dob);
        const result = typeof searchResult === "string" ? JSON.parse(searchResult) : searchResult;

        // 🛑 স্তর ২: আপনার ওয়েবসাইট সার্ভার থেকে এরর রেসপন্স চেক
        if (result.status === "error" || result.status === "failed") {
          const errMsg = result.message || "কোনো তথ্য পাওয়া যায়নি বা সার্ভার ব্যালেন্স শেষ।";
          
          // ব্যর্থতার রেকর্ড হিস্ট্রি কালেকশনে সেভ
          await logToHistory(from, nid, dob, "failed", 0, currentBalance, `Server Error: ${errMsg}`);
          
          return sendText(from, `❌ ওয়েবসাইট সার্ভার থেকে এরর এসেছে:\n\n"${errMsg}"\n\n[অনুরোধটি বাতিল করা হয়েছে, কোনো ব্যালেন্স কাটা হয়নি]`);
        }

        // ধাপ ২: সার্চ সফল হলেই কেবল Puppeteer দিয়ে ডাউনলোড পেজ জেনারেট করা হবে
        await sendText(from, `📥 তথ্য পাওয়া গেছে! পিডিএফ (PDF) কপি তৈরি করা হচ্ছে...`);
        const pdfBuffer = await renderNIDToPdf(nid, dob);

        // 💳 ব্যালেন্স ডিডাকশন (নিখুঁত ও কঠোর কাট)
        const finalBalance = currentBalance - price;
        await usersColl.updateOne({ number: normalizeNumber(from) }, { $set: { balance: finalBalance } });

        // সফল কাজের হিস্ট্রি ডাটাবেজে স্টোর
        await logToHistory(from, nid, dob, "success", price, finalBalance, "Successfully generated and sent");

        // স্ট্যাটস আপডেট
        await statsColl.updateOne(
          { _id: normalizeNumber(from) },
          { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
          { upsert: true }
        );

        const filename = `nid-${nid}.pdf`;
        const caption  = `✅ আপনার NID সার্ভার কপি তৈরি হয়েছে!\n\n🆔 NID: ${nid}\n🎂 DOB: ${dob}\n${price > 0 ? `💰 Remaining Balance: ${finalBalance} টাকা` : ""}`;

        // হোয়াটসঅ্যাপে ফাইল ডেলিভারি
        const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");
        await sendDocument(from, mediaId, filename, caption);

      } catch (err) {
        console.error("Main Flow Error:", err.message);
        await logToHistory(from, nid, dob, "failed", 0, currentBalance, `System Crash: ${err.message}`);
        await sendText(from, `❌ ইন্টারনাল সার্ভার ক্রাশ! অনুগ্রহ করে আবার চেষ্টা করুন।\nError: ${err.message}`);
      }
      return;
    }

    if (hasNid && !hasDob) {
      return sendText(from, "⚠️ আপনি জন্মতারিখ (DOB) দেননি। অনুগ্রহ করে NID এবং জন্মতারিখ স্পেস দিয়ে একসাথে লিখে পাঠান। (যেমন: 1234567890 1995-12-25)");
    }

    return sendText(from, "📄 NID সার্ভার কপি বের করতে NID নম্বর এবং জন্মতারিখ একসাথে লিখে পাঠান।\n\nউদাহরণ:\n1234567890 1995-12-25\n\nCommands:\n.ping - bot check\n.status - balance check");
  }
}

// ========== EXPRESS SERVER & WEBHOOKS ==========
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry    = req.body.entry?.[0];
    const change   = entry?.changes?.[0]?.value;
    const messages = change?.messages || [];
    for (const msg of messages) {
      await handleIncoming(msg);
    }
  } catch (e) { console.error("Webhook endpoint error:", e.message); }
});

app.get("/", (req, res) => res.send("✅ NID MongoDB Advanced Bot is running live."));

// ========== ADMIN PANEL PANEL WITH LIVE MONGO DATA ==========
const adminSessions = new Set();
function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:30px;background:#f5f5f5;border-radius:8px;">
    <h2>🔐 Admin Login</h2>
    <form method="POST" action="/admin/login">
      <input name="password" type="password" placeholder="Password" style="width:100%;padding:10px;margin:10px 0;" required/>
      <button type="submit" style="width:100%;padding:10px;background:#0078d4;color:#fff;border:0;border-radius:4px;cursor:pointer;">Login</button>
    </form>
  </body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const tok = crypto.randomBytes(16).toString("hex");
    adminSessions.add(tok);
    res.setHeader("Set-Cookie", `admin_sess=${tok}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/admin");
  }
  res.send("❌ Wrong password. <a href='/admin/login'>Try again</a>");
});

app.get("/admin", adminAuth, async (req, res) => {
  const users = await usersColl.find({}).toArray();
  const settings = await settingsColl.findOne({ _id: "bot_settings" });
  
  let rows = "";
  for (const u of users) {
    const s = await statsColl.findOne({ _id: normalizeNumber(u.number) }) || { count: 0, lastUsed: "—" };
    rows += `<tr>
      <td>${u.number}</td>
      <td>${u.name || "—"}</td>
      <td style="color:green;font-weight:bold">${u.balance || 0} ৳</td>
      <td>${u.active !== false ? "✅" : "❌"}</td>
      <td>${s.count}</td>
      <td style="font-size:11px">${s.lastUsed || "—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline;">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="টাকা" type="number" style="width:65px;padding:3px" required/>
          <button name="type" value="add" style="background:#28a745;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">+Add</button>
        </form>
      </td>
    </tr>`;
  }

  res.send(`<html><head><style>
    body{font-family:sans-serif;max-width:1200px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#0078d4;color:#fff}
    .card{background:#f9f9f9;padding:15px;margin:10px 0;border-radius:6px;border:1px solid #ddd}
  </style></head><body>
    <h1>📊 NID Bot Admin (Strict Balance & MongoDB History)</h1>
    <div class="card">
      <h3>⚙️ Configuration</h3>
      <form method="POST" action="/admin/settings">
        Card Price (৳): <input name="cardPrice" value="${settings.cardPrice || 0}" style="width:80px" type="number"/>
        <button>Save Settings</button>
      </form>
    </div>
    <h3>👥 Users Control Panel</h3>
    <table>
      <tr><th>Number</th><th>Name</th><th>Balance</th><th>Active</th><th>Total Successful Cards</th><th>Last Used</th><th>Actions</th></tr>
      ${rows}
    </table>
    <h3>📜 ভিউ রিসেন্ট গ্লোবাল হিস্ট্রি (ডাটাবেজ লগ)</h3>
    <p><a href="/admin/history" style="color:#0078d4;font-weight:bold;">👉 এখানে ক্লিক করে সমস্ত ইউজারদের সার্চ হিস্ট্রি রিপোর্ট দেখুন</a></p>
  </body></html>`);
});

// আলাদা গ্লোবাল হিস্ট্রি দেখার অ্যান্ডপয়েন্ট
app.get("/admin/history", adminAuth, async (req, res) => {
  const history = await historyColl.find({}).sort({ timestamp: -1 }).limit(100).toArray();
  const rows = history.map(h => `
    <tr>
      <td>${h.timestamp.toLocaleString()}</td>
      <td>${h.number}</td>
      <td>${h.nid}</td>
      <td>${h.dob}</td>
      <td style="color:${h.status === 'success' ? 'green' : 'red'};font-weight:bold">${h.status.toUpperCase()}</td>
      <td>${h.charge} ৳</td>
      <td>${h.balanceAfterCut} ৳</td>
      <td><i>${h.remarks}</i></td>
    </tr>
  `).join("");

  res.send(`<html><body>
    <h2>📜 ইউজার সার্চ ও ব্যালেন্স কাটার ডিটেইলড হিস্ট্রি (সর্বশেষ ১০০টি অ্যাক্টিভিটি)</h2>
    <table border="1" style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;" cellpadding="8">
      <tr style="background:#333;color:#fff"><th>সময়</th><th>হোয়াটসঅ্যাপ নম্বর</th><th>NID নম্বর</th><th>জন্মতারিখ</th><th>স্ট্যাটাস</th><th>কাটা হয়েছে</th><th>অবশিষ্ট ব্যালেন্স</th><th>মন্তব্য/সার্ভার মেসেজ</th></tr>
      ${rows}
    </table>
    <br><a href="/admin">🔙 ড্যাশবোর্ডে ফিরে যান</a>
  </body></html>`);
});

app.post("/admin/recharge", adminAuth, async (req, res) => {
  const { number, amount } = req.body;
  const amt = parseFloat(amount) || 0;
  if (amt > 0) {
    await usersColl.updateOne(
      { number: normalizeNumber(number) },
      { $inc: { balance: amt }, $setOnInsert: { name: "User", active: true } },
      { upsert: true }
    );
  }
  res.redirect("/admin");
});

app.post("/admin/settings", adminAuth, async (req, res) => {
  const price = parseFloat(req.body.cardPrice) || 0;
  await settingsColl.updateOne({ _id: "bot_settings" }, { $set: { cardPrice: price } }, { upsert: true });
  res.redirect("/admin");
});

// ========== SYSTEM STARTUP ==========
(async () => {
  await connectMongoDB();
  await loginToPhpSite(); // বট স্টার্ট হওয়ার সাথে সাথে সাইটে ১ বার ব্যাকগ্রাউন্ড লগইন করবে
  
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Engine with Strict Rules listening on port ${CONFIG.PORT}`);
  });
})();
