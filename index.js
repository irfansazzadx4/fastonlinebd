/**
 * NID Service Bot - WhatsApp Cloud API Version
 * Optimized with External Puppeteer Rendering Service & MongoDB History
 */

require('dotenv').config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");
const { MongoClient } = require("mongodb");

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  // WhatsApp Cloud API Configuration
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION: "v21.0",

  // আপনার মেইন ওয়েবসাইটের ক্রেডেনশিয়ালস
  PHP_SITE_BASE_URL: process.env.PHP_SITE_BASE_URL || "https://my-gov-bd.site",
  PHP_BOT_EMAIL: "irfanbot@gmail.com",
  PHP_BOT_PASS: "p@@ss: irfan2002",

  // 🌐 আপনার এক্সটার্নাল Railway Puppeteer সার্ভার ইউআরএল
  EXTERNAL_PUPPETEER_URL: "https://pupeeter-production-2b39.up.railway.app/pdf",

  // MongoDB Connection String
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://sazzadpc4_db_user:Xr53oHTfLujIKDlw@cluster0.mongodb.net/?retryWrites=true&w=majority",
};

// Global DB Instances
let db, usersColl, statsColl, settingsColl, historyColl;
let phpSessionCookies = ""; // সাইটের লাইভ সেশন কুকি জমা রাখার ভ্যারিয়েবল

// ========== MONGODB CONNECTION SETUP ==========
async function connectMongoDB() {
  try {
    const client = new MongoClient(CONFIG.MONGO_URI);
    await client.connect();
    db = client.db("nid_whatsapp_bot");
    
    usersColl = db.collection("users");
    statsColl = db.collection("stats");
    settingsColl = db.collection("settings");
    historyColl = db.collection("history"); // ইউজারদের আলাদা কাজের হিস্ট্রি ট্র্যাকিং কালেকশন

    console.log("✅ MongoDB Database Connected Successfully.");
    
    // ডিফল্ট সেটিং তৈরি (যদি ডাটাবেজে না থাকে)
    const settings = await settingsColl.findOne({ _id: "bot_settings" });
    if (!settings) {
      await settingsColl.insertOne({ _id: "bot_settings", cardPrice: 10 }); // ডিফল্ট কার্ড প্রাইস ১০ টাকা
    }
  } catch (e) {
    console.error("❌ MongoDB Connection Failed!", e.message);
    process.exit(1);
  }
}

// ========== AUTOMATED WEBSITE SESSION LOGIN ==========
async function loginToPhpSite() {
  try {
    console.log("🔐 Website-এ লগইন সেশন তৈরি করার চেষ্টা করা হচ্ছে...");
    const params = new URLSearchParams();
    params.append("email", CONFIG.PHP_BOT_EMAIL); 
    params.append("password", CONFIG.PHP_BOT_PASS);
    params.append("login", "submit"); 

    const response = await axios.post(`${CONFIG.PHP_SITE_BASE_URL}/index.php`, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0, 
      validateStatus: (status) => status >= 200 && status < 400
    });

    // রেসপন্স হেডার থেকে কুকি ডেটা ফিল্টার করা
    const cookies = response.headers["set-cookie"];
    if (cookies && cookies.length > 0) {
      phpSessionCookies = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল! নতুন সেশন কুকি অ্যাক্টিভ হয়েছে:", phpSessionCookies);
      return true;
    }
    
    if (response.headers && response.headers["set-cookie"]) {
       phpSessionCookies = response.headers["set-cookie"].map(c => c.split(";")[0]).join("; ");
       return true;
    }
    return false;
  } catch (error) {
    if (error.response && error.response.headers["set-cookie"]) {
      phpSessionCookies = error.response.headers["set-cookie"].map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল (Session Cookie Captured via 302 Redirect).");
      return true;
    }
    console.error("❌ ওয়েবসাইট লগইন এপিআই ব্যর্থ হয়েছে:", error.message);
    return false;
  }
}

// ========== STRICT USER CONTROL & DETAILS LOGGING ==========
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

// ইউজারদের প্রতিটি কাজের আলাদা আলাদা হিস্ট্রি রাখার মূল ফাংশন
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

