const mongoose = require('mongoose');

const NidLogSchema = new mongoose.Schema({
  nid: { type: String, required: true },
  dob: { type: String, required: true },
  queriedAt: { type: Date, default: Date.now },
  // এই ফিল্ডটিতে যেকোনো স্ট্রাকচারের JSON হুবহু সেভ হবে
  rawResponse: { type: mongoose.Schema.Types.Mixed, required: true }
}, { strict: false }); // strict: false দিলে স্কিমার বাইরের ডেটাও সেভ করা যায়

module.exports = mongoose.model('NidLog', NidLogSchema);
