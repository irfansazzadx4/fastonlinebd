/**
 * NID Service Bot - WhatsApp Cloud API Version
 * [DIRECT API CALL — PHP Session Bypass]
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

  // Direct NID API (PHP সাইটের ভেতরের API)
  NID_API_KEY: process.env.NID_API_KEY || "arthur69",
  NID_API_URL: process.env.NID_API_URL || "https://api.server24x.site/unofficial/api.php",

  // PDF render এর জন্য PHP সাইট (session সহ)
  PHP_SITE_BASE_URL: process.env.PHP_SITE_BASE_URL || "https://my-gov-bd.site",
  PHP_BOT_EMAIL: process.env.PHP_BOT_EMAIL || "irfanbot@gmail.com",
  PHP_BOT_PASS: process.env.PHP_BOT_PASS || "p@@ss: irfan2002",

  EXTERNAL_PUPPETEER_URL: process.env.EXTERNAL_PUPPETEER_URL || "https://pupeeter-production-2b39.up.railway.app/pdf",
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://sazzadpc4_db_user:Xr53oHTfLujIKDlw@cluster0.agynr2o.mongodb.net/nid_whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0",
};

// ========== GLOBAL VARS ==========
let db, usersColl, statsColl, settingsColl, historyColl;
let phpSessionCookies = "";

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
    db           = client.db("nid_whatsapp_bot");
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

// ========== PHP SITE LOGIN (শুধু PDF render এর জন্য) ==========
async function loginToPhpSite() {
  try {
    console.log("🔐 PHP সাইটে লগইন করা হচ্ছে...");
    const params = new URLSearchParams();
    params.append("email",    CONFIG.PHP_BOT_EMAIL);
    params.append("password", CONFIG.PHP_BOT_PASS);
    params.append("login",    "submit");

    const response = await axios.post(
      `${CONFIG.PHP_SITE_BASE_URL}/index.php`,
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
      }
    );

    const cookies = response.headers["set-cookie"];
    if (cookies?.length > 0) {
      phpSessionCookies = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল। কুকি:", phpSessionCookies);
      return true;
    }
    return false;
  } catch (error) {
    if (error.response?.headers["set-cookie"]) {
      phpSessionCookies = error.response.headers["set-cookie"]
        .map(c => c.split(";")[0]).join("; ");
      console.log("✅ লগইন সফল (302 Redirect)।");
      return true;
    }
    console.error("❌ লগইন ব্যর্থ:", error.message);
    return false;
  }
}

// ========== USER HELPERS ==========
function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0"))                       n = "880" + n.slice(1);
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

// ========== WHATSAPP API ==========
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

// ========== DIRECT NID API CALL ==========
// PHP সাইটের session এর ঝামেলা নেই — সরাসরি API call
async function searchNIDDirect(nid, dob) {
  try {
    const url = `${CONFIG.NID_API_URL}?key=${CONFIG.NID_API_KEY}&nid=${nid}&dob=${dob}`;
    console.log(`🔍 Direct API call: ${url}`);

    const response = await axios.get(url, {
      timeout: 50000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const result = response.data;
    console.log("📦 API Raw Response:", JSON.stringify(result).substring(0, 200));
    return result;

  } catch (error) {
    console.error("❌ Direct API Error:", error.message);
    return { status: "error", message: "NID API সার্ভারে কানেক্ট করা যাচ্ছে না।" };
  }
}

// ========== PDF RENDER (Puppeteer) ==========
// ========== OFFICIAL NID TEMPLATE RENDER (BASE64 PUPPETEER) ==========
async function renderPDFFromData(nidData) {
  try {
    // সেফ ডেটা স্ট্রাকচার পার্সিং
    const root = nidData?.data || nidData || {};
    const d = root.data || root;

    // এপিআই রেসপন্স ম্যাপ (সার্ভার কপি ভ্যারিয়েবল)
    const nameEn      = d.nameEn      || "—";
    const nameBn      = d.name        || d.nameBn || "—";
    const nid         = d.nationalId  || d.nid || "—";
    const pin         = d.pin         || "—";
    const dob         = d.dateOfBirth || d.dob || "—";
    const father      = d.father      || "—";
    const mother      = d.mother      || "—";
    const bloodGroup  = d.bloodGroup  || "";
    const gender      = d.gender      || "—";
    const birthPlace  = d.birthPlace  || "—";
    const oldNid      = d.oldNid      || "—";
    const voterArea   = d.voterArea   || d.voter_aria_code || "—";
    const upazilaCode = d.upazilaCode || d.upazila_code || "—";
    const age         = d.age         || d.user_age || "—";
    const birthDay    = d.birthDay    || d.user_birthDay || "—";
    const presentAddr = d.presentAddress  || "—";
    const permAddr    = d.permanentAddress || "—";
    const photo       = d.photo       || "https://placehold.co/120x140?text=No+Photo";

    // অরিজিনাল server_download_v2_24.php ফাইলের হুবহু অফিশিয়াল টেমপ্লেট
    const html = `<!DOCTYPE html>
<html>
<head>
	<title>${nid} - ${nameEn}</title>
	<meta name="viewport" content="initial-scale=1.0, width=device-width"/>
	<meta charSet="utf-8"/>
	<link href="https://fonts.googleapis.com/css2?family=Roboto&display=swap" rel="stylesheet">
	<link href="https://fonts.maateen.me/solaiman-lipi/font.css" rel="stylesheet">
	<style>
		body { margin: 0; padding: 0; background-color: #fff; display: flex; justify-content: center; align-items: center; }
		@media print { html, body { height:100%; margin: 0 !important; padding: 0 !important; overflow: hidden; } }
		[contenteditable]:focus { outline: none; border: none; }
		.background { position: relative; width: 1241px; height: 1755px; background: url('${CONFIG.PHP_SITE_BASE_URL}/assets/images/QR_Unofficial.png') no-repeat; background-size: contain; margin: 0 auto; }
	</style>
</head>
<body oncontextmenu="return false;" style="text-align: center;">
	<div class="background">
		
		<div contenteditable="true" style="position: absolute; left: 30%; top: 8%; width: auto; font-size: 16px; color: rgb(255 224 0); font-family: 'Roboto', sans-serif;"><b>National Identity Registration Wing (NIDW)</b></div>
		<div contenteditable="true" style="position: absolute; left: 37%; top: 11%; width: auto; font-size: 14px; color: rgb(255, 47, 161); font-family: 'Roboto', sans-serif;"><b>Select Your Search Category</b></div>
		<div contenteditable="true" style="position: absolute; left: 45%; top: 12.8%; width: auto; font-size: 12px; color: rgb(8, 121, 4); font-family: 'Roboto', sans-serif;">Search By NID / Voter No.</div>
		<div contenteditable="true" style="position: absolute; left: 45%; top: 14.3%; width: auto; font-size: 12px; color: rgb(7, 119, 184); font-family: 'Roboto', sans-serif;">Search By Form No.</div>
		<div contenteditable="true" style="position: absolute; left: 30%; top: 16.9%; width: auto; font-size: 12px; color: rgb(252, 0, 0); font-family: 'Roboto', sans-serif;"><b>NID or Voter No*</b></div>
		<div contenteditable="true" style="position: absolute; left: 45%; top: 16.9%; width: auto; font-size: 12px; color: rgb(143, 143, 143); font-family: 'Roboto', sans-serif;">${nid}</div>
		<div contenteditable="true" style="position: absolute; left: 62.9%; top: 17.1%; width: auto; font-size: 11px; color: rgb(255 255 255); font-family: 'Roboto', sans-serif;">Submit</div>
		<div contenteditable="true" style="position: absolute; left: 89%; top: 11.55%; width: auto; font-size: 11px; color: #fff; font-family: 'Roboto', sans-serif;">Home</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.5%; top: 27.2%; width: auto; font-size: 16px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"><b>জাতীয় পরিচিতি তথ্য</b></div>
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 30%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">জাতীয় পরিচয় পত্র নম্বর</div>
		<div id="nid_no" contenteditable="true" style="position: absolute; left: 55%; top: 30%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'Roboto', sans-serif;">${nid}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 32.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">পিন নম্বর</div>
		<div id="pin_no" contenteditable="true" style="position: absolute; left: 55%; top: 32.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'Roboto', sans-serif;">${pin}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 35.3%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">পূর্ববর্তী এনআইডি নম্বর</div>
		<div id="old_nid" contenteditable="true" style="position: absolute; left: 55%; top: 35.3%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${oldNid}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 37.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">উপজেলা কোড</div>
		<div id="upazila_code" contenteditable="true" style="position: absolute; left: 55%; top: 37.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${upazilaCode}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 40.5%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">ভোটার এলাকা</div>
		<div id="voter_area" contenteditable="true" style="position: absolute; left: 55%; top: 40.5%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${voterArea}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.5%; top: 43.3%; width: auto; font-size: 16px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"><b>ব্যক্তিগত তথ্য</b></div>
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 46%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">নাম (বাংলা)</div>
		<div id="name_bn" contenteditable="true" style="position: absolute; font-weight: bold; left: 55%; top: 46%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"><b>${nameBn}</b></div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 48.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">নাম (ইংরেজি)</div>
		<div id="name_en" contenteditable="true" style="position: absolute; left: 55%; top:48.8%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'Roboto', sans-serif;">${nameEn}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 51.5%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">জন্ম তারিখ</div>
		<div id="dob" contenteditable="true" style="position: absolute; left: 55%; top: 51.5%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'Roboto', sans-serif;">${dob}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 54.1%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">পিতার নাম</div>
		<div id="fathers_name" contenteditable="true" style="position: absolute; left: 55%; top: 54.1%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${father}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 56.7%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">মাতার নাম</div>
		<div id="mothers_name" contenteditable="true" style="position: absolute; left: 55%; top: 56.7%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${mother}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 59.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">রক্তের গ্রুপ</div>
		<div id="blood_group" contenteditable="true" style="position: absolute; left: 55%; top: 59.2%; width: auto; font-size: 14px; color: red; font-weight: normal; font-family: 'SolaimanLipi', sans-serif;">${bloodGroup}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.5%; top: 62%; width: auto; font-size: 16px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"><b>অন্যান্য তথ্য</b></div>
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 65.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"> বয়স </div>
		<div id="age_val" contenteditable="true" style="position: absolute; left: 55%; top: 65.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${age}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 68%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">লিঙ্গ </div>
		<div id="gender" contenteditable="true" style="position: absolute; left: 55%; top: 68%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'Roboto', sans-serif;">${gender}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 70.7%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">জন্মবার</div>
		<div id="birth_day" contenteditable="true" style="position: absolute; left: 55%; top: 70.7%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${birthDay}</div>
		
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 73.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">জন্মস্থান</div>
		<div id="birth_place" contenteditable="true" style="position: absolute; left: 55%; top: 73.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;">${birthPlace}</div>
		
		<div contenteditable="true" style="font-family: 'SolaimanLipi'; position: absolute; left: 37.5%; top: 75.8%; width: auto; font-size: 16px; color: rgb(7, 7, 7);"><b>বর্তমান ঠিকানা</b></div>
		<div id="present_addr" contenteditable="true" style="font-family: 'SolaimanLipi'; position: absolute; left: 37%; top: 78.2%; width: 48%; font-size: 12.5px; color: rgb(7, 7, 7); text-align: left;">${presentAddr}</div>
		
		<div contenteditable="true" style="font-family: 'SolaimanLipi'; position: absolute; left: 37.5%; top: 84.6%; width: auto; font-size: 16px; color: rgb(7, 7, 7);"><b>স্থায়ী ঠিকানা</b></div>
		<div id="permanent_addr" contenteditable="true" style="font-family: 'SolaimanLipi'; position: absolute; left: 37%; top: 87.3%; width: 48%; font-size: 12.5px; color: rgb(7, 7, 7); text-align: left;">${permAddr}</div>
		
		<div contenteditable="true" style="position: absolute; top: 94%; width: 100%; font-size: 12px; text-align: center; color: rgb(255, 0, 0); font-family: 'SolaimanLipi', sans-serif;">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</div>
		<div contenteditable="true" style="position: absolute; top: 95.5%; width: 100%; text-align: center; font-size: 12px; color: rgb(3, 3, 3); font-family: 'Roboto', sans-serif;">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</div>
		
		<div style="position: absolute; left: 16%; top: 25.7%; width: auto;">
			<img id="photo" src="${photo}" height="140px" width="121px" style="border-radius: 10px; object-fit: cover;" onerror="this.onerror=null; this.src='https://placehold.co/120x140?text=No+Photo'; "/>
		</div>
		
		<div style="position: absolute; left: 18.5%; top: 43%; width: auto;">
			<img id="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&amp;data=${encodeURIComponent(nameEn + " " + nid + " " + dob)}" height="85px" width="85px" />
		</div>
        
		<div id="name_en2" contenteditable="true" style="position: absolute; display: flex; font-weight: bold; left: 15.5%; top: 39.8%; height: 32px; width: 130px; font-size: 13px; color: rgb(7, 7, 7); margin: auto; align-items: center; font-family: 'Roboto', sans-serif;" align="center">
			<div style="flex: 1; text-align: center;">${nameEn}</div>
		</div>
	</div>
</body>
</html>`;

    // ১. আপনার চাহিদা অনুযায়ী পুরো HTML কে Base64 এ কনভার্ট করা হলো
    const base64Html = Buffer.from(html).toString("base64");

    // ২. Puppeteer এপিআই-তে রিকোয়েস্ট পাঠানো
    const response = await axios.post(
      CONFIG.EXTERNAL_PUPPETEER_URL,
      { 
        base64: base64Html, // Base64 স্ট্রিং পাঠানো হচ্ছে
        options: { 
          width: "1241px",    // অরিজিনাল টেমপ্লেটের উইডথ
          height: "1755px",   // অরিজিনাল টেমপ্লেটের হাইট
          printBackground: true 
        } 
      },
      { 
        responseType: "arraybuffer", 
        timeout: 60000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      }
    );
    return Buffer.from(response.data);

  } catch (error) {
    console.error("❌ PDF Render Error:", error.message);
    throw new Error(`PDF তৈরি করা যাচ্ছে না। (Status: ${error.response?.status || 'Unknown'})`);
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

  if (lowerText === "ping" || lowerText === ".ping")
    return sendText(from, "🟢 Pong! Bot সচল আছে।");

  if (lowerText === "status" || lowerText === ".status") {
    if (!(await isAllowed(from)))
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    const bal   = await getUserBalance(from);
    const price = await getCardPrice();
    return sendText(from, `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
  }

  const nidRegex = /(\d{10}|\d{17})/;
  const dobRegex = /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/;
  const hasNid   = text.match(nidRegex);
  const hasDob   = text.match(dobRegex);

  if (hasNid && !hasDob)
    return sendText(from, "⚠️ জন্মতারিখ (DOB) দেননি!\n\nউদাহরণ:\n1234567890 1995-12-25");

  if (hasNid && hasDob) {
    if (!(await isAllowed(from)))
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");

    const price          = await getCardPrice();
    const currentBalance = await getUserBalance(from);
    const nid            = hasNid[0];

    // DOB normalize — DD-MM-YYYY → YYYY-MM-DD
    let dob = hasDob[0];
    const dobParts = dob.split("-");
    if (dobParts[0].length === 2) {
      dob = `${dobParts[2]}-${dobParts[1]}-${dobParts[0]}`;
    }

    if (price > 0 && currentBalance < price) {
      await logToHistory(from, nid, dob, "failed", 0, currentBalance, "Insufficient Balance");
      return sendText(from, `❌ ব্যালেন্স কম!\n\nপ্রয়োজন: ${price} টাকা\nআপনার ব্যালেন্স: ${currentBalance} টাকা`);
    }

    await sendText(from, `🔍 NID: ${nid} খোঁজা হচ্ছে...\nঅনুগ্রহ করে একটু অপেক্ষা করুন।`);

    try {
      // ✅ সরাসরি API call — PHP session এর ঝামেলা নেই
      const result = await searchNIDDirect(nid, dob);

      // API success check (insert_un_server_24.php এর মতো)
      const isSuccess =
        result?.status &&
        result.status.toLowerCase() === "success" &&
        result?.data?.response &&
        result.data.response.toLowerCase() === "success";

      if (!isSuccess) {
        const errMsg = result?.message || result?.data?.message || "তথ্য পাওয়া যায়নি বা NID/DOB ভুল।";
        await logToHistory(from, nid, dob, "failed", 0, currentBalance, `API Error: ${errMsg}`);
        return sendText(from, `❌ তথ্য পাওয়া যায়নি!\n\n"${errMsg}"\n\n[ব্যালেন্স কাটা হয়নি]`);
      }

      const d      = result.data.data;
      const nameEn = d.nameEn || "Unknown";
      const nameBn = d.name   || "";

      await sendText(from, `✅ তথ্য পাওয়া গেছে!\n\n👤 ${nameBn} (${nameEn})\n\n📄 PDF তৈরি হচ্ছে...`);

      const pdfBuffer = await renderPDFFromData(result);

      // Balance কাটা
      const finalBalance = currentBalance - price;
      await usersColl.updateOne(
        { number: normalizeNumber(from) },
        { $set: { balance: finalBalance } }
      );

      await logToHistory(from, nid, dob, "success", price, finalBalance, `Direct API Success: ${nameEn}`);
      await statsColl.updateOne(
        { _id: normalizeNumber(from) },
        { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
        { upsert: true }
      );

      const filename = `nid-${nid}.pdf`;
      const caption  = `✅ NID সার্ভার কপি তৈরি হয়েছে!\n\n🆔 NID: ${nid}\n👤 ${nameBn}\n🎂 DOB: ${dob}${price > 0 ? `\n💰 বাকি ব্যালেন্স: ${finalBalance} টাকা` : ""}`;

      const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");
      await sendDocument(from, mediaId, filename, caption);

    } catch (err) {
      console.error("Flow Error:", err.message);
      await logToHistory(from, nid, dob, "failed", 0, currentBalance, `Crash: ${err.message}`);
      await sendText(from, `❌ প্রসেসিং এরর!\n${err.message}`);
    }
    return;
  }

  return sendText(from,
    "📄 NID সার্ভার কপি পেতে NID নম্বর এবং জন্মতারিখ একসাথে পাঠান।\n\n" +
    "উদাহরণ:\n1234567890 1995-12-25\n\n" +
    "Commands:\n.ping - bot check\n.status - balance check"
  );
}

// ========== EXPRESS ==========
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

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

// ========== ADMIN ==========
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

const adminCSS = `<style>
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
</style>`;

const adminNav = `<nav>
  <a href="/admin">📊 Dashboard</a>
  <a href="/admin/users">👥 Users</a>
  <a href="/admin/add-user">➕ Add User</a>
  <a href="/admin/history">📜 History</a>
  <a href="/admin/settings">⚙️ Settings</a>
  <a href="/admin/logout" style="color:#dc3545">🚪 Logout</a>
</nav>`;

app.get("/admin/login", (req, res) => {
  res.send(`<html><head>${adminCSS}<title>Login</title></head>
  <body style="max-width:420px">
    <div class="card" style="margin-top:100px">
      <h2>🔐 NID Bot Admin</h2>
      <form method="POST" action="/admin/login">
        <input type="password" name="password" placeholder="Password" style="width:100%;margin:10px 0" required/>
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

app.get("/admin", adminAuth, async (req, res) => {
  const totalUsers   = await usersColl.countDocuments({});
  const activeUsers  = await usersColl.countDocuments({ active: { $ne: false } });
  const totalSuccess = await historyColl.countDocuments({ status: "success" });
  const totalFailed  = await historyColl.countDocuments({ status: "failed" });
  const settings     = await settingsColl.findOne({ _id: "bot_settings" });

  res.send(`<html><head>${adminCSS}<title>Dashboard</title></head><body>
    <h1>📊 NID Bot Admin Dashboard</h1>${adminNav}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:20px 0">
      <div class="card" style="text-align:center"><h3>${totalUsers}</h3><p>মোট ইউজার</p></div>
      <div class="card" style="text-align:center"><h3 style="color:green">${activeUsers}</h3><p>Active ইউজার</p></div>
      <div class="card" style="text-align:center"><h3 style="color:green">${totalSuccess}</h3><p>সফল রিকোয়েস্ট</p></div>
      <div class="card" style="text-align:center"><h3 style="color:red">${totalFailed}</h3><p>ব্যর্থ রিকোয়েস্ট</p></div>
    </div>
    <div class="card"><b>💳 Card Price: ${settings?.cardPrice || 0} টাকা</b> — <a href="/admin/settings">পরিবর্তন করুন</a></div>
  </body></html>`);
});

app.get("/admin/users", adminAuth, async (req, res) => {
  const users = await usersColl.find({}).toArray();
  const msg   = req.query.msg || "";
  let rows = "";
  for (const u of users) {
    const s = await statsColl.findOne({ _id: normalizeNumber(u.number) }) || { count: 0 };
    rows += `<tr>
      <td>${u.number}</td><td>${u.name || "—"}</td>
      <td style="color:green;font-weight:bold">${u.balance || 0} ৳</td>
      <td class="${u.active !== false ? "badge-active" : "badge-blocked"}">${u.active !== false ? "✅ Active" : "❌ Blocked"}</td>
      <td>${s.count}</td>
      <td>
        <form method="POST" action="/admin/balance" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <input type="number" name="amount" placeholder="টাকা" style="width:65px" required/>
          <button name="action" value="add" class="btn btn-green">+Add</button>
          <button name="action" value="deduct" class="btn btn-orange">-Cut</button>
        </form>
        <form method="POST" action="/admin/toggle-user" style="display:inline;margin-left:5px">
          <input type="hidden" name="number" value="${u.number}"/>
          <button class="btn ${u.active !== false ? "btn-red" : "btn-green"}">${u.active !== false ? "Block" : "Unblock"}</button>
        </form>
        <form method="POST" action="/admin/delete-user" style="display:inline;margin-left:5px" onsubmit="return confirm('ডিলিট করবেন?')">
          <input type="hidden" name="number" value="${u.number}"/>
          <button class="btn btn-red">🗑</button>
        </form>
      </td></tr>`;
  }
  res.send(`<html><head>${adminCSS}<title>Users</title></head><body>
    <h1>👥 User Management</h1>${adminNav}
    ${msg ? `<div class="card alert ${msg.includes("✅") ? "alert-success" : "alert-danger"}">${msg}</div>` : ""}
    <div class="card"><table>
      <tr><th>Number</th><th>Name</th><th>Balance</th><th>Status</th><th>Cards</th><th>Actions</th></tr>
      ${rows || "<tr><td colspan='6' style='text-align:center'>কোনো ইউজার নেই</td></tr>"}
    </table></div>
    <p><a href="/admin/add-user" class="btn btn-blue">➕ নতুন ইউজার যোগ করুন</a></p>
  </body></html>`);
});

app.get("/admin/add-user", adminAuth, async (req, res) => {
  const msg = req.query.msg || "";
  res.send(`<html><head>${adminCSS}<title>Add User</title></head><body>
    <h1>➕ নতুন ইউজার</h1>${adminNav}
    ${msg ? `<div class="card alert ${msg.includes("✅") ? "alert-success" : "alert-danger"}">${msg}</div>` : ""}
    <div class="card"><form method="POST" action="/admin/add-user">
      <table style="max-width:500px">
        <tr><td><b>WhatsApp Number</b></td><td><input type="text" name="number" placeholder="01712345678" style="width:250px" required/></td></tr>
        <tr><td><b>নাম</b></td><td><input type="text" name="name" placeholder="নাম" style="width:250px"/></td></tr>
        <tr><td><b>Balance (৳)</b></td><td><input type="number" name="balance" value="0" style="width:120px"/></td></tr>
      </table>
      <br><button class="btn btn-blue" style="padding:10px 30px">যোগ করুন</button>
    </form></div>
  </body></html>`);
});

app.post("/admin/add-user", adminAuth, async (req, res) => {
  const { number, name, balance } = req.body;
  const normalized = normalizeNumber(number);
  if (!normalized || normalized.length < 11)
    return res.redirect("/admin/add-user?msg=❌ Invalid number!");
  const existing = await usersColl.findOne({ number: normalized });
  if (existing)
    return res.redirect(`/admin/add-user?msg=❌ ${normalized} ইতোমধ্যে আছে!`);
  await usersColl.insertOne({ number: normalized, name: name || "User", balance: parseFloat(balance) || 0, active: true, createdAt: new Date() });
  res.redirect(`/admin/users?msg=✅ ${normalized} যোগ হয়েছে!`);
});

app.post("/admin/balance", adminAuth, async (req, res) => {
  const { number, amount, action } = req.body;
  const amt = parseFloat(amount) || 0;
  if (amt <= 0) return res.redirect("/admin/users?msg=❌ সঠিক পরিমাণ দিন।");
  const user = await usersColl.findOne({ number: normalizeNumber(number) });
  if (!user) return res.redirect("/admin/users?msg=❌ ইউজার পাওয়া যায়নি।");
  if (action === "add") {
    await usersColl.updateOne({ number: normalizeNumber(number) }, { $inc: { balance: amt } });
    return res.redirect(`/admin/users?msg=✅ ${amt}৳ যোগ হয়েছে।`);
  }
  if (action === "deduct") {
    await usersColl.updateOne({ number: normalizeNumber(number) }, { $set: { balance: Math.max(0, (user.balance || 0) - amt) } });
    return res.redirect(`/admin/users?msg=✅ ${amt}৳ কাটা হয়েছে।`);
  }
  res.redirect("/admin/users");
});

app.post("/admin/toggle-user", adminAuth, async (req, res) => {
  const normalized = normalizeNumber(req.body.number);
  const user = await usersColl.findOne({ number: normalized });
  if (!user) return res.redirect("/admin/users?msg=❌ ইউজার পাওয়া যায়নি।");
  const newStatus = user.active === false;
  await usersColl.updateOne({ number: normalized }, { $set: { active: newStatus } });
  res.redirect(`/admin/users?msg=✅ ${normalized} ${newStatus ? "Unblock" : "Block"} হয়েছে।`);
});

app.post("/admin/delete-user", adminAuth, async (req, res) => {
  const normalized = normalizeNumber(req.body.number);
  await usersColl.deleteOne({ number: normalized });
  await statsColl.deleteOne({ _id: normalized });
  res.redirect(`/admin/users?msg=✅ ${normalized} ডিলিট হয়েছে।`);
});

app.get("/admin/history", adminAuth, async (req, res) => {
  const filterNum = req.query.number || "";
  const query     = filterNum ? { number: normalizeNumber(filterNum) } : {};
  const history   = await historyColl.find(query).sort({ timestamp: -1 }).limit(200).toArray();
  const rows = history.map(h => `<tr>
    <td style="white-space:nowrap;font-size:12px">${h.timestamp ? new Date(h.timestamp).toLocaleString() : "—"}</td>
    <td>${h.number}</td><td>${h.nid}</td><td>${h.dob}</td>
    <td class="${h.status === "success" ? "badge-active" : "badge-blocked"}">${h.status.toUpperCase()}</td>
    <td>${h.charge}৳</td><td>${h.balanceAfterCut}৳</td>
    <td style="font-size:12px"><i>${h.remarks}</i></td>
  </tr>`).join("");
  res.send(`<html><head>${adminCSS}<title>History</title></head><body>
    <h1>📜 History (সর্বশেষ ২০০টি)</h1>${adminNav}
    <div class="card">
      <form method="GET" action="/admin/history" style="display:flex;gap:10px;align-items:center">
        <input type="text" name="number" value="${filterNum}" placeholder="নম্বর দিয়ে ফিল্টার" style="width:220px"/>
        <button class="btn btn-blue">Filter</button>
        ${filterNum ? `<a href="/admin/history" class="btn btn-orange">Clear</a>` : ""}
      </form>
    </div>
    <div class="card"><table>
      <tr><th>সময়</th><th>নম্বর</th><th>NID</th><th>DOB</th><th>Status</th><th>চার্জ</th><th>বাকি</th><th>মন্তব্য</th></tr>
      ${rows || "<tr><td colspan='8' style='text-align:center'>কোনো রেকর্ড নেই</td></tr>"}
    </table></div>
  </body></html>`);
});

app.get("/admin/settings", adminAuth, async (req, res) => {
  const settings = await settingsColl.findOne({ _id: "bot_settings" });
  const msg = req.query.msg || "";
  res.send(`<html><head>${adminCSS}<title>Settings</title></head><body>
    <h1>⚙️ Settings</h1>${adminNav}
    ${msg ? `<div class="card alert alert-success">${msg}</div>` : ""}
    <div class="card"><form method="POST" action="/admin/settings">
      <table style="max-width:400px">
        <tr><td><b>Card Price (৳)</b></td><td><input type="number" name="cardPrice" value="${settings?.cardPrice || 0}" style="width:120px"/></td></tr>
      </table>
      <br><button class="btn btn-blue" style="padding:10px 30px">💾 Save</button>
    </form></div>
  </body></html>`);
});

app.post("/admin/settings", adminAuth, async (req, res) => {
  await settingsColl.updateOne({ _id: "bot_settings" }, { $set: { cardPrice: parseFloat(req.body.cardPrice) || 0 } }, { upsert: true });
  res.redirect("/admin/settings?msg=✅ Saved!");
});

app.get("/admin/logout", (req, res) => {
  const sess = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess) adminSessions.delete(sess);
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/");
  res.redirect("/admin/login");
});

// ========== STARTUP ==========
(async () => {
  await connectMongoDB();
  await loginToPhpSite(); // PDF render এর জন্য
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
    console.log(`📊 Admin: http://localhost:${CONFIG.PORT}/admin`);
  });
})();
