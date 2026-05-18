/**
 * NID Service Bot - WhatsApp Cloud API Version
 * [DIRECT API CALL — PHP Session Bypass + MongoDB Raw JSON Logger]
 */

require('dotenv').config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");
const { MongoClient } = require("mongodb");
const mongoose = require('mongoose');
const NidLog = require('./models/NidLog'); // আপনার তৈরি করা Mongoose মডেল ফাইল

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

  // PDF render এর জন্য PHP সাইট (শুধু ইমেজ সোর্সের জন্য ব্যবহৃত)
  PHP_SITE_BASE_URL: process.env.PHP_SITE_BASE_URL || "https://my-gov-bd.site",
  PHP_BOT_EMAIL: process.env.PHP_BOT_EMAIL || "irfanbot@gmail.com",
  PHP_BOT_PASS: process.env.PHP_BOT_PASS || "p@@ss: irfan2002",

  EXTERNAL_PUPPETEER_URL: process.env.EXTERNAL_PUPPETEER_URL || "https://pupeeter-production-2b39.up.railway.app/pdf",
  PUPPETEER_SECRET: process.env.PUPPETEER_SECRET || "nid_pdf_secret_2025",
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

// ========== MONGODB & MONGOOSE CONNECTION ==========
async function connectMongoDB() {
  try {
    const client = new MongoClient(CONFIG.MONGO_URI);
    await client.connect();
    db           = client.db("nid_whatsapp_bot");
    usersColl    = db.collection("users");
    statsColl    = db.collection("stats");
    settingsColl = db.collection("settings");
    historyColl  = db.collection("history");
    console.log("✅ Native MongoDB Connected.");

    await mongoose.connect(CONFIG.MONGO_URI);
    console.log("✅ Mongoose Connected for NidLog.");

    const settings = await settingsColl.findOne({ _id: "bot_settings" });
    if (!settings) await settingsColl.insertOne({ _id: "bot_settings", cardPrice: 10 });
  } catch (e) {
    console.error("❌ MongoDB/Mongoose Connection Failed:", e.message);
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

// ========== DIRECT NID API CALL WITH MONGO DB LOGGING ==========
async function searchNIDDirect(nid, dob, from) {
  try {
    const url = `${CONFIG.NID_API_URL}?key=${CONFIG.NID_API_KEY}&nid=${nid}&dob=${dob}`;
    console.log(`🔍 Direct API call: ${url}`);

    const response = await axios.get(url, {
      timeout: 50000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const result = response.data;

    // MongoDB তে Raw JSON ব্যাকআপ সেভ
    try {
      const logEntry = new NidLog({
        userNumber: normalizeNumber(from),
        nid: nid,
        dob: dob,
        rawResponse: result
      });
      await logEntry.save();
      console.log(`✅ NID: ${nid} এর Raw JSON সফলভাবে MongoDB-তে ব্যাকআপ করা হয়েছে।`);
    } catch (dbError) {
      console.error("⚠️ MongoDB তে Raw JSON সেভ করতে ব্যর্থ:", dbError.message);
    }

    return result;

  } catch (error) {
    console.error("❌ Direct API Error:", error.message);
    return { status: "error", message: "NID API সার্ভারে কানেক্ট করা যাচ্ছে না।" };
  }
}

// ========== EXTERNAL PUPPETEER PDF RENDER USING LOCAL BASE64 HTML ==========
async function renderPDFLocalTemplate(apiData) {
  try {
    const nid = apiData.data?.nid || "";
    const pin = apiData.data?.pin || "";
    const oldNid = apiData.data?.oldNid || "-";
    const upazilaCode = apiData.data?.upazilaCode || "-";
    const voterArea = apiData.data?.voterArea || "";
    const nameBn = apiData.data?.nameBn || "";
    const nameEn = apiData.data?.nameEn || "";
    const dob = apiData.data?.dob || "";
    const father = apiData.data?.father || "";
    const mother = apiData.data?.mother || "";
    const bloodGroup = apiData.data?.bloodGroup || "-";
    const age = apiData.data?.age || "";
    const gender = apiData.data?.gender || "";
    const birthDay = apiData.data?.birthDay || "";
    const birthPlace = apiData.data?.birthPlace || "";
    const presentAddr = apiData.data?.presentAddr || "";
    const permAddr = apiData.data?.permAddr || "";
    const photo = apiData.data?.photo || "";

    // জেনারেট করা HTML টেমপ্লেট (সঠিক স্ট্রাকচার)
    const htmlStructure = `<!DOCTYPE html>
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
		<div contenteditable="true" style="position: absolute; left: 37.3%; top: 65.2%; width: auto; font-size: 14px; color: rgb(7, 7, 7); font-family: 'SolaimanLipi', sans-serif;"> বয়স </div>
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

    // রেলওয়ে Puppeteer এপিআই-তে রিকোয়েস্ট পাঠানো (নতুন ডাটা ফরম্যাট অনুযায়ী)
    const response = await axios.post(
      CONFIG.EXTERNAL_PUPPETEER_URL,
      { 
        secret: CONFIG.PUPPETEER_SECRET, // বডিতে সিক্রেট পাঠানো হলো
        html: htmlStructure             // Base64 এর বদলে সরাসরি র HTML পাঠানো হলো
      },
      { 
        responseType: "json",           // json রেসপন্স রিসিভ করা হবে
        timeout: 95000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      }
    );

    // রেলওয়ের রেসপন্স থেকে Base64 PDF টিকে রিলিজ করে Buffer-এ কনভার্ট করা
    if (response.data && response.data.success && response.data.pdf) {
      return Buffer.from(response.data.pdf, "base64");
    } else {
      throw new Error(response.data?.error || "Puppeteer থেকে কোনো পিডিএফ ডাটা পাওয়া যায়নি।");
    }

  } catch (error) {
    console.error("❌ PDF Render Error:", error.message);
    if (error.response?.data) {
      console.error("❌ API Error Response Data:", error.response.data);
    }
    throw new Error(`PDF তৈরি করা যাচ্ছে না। (Status: ${error.response?.status || 'Error'})`);
  }
}

// ========== INCOMING MESSAGE HANDLER ==========
async function handleIncoming(msgObj) {
  const from = msgObj.from;
  const msgId = msgObj.id;
  const text = msgObj.text?.body?.trim();

  if (!text) return;
  await markRead(msgId);

  if (text.toLowerCase() === "start" || text.toLowerCase() === "menu") {
    await sendText(from, "👋 আমাদের NID সার্ভিস বোটে আপনাকে स्वागतম!\n\nকার্ড বের করতে নিচে দেওয়া ফরম্যাটে মেসেজ দিন:\n*NID_NUMBER DOB*\n\nউদাহরণ:\n_6014203332 1996-01-20_");
    return;
  }

  const parts = text.split(/\s+/);
  if (parts.length !== 2) {
    await sendText(from, "❌ ভুল ফরম্যাট! দয়া করে এভাবে দিন:\n*NID_NUMBER DOB*\n\nউদাহরণ:\n_6014203332 1996-01-20_");
    return;
  }

  const [nid, dob] = parts;
  if (!/^\d{10}$|^\d{13}$|^\d{17}$/.test(nid) || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    await sendText(from, "❌ ভুল NID অথবা জন্মতারিখ ফরম্যাট।\nNID ১০, ১৩ অথবা ১৭ ডিজিটের হতে হবে এবং DOB YYYY-MM-DD ফরম্যাটে হতে হবে।");
    return;
  }

  const allowed = await isAllowed(from);
  if (!allowed) {
    await sendText(from, "🚫 দুঃখিত, আপনি এই বটের অনুমোদিত ইউজার নন অথবা আপনার অ্যাকাউন্টটি নিষ্ক্রিয়। অ্যাডমিনের সাথে যোগাযোগ করুন।");
    return;
  }

  const balance = await getUserBalance(from);
  const price = await getCardPrice();

  if (balance < price) {
    await sendText(from, `⚠️ আপনার পর্যাপ্ত ব্যালেন্স নেই।\nপ্রয়োজন: ${price} ৳\nআপনাক ব্যালেন্স: ${balance} ৳\n\nদয়া করে রিচার্জ করতে অ্যাডমিনের সাথে যোগাযোগ করুন।`);
    return;
  }

  await sendText(from, "⏳ আপনার রিকোয়েস্টটি প্রসেস করা হচ্ছে। দয়া করে অপেক্ষা করুন...");

  try {
    const apiResult = await searchNIDDirect(nid, dob, from); 

    if (!apiResult || apiResult.status === "error" || apiResult.success === false || !apiResult.data) {
      const msg = apiResult?.message || "এনআইডি সার্ভার থেকে কোনো ডাটা পাওয়া যায়নি।";
      await logToHistory(from, nid, dob, "failed", 0, balance, `API Error: ${msg}`);
      await sendText(from, `❌ ${msg}`);
      return;
    }

    // Base64 ইমপ্লিমেন্টেড লোকাল HTML টেমপ্লেট দিয়ে সরাসরি PDF রেন্ডার করা হচ্ছে 
    const pdfBuffer = await renderPDFLocalTemplate(apiResult); 
    const filename = `${nid}_server_copy.pdf`;

    const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");

    const newBalance = balance - price;
    await usersColl.updateOne({ number: normalizeNumber(from) }, { $set: { balance: newBalance } });
    await logToHistory(from, nid, dob, "success", price, newBalance, "সফলভাবে পিডিএফ পাঠানো হয়েছে।");

    await sendDocument(from, mediaId, filename, `✅ সফলভাবে আপনার NID সার্ভার কপি তৈরি হয়েছে।\n\n💰 চার্জ কাটা হয়েছে: ${price} ৳\n📉 বর্তমান ব্যালেন্স: ${newBalance} ৳`);

  } catch (err) {
    console.error("🔥 Global Handle Error:", err.message);
    await logToHistory(from, nid, dob, "failed", 0, balance, `Crash: ${err.message}`);
    await sendText(from, `❌ দুঃখিত, একটি অভ্যন্তরীণ কারিগরি ত্রুটি ঘটেছে। আবার চেষ্টা করুন বা অ্যাডমিনকে জানান। (${err.message})`);
  }
}

// ========== EXPRESS SERVER & WEB ADMIN ==========
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const adminSessions = new Set();

function adminAuth(req, res, next) {
  const cookies = req.headers.cookie || "";
  const sess = cookies.split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

// UI Styles
const adminCSS = `<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 40px; background: #f4f7f6; color: #333; }
  h1 { color: #2c3e50; }
  nav { background: #2c3e50; padding: 15px; border-radius: 5px; margin-bottom: 30px; display: flex; gap: 15px; flex-wrap: wrap; }
  nav a { color: white; text-decoration: none; font-weight: bold; padding: 5px 10px; border-radius: 3px; }
  nav a:hover { background: #34495e; }
  .card { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; min-width: 600px; }
  th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f2f2f2; color: #2c3e50; }
  tr:hover { background: #f9f9f9; }
  .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; text-decoration: none; font-size: 13px; display: inline-block; }
  .btn-blue { background: #007bff; color: white; }
  .btn-blue:hover { background: #0056b3; }
  .btn-danger { background: #dc3545; color: white; }
  .btn-danger:hover { background: #bd2130; }
  .alert { padding: 15px; border-radius: 4px; margin-bottom: 20px; font-weight: bold; }
  .alert-success { background: #d4edda; color: #155724; }
  .alert-danger { background: #f8d7da; color: #721c24; }
  input, select { padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
</style>`;

const adminNav = `<nav>
  <a href="/admin">📊 Dashboard</a>
  <a href="/admin/users">👥 Users</a>
  <a href="/admin/add-user">➕ Add User</a>
  <a href="/admin/history">📜 History</a>
  <a href="/admin/nidlogs">📂 NID Raw Logs</a>
  <a href="/admin/settings">⚙️ Settings</a>
  <a href="/admin/logout" style="color:#dc3545">🚪 Logout</a>
</nav>`;

// Webhooks
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === CONFIG.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const change = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (msg) await handleIncoming(msg);
});

// Admin Authentication
app.get("/admin/login", (req, res) => {
  res.send(`<html><head>${adminCSS}<title>Admin Login</title></head><body>
    <div class="card" style="max-width:350px; margin: 100px auto; text-align:center;">
      <h2>🔒 Bot Admin Login</h2><br>
      <form method="POST" action="/admin/login">
        <input type="password" name="password" placeholder="Admin Password" style="width:100%; padding:10px;" required/><br><br>
        <button class="btn btn-blue" style="width:100%; padding:10px;">Login</button>
      </form>
    </div>
  </body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const token = crypto.randomBytes(16).toString("hex");
    adminSessions.add(token);
    res.setHeader("Set-Cookie", `admin_sess=${token}; Path=/; HttpOnly`);
    res.redirect("/admin");
  } else {
    res.send("<script>alert('ভুল পাসওয়ার্ড!'); window.location='/admin/login';</script>");
  }
});

// Admin Dashboard
app.get("/admin", adminAuth, async (req, res) => {
  const totalUsers = await usersColl.countDocuments();
  const totalHits = await historyColl.countDocuments();
  const successHits = await historyColl.countDocuments({ status: "success" });
  const failedHits = await historyColl.countDocuments({ status: "failed" });

  res.send(`<html><head>${adminCSS}<title>Dashboard</title></head><body>
    <h1>📊 Admin Dashboard</h1>${adminNav}
    <div style="display:flex; gap:20px; flex-wrap:wrap;">
      <div class="card" style="flex:1; min-width:200px; text-align:center;"><h3>👥 মোট ইউজার</h3><h2>${totalUsers}</h2></div>
      <div class="card" style="flex:1; min-width:200px; text-align:center;"><h3>🔍 মোট সার্চ হিট</h3><h2>${totalHits}</h2></div>
      <div class="card" style="flex:1; min-width:200px; text-align:center; color:green;"><h3>✅ সফল সার্চ</h3><h2>${successHits}</h2></div>
      <div class="card" style="flex:1; min-width:200px; text-align:center; color:red;"><h3>❌ ব্যর্থ সার্চ</h3><h2>${failedHits}</h2></div>
    </div>
  </body></html>`);
});

// Users Management
app.get("/admin/users", adminAuth, async (req, res) => {
  const users = await usersColl.find().toArray();
  let rows = "";
  users.forEach(u => {
    rows += `<tr>
      <td>${u.name || "—"}</td>
      <td><b>${u.number}</b></td>
      <td>${u.balance || 0} ৳</td>
      <td>${u.active !== false ? "<span style='color:green;font-weight:bold'>Active</span>" : "<span style='color:red;font-weight:bold'>Disabled</span>"}</td>
      <td>
        <a class="btn btn-blue" href="/admin/edit-user?number=${u.number}">✏️ Edit / Recharge</a>
      </td>
    </tr>`;
  });

  res.send(`<html><head>${adminCSS}<title>Manage Users</title></head><body>
    <h1>👥 User Management</h1>${adminNav}
    <div class="card">
      <table>
        <tr><th>নাম</th><th>হোয়াটসঅ্যাপ নম্বর</th><th>ব্যালেন্স</th><th>অবস্থা</th><th>অ্যাকশন</th></tr>
        ${rows || "<tr><td colspan='5'>কোনো ইউজার পাওয়া যায়নি।</td></tr>"}
      </table>
    </div>
  </body></html>`);
});

app.get("/admin/add-user", adminAuth, (req, res) => {
  res.send(`<html><head>${adminCSS}<title>Add User</title></head><body>
    <h1>➕ Add New Authorized User</h1>${adminNav}
    <div class="card"><form method="POST" action="/admin/add-user" style="max-width:400px; display:flex; flex-direction:column; gap:15px;">
      <input type="text" name="name" placeholder="ইউজারের নাম" required/>
      <input type="text" name="number" placeholder="হোয়াটসঅ্যাপ নম্বর (যেমন: 88017XXXXXXXX)" required/>
      <input type="number" name="balance" placeholder="ব্যালেন্স (৳)" value="0" required/>
      <button class="btn btn-blue" style="padding:10px;">Save User</button>
    </form></div>
  </body></html>`);
});

app.post("/admin/add-user", adminAuth, async (req, res) => {
  const { name, number, balance } = req.body;
  const num = normalizeNumber(number);
  await usersColl.updateOne(
    { number: num },
    { $set: { name, number: num, balance: parseFloat(balance) || 0, active: true } },
    { upsert: true }
  );
  res.redirect("/admin/users");
});

app.get("/admin/edit-user", adminAuth, async (req, res) => {
  const user = await usersColl.findOne({ number: req.query.number });
  if (!user) return res.send("User not found");
  res.send(`<html><head>${adminCSS}<title>Edit User</title></head><body>
    <h1>✏️ Edit User / Recharge</h1>${adminNav}
    <div class="card"><form method="POST" action="/admin/edit-user" style="max-width:400px; display:flex; flex-direction:column; gap:15px;">
      <input type="hidden" name="oldNumber" value="${user.number}"/>
      <label><b>নাম:</b></label><input type="text" name="name" value="${user.name || ""}" required/>
      <label><b>নম্বর:</b></label><input type="text" name="number" value="${user.number}" required/>
      <label><b>ব্যালেন্স (৳):</b></label><input type="number" step="0.01" name="balance" value="${user.balance || 0}" required/>
      <label><b>ইউজার স্ট্যাটাস:</b></label>
      <select name="active">
        <option value="true" ${user.active !== false ? "selected" : ""}>Active</option>
        <option value="false" ${user.active === false ? "selected" : ""}>Disabled</option>
      </select>
      <button class="btn btn-blue" style="padding:10px;">💾 Update Details</button>
    </form></div>
  </body></html>`);
});

app.post("/admin/edit-user", adminAuth, async (req, res) => {
  const { oldNumber, name, number, balance, active } = req.body;
  const newNum = normalizeNumber(number);
  if (oldNumber !== newNum) await usersColl.deleteOne({ number: oldNumber });
  await usersColl.updateOne(
    { number: newNum },
    { $set: { name, number: newNum, balance: parseFloat(balance) || 0, active: active === "true" } },
    { upsert: true }
  );
  res.redirect("/admin/users");
});

// Logs History
app.get("/admin/history", adminAuth, async (req, res) => {
  const history = await historyColl.find().sort({ timestamp: -1 }).limit(150).toArray();
  let rows = "";
  history.forEach(h => {
    rows += `<tr>
      <td style="white-space:nowrap; font-size:12px">${h.timestamp ? new Date(h.timestamp).toLocaleString() : "—"}</td>
      <td>${h.number}</td>
      <td>${h.nid}</td>
      <td>${h.dob}</td>
      <td>${h.status === "success" ? "<span style='color:green;font-weight:bold'>Success</span>" : "<span style='color:red;font-weight:bold'>Failed</span>"}</td>
      <td>${h.charge || 0} ৳</td>
      <td style="font-size:12px; color:#555;">${h.remarks || "—"}</td>
    </tr>`;
  });

  res.send(`<html><head>${adminCSS}<title>History</title></head><body>
    <h1>📜 Search History Logs</h1>${adminNav}
    <div class="card">
      <table>
        <tr><th>সময় ও তারিখ</th><th>ইউজার নম্বর</th><th>NID নম্বর</th><th>জন্মতারিখ</th><th>অবস্থা</th><th>চার্জ</th><th>মন্তব্য</th></tr>
        ${rows || "<tr><td colspan='7'>এখনো কোনো হিস্ট্রি রেকর্ড তৈরি হয়নি।</td></tr>"}
      </table>
    </div>
  </body></html>`);
});

// Admin NID Raw Logs Interface
app.get("/admin/nidlogs", adminAuth, async (req, res) => {
  try {
    const logs = await NidLog.find().sort({ queriedAt: -1 }).limit(100);
    
    let rows = "";
    for (const log of logs) {
      const base64Data = Buffer.from(JSON.stringify(log.rawResponse || {})).toString("base64");
      
      rows += `<tr>
        <td style="white-space:nowrap;font-size:12px">${log.queriedAt ? new Date(log.queriedAt).toLocaleString() : "—"}</td>
        <td><b>${log.userNumber || "—"}</b></td>
        <td>${log.nid || "—"}</td>
        <td>${log.dob || "—"}</td>
        <td>
          <button class="btn btn-blue" onclick="showJsonPopup('${base64Data}')">👁️ View Full JSON</button>
        </td>
      </tr>`;
    }

    res.send(`<html>
    <head>
      ${adminCSS}
      <title>NID Raw Logs</title>
      <style>
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.5); }
        .modal-content { background-color: #fefefe; margin: 5% auto; padding: 20px; border: 1px solid #888; width: 70%; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
        .close { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
        .close:hover { color: #000; }
        pre { background: #272822; color: #f8f8f2; padding: 15px; border-radius: 5px; overflow-x: auto; max-height: 500px; font-family: 'Courier New', Courier, monospace; text-align: left; }
      </style>
    </head>
    <body>
      <h1>📂 NID API Raw Responses Logger</h1>
      ${adminNav}
      
      <div class="card">
        <table>
          <tr>
            <th>সময় ও তারিখ</th>
            <th>ইউজার নম্বর</th>
            <th>NID নম্বর</th>
            <th>জন্মতারিখ</th>
            <th>অ্যাকশন</th>
          </tr>
          ${rows || "<tr><td colspan='5' style='text-align:center'>এখনো কোনো সফল/ব্যর্থ API রেসপন্স ব্যাকআপ করা হয়নি।</td></tr>"}
        </table>
      </div>

      <div id="jsonModal" class="modal">
        <div class="modal-content">
          <span class="close" onclick="closeModal()">&times;</span>
          <h3>📦 Hubuhu API Response (JSON Format)</h3>
          <hr>
          <pre id="jsonWrapper"></pre>
        </div>
      </div>

      <script>
        function showJsonPopup(base64Str) {
          try {
            const rawJson = atob(base64Str);
            const parsedObj = JSON.parse(rawJson);
            document.getElementById("jsonWrapper").textContent = JSON.stringify(parsedObj, null, 4);
            document.getElementById("jsonModal").style.display = "block";
          } catch (e) {
            alert("Error parsing JSON data: " + e.message);
          }
        }

        function closeModal() {
          document.getElementById("jsonModal").style.display = "none";
        }

        window.onclick = function(event) {
          const modal = document.getElementById("jsonModal");
          if (event.target == modal) {
            modal.style.display = "none";
          }
        }
      </script>
    </body>
    </html>`);

  } catch (error) {
    res.send(`<html><head>${adminCSS}</head><body><div class="card alert alert-danger">❌ এরর: ${error.message}</div></body></html>`);
  }
});

// Settings Management
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
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/; HttpOnly");
  res.redirect("/admin/login");
});

// Start Server
app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Server listening on port ${CONFIG.PORT}`);
  await connectMongoDB();
  await loginToPhpSite();
});