// ========== WEB AUTOMATION (SERVER SEARCH & EXTERNAL RENDER) ==========

// ১. সাইটের insert_un_server_24.php ফাইলে ডেটা পাঠানো ও এরর চেক করা
async function searchNIDOnServer(nid, dob) {
  try {
    if (!phpSessionCookies) {
      await loginToPhpSite(); 
    }

    const params = new URLSearchParams();
    params.append("nid", nid);
    params.append("dob", dob);

    const response = await axios.post(`${CONFIG.PHP_SITE_BASE_URL}/insert_un_server_24.php`, params.toString(), {
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": phpSessionCookies 
      },
      timeout: 50000
    });

    return response.data;
  } catch (error) {
    console.error("Axios Web Search Error:", error.message);
    if (error.response && (error.response.status === 401 || error.response.status === 302)) {
      console.log("🔄 সেশন এক্সপায়ার হয়েছে। রি-লগইন করা হচ্ছে...");
      const loginOk = await loginToPhpSite();
      if (loginOk) return await searchNIDOnServer(nid, dob); 
    }
    return { status: "error", message: "ওয়েবসাইট ব্যাকএন্ড সার্ভারে কানেক্ট করা যাচ্ছে না।" };
  }
}

// 🌐 ২. আপনার এক্সটার্নাল Railway Puppeteer সার্ভারে রিকোয়েস্ট পাঠানোর সম্পূর্ণ নতুন ফাংশন
async function renderNIDViaExternalService(nid, dob) {
  const targetUrl = `${CONFIG.PHP_SITE_BASE_URL}/server_download_v2_24.php?nid=${nid}&id=${dob}`;
  console.log(`📡 External Puppeteer-এ রিকোয়েস্ট পাঠানো হচ্ছে: ${targetUrl}`);

  try {
    // এক্সটার্নাল Puppeteer API যে ফরম্যাটে ডেটা নেয় (টপিক্যালি URL এবং Cookies পে-লোড)
    const response = await axios.post(CONFIG.EXTERNAL_PUPPETEER_URL, {
      url: targetUrl,
      cookies: phpSessionCookies, // সেশন কুকি পাস করা হচ্ছে যাতে এক্সটার্নাল রেন্ডারার ফাইলটি রিড করতে পারে
      options: {
        format: "A4",
        printBackground: true
      }
    }, {
      responseType: "arraybuffer", // PDF বাইনারি ডেটা বাফার হিসেবে রিসিভ করার জন্য
      timeout: 60000
    });

    return Buffer.from(response.data);
  } catch (error) {
    console.error("❌ External Puppeteer Renderer Server Error:", error.message);
    throw new Error("এক্সটার্নাল পিডিএফ রেন্ডারিং ইঞ্জিন সাড়া দিচ্ছে না বা ডাউন আছে।");
  }
}

