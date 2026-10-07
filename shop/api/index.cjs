// Entry Vercel. Ekstensi .cjs supaya tetap jalan walau package.json project punya "type": "module".
// Kalau server gagal dimuat, pesan aslinya ditampilkan (bukan 500 kosong) supaya mudah dicari penyebabnya.
let handler;
try { handler = require('../server.cjs'); }
catch (e) {
  console.error('[Toko] gagal memuat server:', e);
  handler = (req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Gagal memuat server: ' + e.message })); };
}
module.exports = (req, res) => handler(req, res);
