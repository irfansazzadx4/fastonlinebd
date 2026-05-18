/**
 * NID Service Bot - WhatsApp Cloud API Version
 * [FULLY FIXED + USER MANAGEMENT SYSTEM]
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
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION: "v21.0",
  PHP_SITE_BASE_URL: process.env.PHP_SITE_BASE_URL || "https://my-gov-bd.site",
  PHP_BOT_EMAIL: process.env.PHP_BOT_EMAIL || "irfanbot@gmail.com",
  PHP_BOT_PASS: process.env.PHP_BOT_PASS || "p@@ss: irfan2002",
  EXTERNAL_PUPPETEER_URL: process.env.EXTERNAL_PUPPETEER_URL || "https://pupeeter-production-2b39.up.railway.app/pdf",
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://sazzadpc4_db_user:Xr53oHTfLujIKDlw@cluster0.agynr2o.mongodb.net/nid_whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0",
};

// ========== GLOBAL VARS ==========
let db, usersColl, statsColl, settingsColl, historyColl;
let phpSessionCookies = "";

// ========== FIX: WA helpers as FUNCTIONS (not constants) ==========
// আগের ভার্সনে WA_BASE কনস্ট্যান্ট ছিল, তাই PHONE_ID লোড হওয়ার আগেই
// খালি স্ট্রিং দিয়ে সেট হয়ে যেত — এটাই reply না আসার মূল কারণ ছিল।
function getWaBase() {
  return `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
}
function getWaHeaders() {
  return { Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" };
}

// ========== MONGODB ==========
async function connectMongoDB() {
  try {
    const client = new MongoClient(CONFIG.MONGO_URI);
    await client.connect();
    db = client.db("nid_whatsapp_bot");
    usersColl    = db.collection("users");
    statsColl    = db.collection("stats");
    settingsColl = db.collection("settings");
    historyColl  = db.collection("history");
    console.log("✅ MongoDB Connected.");
    const settings = await settingsColl.findOne({ _id: "bot_settings" });
    if (!settings) await settingsColl.insertOne({ _id: "bot_settings", cardPrice: 10 });
  } catch (e) {
    console.error("❌ MongoDB Failed:", e.message);
    process.exit(1);
  }
}

// ========== PHP SITE LOGIN ==========
async function loginToPhpSite() {
  try {
    console.log("🔐 PHP সাইটে লগইন করা হচ্ছে...");
    const params = new URLSearchParams();
    params.append("email",    CONFIG.PHP_BOT_EMAIL);
    params.append("password", CONFIG.PHP_BOT_PASS);
    params.append("login",    "submit");

    const response = await axios.post(`${CONFIG.PHP_SITE_BASE_URL}/index.php`, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const cookies = response.headers["set-cookie"];
    if (cookies?.length > 0) {
      phpSessionCookies = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল। কুকি:", phpSessionCookies);
      return true;
    }
    return false;
  } catch (error) {
    if (error.response?.headers["set-cookie"]) {
      phpSessionCookies = error.response.headers["set-cookie"].map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল (302 Redirect থেকে কুকি ক্যাপচার)।");
      return true;
    }
    console.error("❌ লগইন ব্যর্থ:", error.message);
    return false;
  }
}

// ========== USER HELPERS ==========
function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0"))                    n = "880" + n.slice(1);
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
  const s = await settingsColl.findOne({ _id: "bot_settings" });
  return s ? s.cardPrice : 0;
}

async function logToHistory(number, nid, dob, status, charge, balanceAfter, remarks) {
  await historyColl.insertOne({
    number: normalizeNumber(number), nid, dob, status,
    charge, balanceAfterCut: balanceAfter, remarks, timestamp: new Date(),
  });
}

// ========== WHATSAPP API WRAPPERS ==========
async function sendText(to, body) {
  try {
    await axios.post(`${getWaBase()}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body },
    }, { headers: getWaHeaders() });
    console.log(`📤 Sent to ${to}`);
  } catch (e) {
    console.error("❌ sendText error:", e.response?.data || e.message);
  }
}

async function markRead(messageId) {
  try {
    await axios.post(`${getWaBase()}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: messageId,
    }, { headers: getWaHeaders() });
  } catch {}
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${getWaBase()}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${getWaBase()}/messages`, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename, caption },
    }, { headers: getWaHeaders() });
  } catch (e) {
    console.error("sendDocument error:", e.response?.data || e.message);
  }
}

// ========== NID SEARCH & PDF RENDER ==========
async function searchNIDOnServer(nid, dob) {
  try {
    if (!phpSessionCookies) await loginToPhpSite();

    const params = new URLSearchParams();
    params.append("nid", nid);
    params.append("dob", dob);

    const response = await axios.post(
      `${CONFIG.PHP_SITE_BASE_URL}/insert_un_server_24.php`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: phpSessionCookies,
        },
        timeout: 50000,
      }
    );
    return response.data;
  } catch (error) {
    console.error("Search Error:", error.message);
    if (error.response && (error.response.status === 401 || error.response.status === 302)) {
      console.log("🔄 সেশন শেষ, রি-লগইন...");
      const ok = await loginToPhpSite();
      if (ok) return await searchNIDOnServer(nid, dob);
    }
    return { status: "error", message: "ওয়েবসাইট ব্যাকএন্ডে কানেক্ট করা যাচ্ছে না।" };
  }
}

async function renderNIDViaExternalService(nid, dob) {
  const targetUrl = `${CONFIG.PHP_SITE_BASE_URL}/server_download_v2_24.php?nid=${nid}&id=${dob}`;
  console.log(`📡 External Puppeteer request: ${targetUrl}`);
  try {
    const response = await axios.post(
      CONFIG.EXTERNAL_PUPPETEER_URL,
      { url: targetUrl, cookies: phpSessionCookies, options: { format: "A4", printBackground: true } },
      { responseType: "arraybuffer", timeout: 60000 }
    );
    return Buffer.from(response.data);
  } catch (error) {
    console.error("❌ Puppeteer Error:", error.message);
    throw new Error("এক্সটার্নাল PDF ইঞ্জিন সাড়া দিচ্ছে না।");
  }
}

// ========== MAIN MESSAGE HANDLER ==========
async function handleIncoming(msg) {
  const from  = msg.from;
  const msgId = msg.id;
  markRead(msgId);

  if (msg.type !== "text") return;

  const text      = msg.text.body.trim();
  const lowerText = text.toLowerCase();

  console.log(`📩 [${from}]: "${text}"`);

  // ---- Simple commands ----
  if (lowerText === "ping" || lowerText === ".ping")
    return sendText(from, "🟢 Pong! Bot সচল আছে।");

  if (lowerText === "status" || lowerText === ".status") {
    if (!(await isAllowed(from)))
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    const bal   = await getUserBalance(from);
    const price = await getCardPrice();
    return sendText(from, `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
  }

  // ---- NID + DOB detection ----
  const nidRegex = /(\d{10}|\d{17})/;
  const dobRegex = /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/;
  const hasNid   = text.match(nidRegex);
  const hasDob   = text.match(dobRegex);

  if (hasNid && !hasDob)
    return sendText(from, "⚠️ জন্মতারিখ (DOB) দেননি!\n\nউদাহরণ: 1234567890 1995-12-25");

  if (hasNid && hasDob) {
    if (!(await isAllowed(from)))
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");

    const price          = await getCardPrice();
    const currentBalance = await getUserBalance(from);
    const nid            = hasNid[0];
    const dob            = hasDob[0];

    if (price > 0 && currentBalance < price) {
      await logToHistory(from, nid, dob, "failed", 0, currentBalance, "Insufficient Balance");
      return sendText(from, `❌ ব্যালেন্স কম!\n\nপ্রয়োজন: ${price} টাকা\nআপনার ব্যালেন্স: ${currentBalance} টাকা`);
    }

    await sendText(from, `🔍 NID: ${nid} সার্ভারে খোঁজা হচ্ছে... একটু অপেক্ষা করুন।`);

    try {
      const searchResult = await searchNIDOnServer(nid, dob);
      let result;
try {
  result = typeof searchResult === "string" ? JSON.parse(searchResult) : searchResult;
} catch (parseErr) {
  // HTML response এসেছে — session expired, re-login করুন
  console.log("⚠️ HTML response এসেছে, re-login করা হচ্ছে...");
  await loginToPhpSite();
  const retryResult = await searchNIDOnServer(nid, dob);
  try {
    result = typeof retryResult === "string" ? JSON.parse(retryResult) : retryResult;
  } catch (e) {
    await logToHistory(from, nid, dob, "failed", 0, currentBalance, "HTML Response after re-login");
    return sendText(from, "❌ সার্ভার HTML response দিচ্ছে। PHP সাইট সমস্যায় আছে।");
  }
}
      if (result.status === "error" || result.status === "failed") {
        const errMsg = result.message || "তথ্য পাওয়া যায়নি বা সার্ভার ব্যালেন্স শেষ।";
        await logToHistory(from, nid, dob, "failed", 0, currentBalance, `Server Error: ${errMsg}`);
        return sendText(from, `❌ সার্ভার এরর:\n\n"${errMsg}"\n\n[ব্যালেন্স কাটা হয়নি]`);
      }

      await sendText(from, `📥 তথ্য পাওয়া গেছে! PDF তৈরি হচ্ছে...`);
      const pdfBuffer = await renderNIDViaExternalService(nid, dob);

      const finalBalance = currentBalance - price;
      await usersColl.updateOne(
        { number: normalizeNumber(from) },
        { $set: { balance: finalBalance } }
      );

      await logToHistory(from, nid, dob, "success", price, finalBalance, "Generated via External Railway Puppeteer");
      await statsColl.updateOne(
        { _id: normalizeNumber(from) },
        { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
        { upsert: true }
      );

      const filename = `nid-${nid}.pdf`;
      const caption  = `✅ NID সার্ভার কপি তৈরি হয়েছে!\n\n🆔 NID: ${nid}\n🎂 DOB: ${dob}${price > 0 ? `\n💰 বাকি ব্যালেন্স: ${finalBalance} টাকা` : ""}`;
      const mediaId  = await uploadMedia(pdfBuffer, filename, "application/pdf");
      await sendDocument(from, mediaId, filename, caption);

    } catch (err) {
      console.error("Flow Error:", err.message);
      await logToHistory(from, nid, dob, "failed", 0, currentBalance, `Crash: ${err.message}`);
      await sendText(from, `❌ প্রসেসিং এরর! আবার চেষ্টা করুন।\n${err.message}`);
    }
    return;
  }

  return sendText(from, "📄 NID সার্ভার কপি পেতে NID নম্বর এবং জন্মতারিখ একসাথে পাঠান।\n\nউদাহরণ:\n1234567890 1995-12-25\n\nCommands:\n.ping - bot check\n.status - balance check");
}

// ========== EXPRESS ==========
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Webhook verify
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook receive
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");
  try {
    const change = req.body.entry?.[0]?.changes?.[0]?.value;
    if (change?.messages?.length > 0) {
      for (const msg of change.messages) await handleIncoming(msg);
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

app.get("/", (req, res) => res.send("✅ NID Bot Active."));

// ========== ADMIN AUTH ==========
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

// ---- Admin CSS helper ----
const adminCSS = `
  <style>
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',sans-serif;max-width:1300px;margin:30px auto;padding:20px;background:#f0f2f5}
    h1,h2,h3{color:#1a1a2e}
    .card{background:#fff;padding:20px;margin:15px 0;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    table{width:100%;border-collapse:collapse;margin:10px 0}
    th,td{border:1px solid #ddd;padding:10px 12px;text-align:left;font-size:13px}
    th{background:#1a73e8;color:#fff}
    tr:nth-child(even){background:#f9f9f9}
    .btn{display:inline-block;padding:6px 12px;border:0;border-radius:5px;cursor:pointer;font-size:13px;color:#fff}
    .btn-green{background:#28a745}.btn-red{background:#dc3545}.btn-blue{background:#1a73e8}.btn-orange{background:#fd7e14}
    input[type=text],input[type=number],input[type=password]{padding:8px 10px;border:1px solid #ccc;border-radius:5px;font-size:13px}
    .badge-active{color:#28a745;font-weight:bold}.badge-blocked{color:#dc3545;font-weight:bold}
    nav{margin-bottom:20px}
    nav a{margin-right:15px;color:#1a73e8;text-decoration:none;font-weight:bold}
    .alert{padding:12px 18px;border-radius:6px;margin:10px 0}
    .alert-success{background:#d4edda;color:#155724}.alert-danger{background:#f8d7da;color:#721c24}
  </style>
`;

// ---- Login ----
app.get("/admin/login", (req, res) => {
  res.send(`<html><head>${adminCSS}<title>Admin Login</title></head>
  <body style="max-width:420px">
    <div class="card" style="margin-top:100px">
      <h2>🔐 NID Bot Admin Login</h2>
      <form method="POST" action="/admin/login">
        <input type="password" name="password" placeholder="Admin Password" style="width:100%;margin:10px 0" required/>
        <button class="btn btn-blue" style="width:100%;padding:10px">Login</button>
      </form>
    </div>
  </body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const tok = crypto.randomBytes(16).toString("hex");
    adminSessions.add(tok);
    res.setHeader("Set-Cookie", `admin_sess=${tok}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/admin");
  }
  res.send(`<html><head>${adminCSS}</head><body><div class="card alert alert-danger">❌ ভুল Password! <a href="/admin/login">আবার চেষ্টা করুন</a></div></body></html>`);
});

// ---- Admin Navbar ----
const adminNav = `
  <nav>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/users">👥 Users</a>
    <a href="/admin/add-user">➕ Add User</a>
    <a href="/admin/history">📜 History</a>
    <a href="/admin/settings">⚙️ Settings</a>
  </nav>
`;

// ---- Dashboard ----
app.get("/admin", adminAuth, async (req, res) => {
  const totalUsers   = await usersColl.countDocuments({});
  const activeUsers  = await usersColl.countDocuments({ active: { $ne: false } });
  const totalSuccess = await historyColl.countDocuments({ status: "success" });
  const totalFailed  = await historyColl.countDocuments({ status: "failed" });
  const settings     = await settingsColl.findOne({ _id: "bot_settings" });

  res.send(`<html><head>${adminCSS}<title>Admin Dashboard</title></head><body>
    <h1>📊 NID Bot Admin Dashboard</h1>
    ${adminNav}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:20px 0">
      <div class="card" style="text-align:center"><h3>${totalUsers}</h3><p>মোট ইউজার</p></div>
      <div class="card" style="text-align:center"><h3 style="color:green">${activeUsers}</h3><p>Active ইউজার</p></div>
      <div class="card" style="text-align:center"><h3 style="color:green">${totalSuccess}</h3><p>সফল রিকোয়েস্ট</p></div>
      <div class="card" style="text-align:center"><h3 style="color:red">${totalFailed}</h3><p>ব্যর্থ রিকোয়েস্ট</p></div>
    </div>
    <div class="card">
      <b>💳 বর্তমান Card Price: ${settings?.cardPrice || 0} টাকা</b>
      — <a href="/admin/settings">পরিবর্তন করুন</a>
    </div>
  </body></html>`);
});

// ---- Users List ----
app.get("/admin/users", adminAuth, async (req, res) => {
  const users = await usersColl.find({}).toArray();
  const msg   = req.query.msg || "";

  let rows = "";
  for (const u of users) {
    const s = await statsColl.findOne({ _id: normalizeNumber(u.number) }) || { count: 0 };
    rows += `<tr>
      <td>${u.number}</td>
      <td>${u.name || "—"}</td>
      <td style="color:green;font-weight:bold">${u.balance || 0} ৳</td>
      <td class="${u.active !== false ? "badge-active" : "badge-blocked"}">${u.active !== false ? "✅ Active" : "❌ Blocked"}</td>
      <td>${s.count}</td>
      <td>
        <!-- Balance Recharge -->
        <form method="POST" action="/admin/balance" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <input type="number" name="amount" placeholder="টাকা" style="width:65px" required/>
          <button name="action" value="add" class="btn btn-green">+Add</button>
          <button name="action" value="deduct" class="btn btn-orange">-Cut</button>
        </form>
        <!-- Block/Unblock -->
        <form method="POST" action="/admin/toggle-user" style="display:inline;margin-left:5px">
          <input type="hidden" name="number" value="${u.number}"/>
          <button class="btn ${u.active !== false ? "btn-red" : "btn-green"}">${u.active !== false ? "Block" : "Unblock"}</button>
        </form>
        <!-- Delete -->
        <form method="POST" action="/admin/delete-user" style="display:inline;margin-left:5px" onsubmit="return confirm('সত্যিই ডিলিট করবেন?')">
          <input type="hidden" name="number" value="${u.number}"/>
          <button class="btn btn-red">🗑 Delete</button>
        </form>
      </td>
    </tr>`;
  }

  res.send(`<html><head>${adminCSS}<title>Users</title></head><body>
    <h1>👥 User Management</h1>
    ${adminNav}
    ${msg ? `<div class="card alert ${msg.includes("✅") ? "alert-success" : "alert-danger"}">${msg}</div>` : ""}
    <div class="card">
      <table>
        <tr><th>WhatsApp Number</th><th>Name</th><th>Balance</th><th>Status</th><th>Total Cards</th><th>Actions</th></tr>
        ${rows || "<tr><td colspan='6' style='text-align:center'>কোনো ইউজার নেই</td></tr>"}
      </table>
    </div>
    <p><a href="/admin/add-user" class="btn btn-blue">➕ নতুন ইউজার যোগ করুন</a></p>
  </body></html>`);
});

// ---- Add User Form ----
app.get("/admin/add-user", adminAuth, async (req, res) => {
  const msg = req.query.msg || "";
  res.send(`<html><head>${adminCSS}<title>Add User</title></head><body>
    <h1>➕ নতুন ইউজার যোগ করুন</h1>
    ${adminNav}
    ${msg ? `<div class="card alert ${msg.includes("✅") ? "alert-success" : "alert-danger"}">${msg}</div>` : ""}
    <div class="card">
      <form method="POST" action="/admin/add-user">
        <table style="max-width:500px">
          <tr><td><b>WhatsApp Number</b></td><td><input type="text" name="number" placeholder="01712345678 বা 8801712345678" style="width:250px" required/></td></tr>
          <tr><td><b>নাম</b></td><td><input type="text" name="name" placeholder="ইউজারের নাম" style="width:250px"/></td></tr>
          <tr><td><b>প্রারম্ভিক Balance</b></td><td><input type="number" name="balance" value="0" style="width:120px"/></td></tr>
        </table>
        <br>
        <button class="btn btn-blue" style="padding:10px 30px">ইউজার যোগ করুন</button>
      </form>
    </div>
  </body></html>`);
});

// ---- Add User POST ----
app.post("/admin/add-user", adminAuth, async (req, res) => {
  const { number, name, balance } = req.body;
  const normalized = normalizeNumber(number);

  if (!normalized || normalized.length < 11)
    return res.redirect("/admin/add-user?msg=❌ Invalid number!");

  const existing = await usersColl.findOne({ number: normalized });
  if (existing)
    return res.redirect(`/admin/add-user?msg=❌ এই নম্বর (${normalized}) ইতোমধ্যে আছে!`);

  await usersColl.insertOne({
    number:    normalized,
    name:      name || "User",
    balance:   parseFloat(balance) || 0,
    active:    true,
    createdAt: new Date(),
  });

  res.redirect(`/admin/users?msg=✅ ইউজার ${normalized} সফলভাবে যোগ করা হয়েছে!`);
});

// ---- Balance Add/Deduct ----
app.post("/admin/balance", adminAuth, async (req, res) => {
  const { number, amount, action } = req.body;
  const amt = parseFloat(amount) || 0;
  if (amt <= 0) return res.redirect("/admin/users?msg=❌ সঠিক পরিমাণ দিন।");

  const user = await usersColl.findOne({ number: normalizeNumber(number) });
  if (!user) return res.redirect("/admin/users?msg=❌ ইউজার পাওয়া যায়নি।");

  if (action === "add") {
    await usersColl.updateOne({ number: normalizeNumber(number) }, { $inc: { balance: amt } });
    res.redirect(`/admin/users?msg=✅ ${normalizeNumber(number)} এর ব্যালেন্সে ${amt}৳ যোগ হয়েছে।`);
  } else if (action === "deduct") {
    const newBal = (user.balance || 0) - amt;
    await usersColl.updateOne({ number: normalizeNumber(number) }, { $set: { balance: Math.max(0, newBal) } });
    res.redirect(`/admin/users?msg=✅ ${normalizeNumber(number)} থেকে ${amt}৳ কাটা হয়েছে।`);
  } else {
    res.redirect("/admin/users");
  }
});

// ---- Block/Unblock ----
app.post("/admin/toggle-user", adminAuth, async (req, res) => {
  const normalized = normalizeNumber(req.body.number);
  const user       = await usersColl.findOne({ number: normalized });
  if (!user) return res.redirect("/admin/users?msg=❌ ইউজার পাওয়া যায়নি।");

  const newStatus = user.active === false ? true : false;
  await usersColl.updateOne({ number: normalized }, { $set: { active: newStatus } });
  res.redirect(`/admin/users?msg=✅ ${normalized} ${newStatus ? "Unblock" : "Block"} করা হয়েছে।`);
});

// ---- Delete User ----
app.post("/admin/delete-user", adminAuth, async (req, res) => {
  const normalized = normalizeNumber(req.body.number);
  await usersColl.deleteOne({ number: normalized });
  await statsColl.deleteOne({ _id: normalized });
  res.redirect(`/admin/users?msg=✅ ${normalized} ডিলিট করা হয়েছে।`);
});

// ---- History ----
app.get("/admin/history", adminAuth, async (req, res) => {
  const filterNum = req.query.number || "";
  const query     = filterNum ? { number: normalizeNumber(filterNum) } : {};
  const history   = await historyColl.find(query).sort({ timestamp: -1 }).limit(200).toArray();

  const rows = history.map(h => `
    <tr>
      <td style="white-space:nowrap">${h.timestamp ? h.timestamp.toLocaleString("bn-BD") : "—"}</td>
      <td>${h.number}</td>
      <td>${h.nid}</td>
      <td>${h.dob}</td>
      <td class="${h.status === "success" ? "badge-active" : "badge-blocked"}">${h.status.toUpperCase()}</td>
      <td>${h.charge} ৳</td>
      <td>${h.balanceAfterCut} ৳</td>
      <td style="font-size:12px"><i>${h.remarks}</i></td>
    </tr>
  `).join("");

  res.send(`<html><head>${adminCSS}<title>History</title></head><body>
    <h1>📜 সার্চ হিস্ট্রি (সর্বশেষ ২০০টি)</h1>
    ${adminNav}
    <div class="card">
      <form method="GET" action="/admin/history" style="display:flex;gap:10px;align-items:center">
        <input type="text" name="number" value="${filterNum}" placeholder="নম্বর দিয়ে ফিল্টার করুন" style="width:220px"/>
        <button class="btn btn-blue">Filter</button>
        ${filterNum ? `<a href="/admin/history" class="btn btn-orange">Clear</a>` : ""}
      </form>
    </div>
    <div class="card">
      <table>
        <tr><th>সময়</th><th>নম্বর</th><th>NID</th><th>DOB</th><th>Status</th><th>চার্জ</th><th>বাকি Balance</th><th>মন্তব্য</th></tr>
        ${rows || "<tr><td colspan='8' style='text-align:center'>কোনো রেকর্ড নেই</td></tr>"}
      </table>
    </div>
  </body></html>`);
});

// ---- Settings ----
app.get("/admin/settings", adminAuth, async (req, res) => {
  const settings = await settingsColl.findOne({ _id: "bot_settings" });
  const msg      = req.query.msg || "";
  res.send(`<html><head>${adminCSS}<title>Settings</title></head><body>
    <h1>⚙️ Bot Settings</h1>
    ${adminNav}
    ${msg ? `<div class="card alert alert-success">${msg}</div>` : ""}
    <div class="card">
      <form method="POST" action="/admin/settings">
        <table style="max-width:400px">
          <tr><td><b>প্রতি Card এর দাম (৳)</b></td>
              <td><input type="number" name="cardPrice" value="${settings?.cardPrice || 0}" style="width:120px"/></td></tr>
        </table>
        <br>
        <button class="btn btn-blue" style="padding:10px 30px">💾 Save Settings</button>
      </form>
    </div>
  </body></html>`);
});

app.post("/admin/settings", adminAuth, async (req, res) => {
  const price = parseFloat(req.body.cardPrice) || 0;
  await settingsColl.updateOne({ _id: "bot_settings" }, { $set: { cardPrice: price } }, { upsert: true });
  res.redirect("/admin/settings?msg=✅ Settings সেভ হয়েছে!");
});

// ---- Logout ----
app.get("/admin/logout", (req, res) => {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess) adminSessions.delete(sess);
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/");
  res.redirect("/admin/login");
});

// ========== STARTUP ==========
(async () => {
  await connectMongoDB();
  await loginToPhpSite();
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
    console.log(`📊 Admin Panel: http://localhost:${CONFIG.PORT}/admin`);
  });
})();