// ========== WHATSAPP MESSAGES MAIN CONTROLLER ==========
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

    // RegEx Filter
    const nidRegex = /(\d{10}|\d{17})/;
    const dobRegex = /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/;

    const hasNid = text.match(nidRegex);
    const hasDob = text.match(dobRegex);

    if (hasNid && hasDob) {
      if (!(await isAllowed(from))) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");

      const price = await getCardPrice();
      const currentBalance = await getUserBalance(from);

      // 🛡️ কঠোর স্তর ১: বটের ডাটাবেজে পর্যাপ্ত টাকা না থাকলে রিকোয়েস্ট ব্লক
      if (price > 0 && currentBalance < price) {
        await logToHistory(from, hasNid[0], hasDob[0], "failed", 0, currentBalance, "Insufficient Bot Balance Locked");
        return sendText(from, `❌ আপনার বটের ব্যালেন্স কম! একটি কার্ডের জন্য মিনিমাম ${price} টাকা প্রয়োজন।\nআপনার বর্তমান ব্যালেন্স: ${currentBalance} টাকা।`);
      }

      const nid = hasNid[0];
      const dob = hasDob[0];

      await sendText(from, `🔍 NID: ${nid} সার্ভারে খোঁজা হচ্ছে... অনুগ্রহ করে একটু অপেক্ষা করুন।`);

      try {
        // ধাপ ১: আপনার পিএইচপি মেইন ফাইলে ডেটা সার্চ
        const searchResult = await searchNIDOnServer(nid, dob);
        const result = typeof searchResult === "string" ? JSON.parse(searchResult) : searchResult;

        // 🛑 কঠোর স্তর ২: আপনার ওয়েবসাইট সার্ভার থেকে যেকোনো প্রকারের এরর মেসেজ আসলে তা চেক করা
        if (result.status === "error" || result.status === "failed") {
          const errMsg = result.message || "কোনো তথ্য পাওয়া যায়নি বা সার্ভার ব্যালেন্স শেষ।";
          
          // ব্যর্থতার রেকর্ড আলাদা ইউজার হিস্ট্রিতে স্টোর
          await logToHistory(from, nid, dob, "failed", 0, currentBalance, `Server Error Response: ${errMsg}`);
          
          // এক্সটার্নাল ইঞ্জিনে না পাঠিয়ে সরাসরি এই এরর মেসেজটি ইউজারকে সেন্ড করে স্টপ করা হবে
          return sendText(from, `❌ ওয়েবসাইট সার্ভার থেকে এরর মেসেজ এসেছে:\n\n"${errMsg}"\n\n[অনুরোধটি বাতিল করা হয়েছে, কোনো ব্যালেন্স কাটা হয়নি]`);
        }

        // ধাপ ২: সার্চ সফল হলেই কেবল এক্সটার্নাল রেলওয়ে সার্ভিস থেকে PDF জেনারেট করা হবে
        await sendText(from, `📥 তথ্য সফলভাবে পাওয়া গেছে! এক্সটার্নাল ইঞ্জিন থেকে পিডিএফ (PDF) কপি জেনারেট হচ্ছে...`);
        const pdfBuffer = await renderNIDViaExternalService(nid, dob);

        // 💳 সফলভাবে জেনারেট হওয়ার পর বটের কঠোর ব্যালেন্স কাট
        const finalBalance = currentBalance - price;
        await usersColl.updateOne({ number: normalizeNumber(from) }, { $set: { balance: finalBalance } });

        // সফল কাজের ডেটা হিস্ট্রি কালেকশনে ইনসার্ট
        await logToHistory(from, nid, dob, "success", price, finalBalance, "Successfully generated via External Railway Server");

        // কাউন্টার আপডেট
        await statsColl.updateOne(
          { _id: normalizeNumber(from) },
          { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
          { upsert: true }
        );

        const filename = `nid-${nid}.pdf`;
        const caption  = `✅ আপনার NID সার্ভার কপি তৈরি হয়েছে!\n\n🆔 NID: ${nid}\n🎂 DOB: ${dob}\n${price > 0 ? `💰 Remaining Balance: ${finalBalance} টাকা` : ""}`;

        // হোয়াটসঅ্যাপে ডেলিভারি
        const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");
        await sendDocument(from, mediaId, filename, caption);

      } catch (err) {
        console.error("Main Handler Flow Error:", err.message);
        await logToHistory(from, nid, dob, "failed", 0, currentBalance, `System Crash Error: ${err.message}`);
        await sendText(from, `❌ ইন্টারনাল প্রসেসিং ক্রাশ! অনুগ্রহ করে আবার চেষ্টা করুন।\nError: ${err.message}`);
      }
      return;
    }

    if (hasNid && !hasDob) {
      return sendText(from, "⚠️ আপনি জন্মতারিখ (DOB) দেননি। অনুগ্রহ করে NID এবং জন্মতারিখ স্পেস দিয়ে একসাথে লিখে পাঠান। (যেমন: 1234567890 1995-12-25)");
    }

    return sendText(from, "📄 NID সার্ভার কপি বের করতে NID নম্বর এবং জন্মতারিখ একসাথে লিখে পাঠান।\n\nউদাহরণ:\n1234567890 1995-12-25\n\nCommands:\n.ping - bot check\n.status - balance check");
  }
}

// ========== EXPRESS SERVER METHOD ==========
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

app.get("/", (req, res) => res.send("✅ NID Server MongoDB Live Automation Bot is active."));

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
  res.send("❌ Password মেলেনি! <a href='/admin/login'>আবার চেষ্টা করুন</a>");
});

