'use strict';
// Where the app checks its licence. Before building the installer, set SERVER_URL and BUY_URL to the live addresses
// (for example https://api.yourdomain.com and https://yourdomain.com/pricing.html). For testing on this PC the
// local admin server is used (npm run admin). Environment variables override both.

const path = require('path');

module.exports = {
  SERVER_URL: process.env.CLASSCUE_LICENCE_SERVER || 'https://api.34-61-176-96.sslip.io',
  BUY_URL: process.env.CLASSCUE_BUY_URL || 'http://localhost:4173/pricing.html',
  GRACE_DAYS: 7,   // how long the app keeps working without reaching the licence server
  TRIAL_DAYS: 7,   // shown in the app; the server decides the real length (TRIAL_DAYS on the server)
  PUBLIC_KEY_FILE: path.join(__dirname, 'public-key.pem'),   // must match the server's admin/data/signing-key.pem
};