app.get("/admin", adminAuth, async (req, res) => {
  const users = await usersColl.find({}).toArray();
  const settings = await settingsColl.findOne({ _id: "bot_settings" });
  
  let rows = "";
  for (const u of users) {
    const s = await statsColl.findOne({ _id: normalizeNumber(u.number) }) || { count: 0, lastUsed: "—" };
    rows += `<tr>
      <td>${u.number}</td>
      <td>${u.name || "User"}</td>
      <td style="color:green;font-weight:bold">${u.balance || 0} ৳</td>
      <td>${u.active !== false ? "✅ Active" : "❌ Blocked"}</td>
      <td>${s.count} টি</td>
      <td style="font-size:11px">${s.lastUsed ? s.lastUsed.toLocaleString() : "—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline;">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="টাকা" type="number" style="width:70px;padding:3px" required/>
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
    <h1>📊 NID Bot Admin Console (External Puppeteer Linked)</h1>
    <div class="card">
      <h3>⚙️ Global Settings</h3>
      <form method="POST" action="/admin/settings">
        प्रत्येक Card এর দাম (৳): <input name="cardPrice" value="${settings.cardPrice || 0}" style="width:80px" type="number"/>
        <button>Save Global Rate</button>
      </form>
    </div>
    <h3>👥 Active Users List</h3>
    <table>
      <tr><th>WhatsApp Number</th><th>Name</th><th>Wallet Balance</th><th>Status</th><th>Total Cards Printed</th><th>Last Activity</th><th>Recharge Wallet</th></tr>
      ${rows}
    </table>
    <h3>📜 ইউজারদের আলাদা আলাদা বিস্তারিত কাজের লগ (User History Report)</h3>
    <p><a href="/admin/history" style="color:#0078d4;font-weight:bold;text-decoration:underline;">👉 এখানে ক্লিক করে প্রতিটি সার্চ রিকোয়েস্ট এবং ব্যালেন্স কাটার লাইভ হিস্ট্রি দেখুন</a></p>
  </body></html>`);
});

// আলাদা প্রতিটি ইউজারের কাজের হিস্ট্রি দেখার ড্যাশবোর্ড
app.get("/admin/history", adminAuth, async (req, res) => {
  const history = await historyColl.find({}).sort({ timestamp: -1 }).limit(150).toArray();
  const rows = history.map(h => `
    <tr>
      <td>${h.timestamp ? h.timestamp.toLocaleString() : "—"}</td>
      <td>${h.number}</td>
      <td>${h.nid}</td>
      <td>${h.dob}</td>
      <td style="color:${h.status === 'success' ? 'green' : 'red'};font-weight:bold">${h.status.toUpperCase()}</td>
      <td>${h.charge} ৳</td>
      <td>${h.balanceAfterCut} ৳</td>
      <td><i>${h.remarks}</i></td>
    </tr>
  `).join("");

  res.send(`<html><head><style>
    body{font-family:sans-serif;max-width:1300px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#222;color:#fff}
  </style></head><body>
    <h2>📜 প্রতিটি ইউজারের আলাদা কাজের হিস্ট্রি লগ রিপোর্ট (সর্বশেষ ১৫০টি অ্যাক্টিভিটি)</h2>
    <table>
      <tr><th>সময়</th><th>হোয়াটসঅ্যাপ নম্বর</th><th>NID নম্বর</th><th>জন্মতারিখ (DOB)</th><th>স্ট্যাটাস</th><th>চার্জ</th><th>অবशिष्ट ব্যালেন্স</th><th>মন্তব্য/সার্ভার রেসপন্স মেসেজ</th></tr>
      ${rows}
    </table>
    <br><a href="/admin" style="color:#0078d4; font-weight:bold;">🔙 মূল অ্যাডমিন ড্যাশবোর্ডে ফিরে যান</a>
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

// ========== SYSTEM STARTUP ENGINE ==========
(async () => {
  await connectMongoDB();
  await loginToPhpSite(); // সার্ভার রান হওয়া মাত্রই ব্যাকগ্রাউন্ড কুকি জেনারেট করে রাখবে
  
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Automated NID Bot linked to Railway Puppeteer on port ${CONFIG.PORT}`);
  });
})();
