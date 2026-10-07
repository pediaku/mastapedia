'use strict';
// Toko akun premium: katalog publik, checkout tanpa login, bayar QRIS via Saya Pay,
// akun dikirim otomatis (halaman invoice + WhatsApp via Fonnte). Admin: transaksi, produk, stok.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2'); } } catch {}
const E = process.env, REDIS = E.UPSTASH_REDIS_REST_URL && E.UPSTASH_REDIS_REST_TOKEN, ON_VERCEL = Boolean(E.VERCEL);
const PAY = (E.PAY_BASE || 'https://jaya-pay.vercel.app').replace(/\/+$/, ''), SITE = E.SITE_NAME || 'Premium Store';
const SECRET = E.AUTH_SECRET || (console.warn('[!] AUTH_SECRET kosong, login admin hilang tiap restart'), crypto.randomBytes(32).toString('hex'));

// ---------- Database: Upstash Redis kalau env diisi, kalau tidak file JSON ----------
const FILE = E.DATA_FILE || path.join(__dirname, 'data.json'); let M = {}, tm;
if (!REDIS) try { M = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { if (REDIS) return; clearTimeout(tm); tm = setTimeout(() => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(M)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error(e.message); } }, 200); };
async function db(...c) {
  if (REDIS) {
    const r = await fetch(E.UPSTASH_REDIS_REST_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + E.UPSTASH_REDIS_REST_TOKEN }, body: JSON.stringify(c) });
    const j = await r.json(); if (j.error) throw new Error('DB: ' + j.error); return j.result;
  }
  const [op, k, ...a] = c, L = () => (M[k] = M[k] || []);
  switch (op) {
    case 'GET': return M[k] ?? null;
    case 'SET': M[k] = String(a[0]); save(); return 'OK';
    case 'SETNX': if (k in M) return 0; M[k] = String(a[0]); save(); return 1;
    case 'INCR': M[k] = (Number(M[k]) || 0) + 1; save(); return M[k];
    case 'DECR': M[k] = (Number(M[k]) || 0) - 1; save(); return M[k];
    case 'DEL': delete M[k]; save(); return 1;
    case 'MGET': return c.slice(1).map(x => M[x] ?? null);
    case 'MSET': for (let i = 1; i < c.length; i += 2) M[c[i]] = String(c[i + 1]); save(); return 'OK';
    case 'RPUSH': L().push(...a.map(String)); save(); return M[k].length;
    case 'LPUSH': L().unshift(...a.map(String)); save(); return M[k].length;
    case 'LPOP': { const v = (M[k] || []).shift(); save(); return v ?? null; }
    case 'LLEN': return (M[k] || []).length;
    case 'LRANGE': { const l = M[k] || [], s = +a[0], e = +a[1]; return l.slice(s, e < 0 ? l.length + e + 1 : e + 1); }
    case 'LREM': { const l = M[k] || [], i = l.indexOf(a[1]); if (i >= 0) l.splice(i, 1); save(); return i >= 0 ? 1 : 0; }
    case 'SADD': { const l = L(); for (const x of a) if (!l.includes(x)) l.push(x); save(); return 1; }
    case 'SREM': M[k] = (M[k] || []).filter(x => x !== a[0]); save(); return 1;
    case 'SMEMBERS': return M[k] || [];
  }
}
const J = async k => { const v = await db('GET', k); return v ? JSON.parse(v) : null; };
const W = (k, o) => db('SET', k, JSON.stringify(o));
const mget = async ks => ks.length ? (await db('MGET', ...ks)).map(v => (v ? JSON.parse(v) : null)) : [];

// ---------- Util ----------
const bad = (m, code = 400) => { throw Object.assign(new Error(m), { code }); };
const int = v => Math.trunc(Number(v)), rid = n => crypto.randomBytes(n).toString('hex').toUpperCase();
const rp = n => 'Rp ' + Number(n).toLocaleString('id-ID');
const sig = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const hits = new Map(); const lim = (c, max = 10, k = c.ip + c.path) => { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 6e4); a.push(n); hits.set(k, a); if (a.length > max) bad('Terlalu banyak request, tunggu semenit', 429); };
const normPhone = v => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d; return /^62\d{8,13}$/.test(d) ? d : null; };
const mask = p => p.slice(0, 4) + '****' + p.slice(-3);
const clientIp = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); return (ON_VERCEL ? (req.headers['x-real-ip'] || x[0]) : (x.pop() || req.socket.remoteAddress) || '').toString(); };
const origin = req => E.BASE_URL || ((req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')) + '://' + req.headers.host);

// ---------- WhatsApp (Fonnte) ----------
async function sendWa(to, msg) { // gagal kirim tidak boleh menggagalkan transaksi
  if (!E.FONNTE_TOKEN || !to) return;
  try { const r = await fetch('https://api.fonnte.com/send', { method: 'POST', headers: { Authorization: E.FONNTE_TOKEN }, body: new URLSearchParams({ target: to, message: msg, countryCode: '62' }), signal: AbortSignal.timeout(6000) }); if (!r.ok) console.error('[wa]', r.status); } catch (e) { console.error('[wa]', e.message); }
}
const waAdmin = msg => Promise.all(String(E.ADMIN_WA || '').split(',').map(normPhone).filter(Boolean).map(t => sendWa(t, msg)));
const fmt = d => d.link ? 'Link: ' + d.link : [`Email: ${d.email}`, `Password: ${d.password}`, d.pin && `PIN: ${d.pin}`, d.profile && `Profile: ${d.profile}`, d.a2f && `A2F: ${d.a2f}`].filter(Boolean).join('\n');

// ---------- Saya Pay ----------
async function pay(p, opt) {
  if (!E.PAY_KEY) bad('PAY_KEY belum diisi di server', 500);
  const r = await fetch(PAY + p, { ...opt, headers: { 'x-api-key': E.PAY_KEY, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) }).catch(e => bad(E.DEBUG_PAY ? 'Saya Pay tidak terjangkau: ' + e.message : 'Pembayaran sedang bermasalah, coba lagi', 502));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { console.error('[pay]', p, r.status, j.error || ''); bad(E.DEBUG_PAY ? `Saya Pay: ${r.status} ${j.error || ''}` : 'Pembayaran sedang bermasalah, coba lagi', 502); }
  return j;
}

// ---------- Order ----------
const pubOrder = o => ({ id: o.id, pname: o.pname, qty: o.qty, total: o.total, status: o.status, note: o.note || null, discount: o.discount || 0, voucher: o.voucher || null, wa: mask(o.wa), payUrl: o.payUrl, qrUrl: o.qrUrl, expiry: o.expiry, createdAt: o.createdAt, items: o.status === 'done' ? o.items : undefined });
async function deliver(o) { // ambil stok secara atomik (LPOP), kirim ke pembeli
  if (o.status !== 'paid' || !(await db('SETNX', 'dlv:' + o.id, '1'))) return o;
  const got = []; for (let i = 0; i < o.qty; i++) { const s = await db('LPOP', 'q:' + o.pid); if (!s) break; got.push(s); }
  if (got.length < o.qty) { for (const s of got.reverse()) await db('LPUSH', 'q:' + o.pid, s); await db('DEL', 'dlv:' + o.id); o.note = 'Pembayaran diterima. Stok sedang diisi ulang, akun dikirim secepatnya oleh admin.'; await W('o:' + o.id, o); return o; }
  const items = await mget(got.map(s => 's:' + s));
  for (const it of items) { it.sold = true; it.order = o.id; await W('s:' + it.id, it); }
  o.items = items.map(i => i.data); o.status = 'done'; o.doneAt = new Date().toISOString(); delete o.note; await W('o:' + o.id, o);
  await Promise.all([
    sendWa(o.wa, `✅ Pembayaran berhasil!\nInvoice: ${o.id}\nProduk: ${o.pname} x${o.qty}\n\n` + o.items.map((d, i) => (o.qty > 1 ? `--- Akun ${i + 1} ---\n` : '') + fmt(d)).join('\n\n') + `\n\nSimpan pesan ini. Detail juga ada di ${o.origin}/?inv=${o.id}`),
    waAdmin(`Penjualan sukses\nInvoice: ${o.id}\n${o.pname} x${o.qty}\nTotal: ${rp(o.total)}\nWA: ${o.wa}`)]);
  return o;
}
async function refresh(o) {
  if (o.status === 'pending') {
    let s; try { s = (await pay('/api/pay/status?id=' + encodeURIComponent(o.payId), { method: 'GET' })).status; } catch { return o; }
    if (s === 'expire' || s === 'cancel') { o.status = 'expire'; await W('o:' + o.id, o); if (o.voucher && (await db('SETNX', 'vr:' + o.id, '1'))) await db('DECR', 'vu:' + o.voucher); return o; }
    if (s !== 'settlement') return o;
    if (!(await db('SETNX', 'pd:' + o.id, '1'))) return (await J('o:' + o.id)) || o; // hanya satu proses yang boleh memproses
    o.status = 'paid'; o.paidAt = new Date().toISOString(); await W('o:' + o.id, o);
  }
  return o.status === 'paid' ? deliver(o) : o;
}

// ---------- Admin session ----------
const session = (c, on = true) => { const b = Buffer.from(JSON.stringify({ e: Date.now() + 12 * 36e5 })).toString('base64url'); c.h['Set-Cookie'] = `adm=${on ? b + '.' + sig(b) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${on ? 43200 : 0}${c.https ? '; Secure' : ''}`; };
const isAdmin = req => { const m = /(?:^|; )adm=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false; const [b, s] = m[1].split('.'); if (!b || s !== sig(b)) return false; try { return JSON.parse(Buffer.from(b, 'base64url')).e > Date.now(); } catch { return false; } };
const adm = c => c.admin || bad('Silakan masuk sebagai admin', 401);
const clean = b => {
  const name = String(b.name || '').trim().slice(0, 80), price = int(b.price), icon = String(b.icon || '').trim();
  if (!name) bad('Nama produk wajib diisi'); if (!(price >= 1)) bad('Harga tidak valid');
  if (icon && !((/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(icon) && icon.length < 150000) || /^https:\/\/\S{4,500}$/.test(icon))) bad('Icon harus gambar PNG/JPG/WebP atau URL https');
  return { name, desc: String(b.desc || '').trim().slice(0, 600), price, type: b.type === 'link' ? 'link' : 'akun', category: String(b.category || '').trim().slice(0, 30), badge: ['HOT', 'AUTO', 'NEW'].includes(b.badge) ? b.badge : '', icon, active: b.active !== false };
};
const withStock = async ps => Promise.all(ps.map(async p => ({ ...p, stock: await db('LLEN', 'q:' + p.id) })));
const allProducts = async () => (await mget((await db('SMEMBERS', 'idx:prod')).map(i => 'p:' + i))).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

const okImg = i => !i || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(i) && i.length < 150000) || /^https:\/\/\S{4,500}$/.test(i);
const cfg = async () => ({ name: SITE, logo: '', ...((await J('cfg')) || {}) });
// ---------- Voucher ----------
const vcCode = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
const vcUsed = async code => Number(await db('GET', 'vu:' + code)) || 0;
async function vcCheck(code, sub) { // validasi voucher, kembalikan {v, discount}
  const v = code && await J('vc:' + code); if (!v || !v.active) bad('Kode voucher tidak valid', 404);
  if (v.expiry && Date.now() > new Date(v.expiry + 'T23:59:59+07:00').getTime()) bad('Voucher sudah kedaluwarsa');
  if (v.min && sub < v.min) bad('Minimal belanja untuk voucher ini ' + rp(v.min));
  if (v.quota && (await vcUsed(code)) >= v.quota) bad('Kuota voucher sudah habis', 409);
  let d = v.type === 'percent' ? Math.floor(sub * v.value / 100) : v.value; if (v.type === 'percent' && v.max) d = Math.min(d, v.max);
  return { v, discount: Math.max(0, Math.min(d, sub - 1000)) };
}
const vcClaim = async v => { const n = await db('INCR', 'vu:' + v.code); if (v.quota && n > v.quota) { await db('DECR', 'vu:' + v.code); return false; } return true; };

// ---------- Routes ----------
const R = {
  'GET /api/config': async () => cfg(),
  'POST /api/voucher/check': async c => {
    lim(c, 20); const p = await J('p:' + String(c.b.pid || '').slice(0, 20)); if (!p || !p.active) bad('Produk tidak tersedia', 404);
    const sub = p.price * (Math.min(10, Math.max(1, int(c.b.qty) || 1))), r = await vcCheck(vcCode(c.b.code), sub);
    return { code: r.v.code, discount: r.discount, total: sub - r.discount };
  },
  'GET /api/products': async () => (await withStock((await allProducts()).filter(p => p.active))).map(({ createdAt, active, ...p }) => p),
  'POST /api/order': async c => {
    lim(c, 12); const p = await J('p:' + String(c.b.pid || '').slice(0, 20)); if (!p || !p.active) bad('Produk tidak tersedia', 404);
    const qty = int(c.b.qty) || 1, phone = normPhone(c.b.wa);
    if (qty < 1 || qty > 10) bad('Jumlah beli 1 sampai 10'); if (!phone) bad('Nomor WhatsApp tidak valid (contoh 0812xxxxxxxx)');
    if ((await db('LLEN', 'q:' + p.id)) < qty) bad('Stok tidak cukup', 409);
    const subtotal = p.price * qty; if (subtotal < 1000) bad('Total transaksi minimal Rp 1.000');
    let v = null, discount = 0; const code = vcCode(c.b.voucher);
    if (code) { ({ v, discount } = await vcCheck(code, subtotal)); if (!(await vcClaim(v))) bad('Kuota voucher sudah habis', 409); }
    const amount = subtotal - discount, id = rid(8);
    let d; try { d = await pay('/api/pay/create', { method: 'POST', body: JSON.stringify({ amount, reference: id, channel: E.PAY_CHANNEL || 'qris' }) }); }
    catch (e) { if (v) await db('DECR', 'vu:' + v.code); throw e; }
    const o = { id, pid: p.id, pname: p.name, type: p.type, price: p.price, qty, subtotal, discount, voucher: v ? v.code : null, amount, total: d.total || amount, wa: phone, status: 'pending', payId: d.id, payUrl: d.pay_url, qrUrl: d.qr_url, expiry: d.expiry || null, origin: c.origin, createdAt: new Date().toISOString() };
    await W('o:' + id, o); await db('LPUSH', 'orders', id);
    await sendWa(phone, `🧾 Pesanan dibuat\nInvoice: ${id}\nProduk: ${p.name} x${qty}\n` + (discount ? `Diskon (${v.code}): -${rp(discount)}\n` : '') + `Total bayar: ${rp(o.total)}\n\nBayar QRIS di: ${c.origin}/?inv=${id}\nAkun dikirim otomatis ke WhatsApp ini setelah pembayaran berhasil.`);
    return { id };
  },
  'GET /api/order': async c => {
    lim(c, 120); const id = String(c.q.get('id') || '').toUpperCase(); if (!/^[0-9A-F]{16}$/.test(id)) bad('ID invoice tidak valid', 404);
    const o = await J('o:' + id); if (!o) bad('Invoice tidak ditemukan', 404); return pubOrder(await refresh(o));
  },
  'POST /api/webhook': async c => { // notifikasi dari Saya Pay: tetap diverifikasi ulang lewat API status, jadi aman
    const ref = String(c.b.reference || (c.b.data && c.b.data.reference) || '').toUpperCase(); const o = /^[0-9A-F]{16}$/.test(ref) && await J('o:' + ref);
    if (o) await refresh(o); return { ok: 1 };
  },
  // ---- admin ----
  'POST /api/admin/login': async c => {
    lim(c, 5); if (!E.ADMIN_USERNAME || !E.ADMIN_PASSWORD) bad('ADMIN_USERNAME / ADMIN_PASSWORD belum diisi di server', 500);
    const h = s => crypto.createHash('sha256').update(String(s)).digest();
    if (!(crypto.timingSafeEqual(h(c.b.username), h(E.ADMIN_USERNAME)) & crypto.timingSafeEqual(h(c.b.password), h(E.ADMIN_PASSWORD)))) bad('Username atau password salah', 401);
    session(c); return { ok: 1 };
  },
  'POST /api/admin/logout': async c => { session(c, false); return { ok: 1 }; },
  'GET /api/admin/data': async c => {
    adm(c); const ids = await db('LRANGE', 'orders', 0, 199);
    const vcs = (await mget((await db('SMEMBERS', 'idx:vc')).map(i => 'vc:' + i))).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const v of vcs) v.used = await vcUsed(v.code);
    return { settings: await cfg(), vouchers: vcs, products: await withStock(await allProducts()), orders: (await mget(ids.map(i => 'o:' + i))).filter(Boolean).map(({ items, ...o }) => o) };
  },
  'POST /api/admin/product': async c => {
    adm(c); const d = clean(c.b), old = c.b.id ? await J('p:' + String(c.b.id)) : null; if (c.b.id && !old) bad('Produk tidak ditemukan', 404);
    const p = { ...(old || {}), ...d, id: old ? old.id : 'P' + rid(4), createdAt: old ? old.createdAt : new Date().toISOString() };
    await W('p:' + p.id, p); await db('SADD', 'idx:prod', p.id); return { ok: 1, id: p.id };
  },
  'POST /api/admin/product/delete': async c => { adm(c); const id = String(c.b.id || ''); await db('SREM', 'idx:prod', id); await db('DEL', 'p:' + id); return { ok: 1 }; },
  'POST /api/admin/settings': async c => {
    adm(c); const name = String(c.b.name || '').trim().slice(0, 40), logo = String(c.b.logo || '').trim();
    if (!name) bad('Nama website wajib diisi'); if (!okImg(logo)) bad('Logo harus gambar PNG/JPG/WebP atau URL https');
    await W('cfg', { name, logo }); return { ok: 1 };
  },
  'POST /api/admin/voucher': async c => {
    adm(c); const code = vcCode(c.b.code), type = c.b.type === 'fixed' ? 'fixed' : 'percent', value = int(c.b.value), exp = String(c.b.expiry || '').trim();
    if (code.length < 3) bad('Kode voucher minimal 3 karakter (huruf/angka)'); if (!(value >= 1) || (type === 'percent' && value > 100)) bad('Nilai diskon tidak valid');
    if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) bad('Tanggal berlaku tidak valid');
    const old = await J('vc:' + code), n = k => Math.max(0, int(c.b[k]) || 0);
    await W('vc:' + code, { code, type, value, min: n('min'), max: type === 'percent' ? n('max') : 0, quota: n('quota'), expiry: exp, active: c.b.active !== false, createdAt: old ? old.createdAt : new Date().toISOString() });
    await db('SADD', 'idx:vc', code); return { ok: 1 };
  },
  'POST /api/admin/voucher/delete': async c => { adm(c); const code = vcCode(c.b.code); await db('SREM', 'idx:vc', code); await db('DEL', 'vc:' + code); await db('DEL', 'vu:' + code); return { ok: 1 }; },
  'GET /api/admin/stock': async c => {
    adm(c); const pid = String(c.q.get('pid') || ''); const ids = (await db('SMEMBERS', 'idx:s:' + pid)).slice(-400);
    return (await mget(ids.map(i => 's:' + i))).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },
  'POST /api/admin/stock/add': async c => {
    adm(c); const p = await J('p:' + String(c.b.pid || '')); if (!p) bad('Produk tidak ditemukan', 404);
    const lines = String(c.b.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); if (!lines.length) bad('Isi stok kosong'); if (lines.length > 300) bad('Maksimal 300 baris sekali tambah');
    const recs = lines.map((l, i) => {
      let data;
      if (p.type === 'link') { if (!/^https?:\/\/\S+$/.test(l)) bad(`Baris ${i + 1}: harus berupa link http(s)`); data = { link: l }; }
      else { const [email, password, pin, profile, a2f] = l.split('|').map(s => s.trim()); if (!email || !password) bad(`Baris ${i + 1}: format email|password|pin|profile|a2f (pin, profile, a2f boleh kosong)`); data = { email, password, ...(pin && { pin }), ...(profile && { profile }), ...(a2f && { a2f }) }; }
      return { id: 'S' + rid(6), pid: p.id, data, sold: false, createdAt: new Date().toISOString() };
    });
    await db('MSET', ...recs.flatMap(r => ['s:' + r.id, JSON.stringify(r)])); await db('SADD', 'idx:s:' + p.id, ...recs.map(r => r.id)); await db('RPUSH', 'q:' + p.id, ...recs.map(r => r.id));
    return { ok: 1, added: recs.length };
  },
  'POST /api/admin/stock/delete': async c => {
    adm(c); const it = await J('s:' + String(c.b.id || '')); if (!it) bad('Stok tidak ditemukan', 404);
    if (it.sold || !(await db('LREM', 'q:' + it.pid, 1, it.id))) bad('Stok sudah terjual / sedang diambil', 409);
    await db('DEL', 's:' + it.id); await db('SREM', 'idx:s:' + it.pid, it.id); return { ok: 1 };
  },
  'POST /api/admin/order': async c => { // cek ulang pembayaran / kirim ulang akun setelah stok diisi
    adm(c); const o = await J('o:' + String(c.b.id || '')); if (!o) bad('Order tidak ditemukan', 404);
    const r = await refresh(o); if (c.b.action === 'redeliver' && r.status === 'paid') await deliver(r); return { ok: 1 };
  },
};

// ---------- Server ----------
const page = n => fs.readFileSync(path.join(__dirname, 'public', n), 'utf8');
const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p0 = url.searchParams.get('__p'); if (p0 !== null) { url.searchParams.delete('__p'); url.pathname = '/' + p0.replace(/^\/+/, ''); } // Vercel rewrite menjadikan req.url /api/index
  const pn = url.pathname.replace(/(.)\/$/, '$1');
  const out = (code, body, h = {}, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(pn === '/admin' ? { 'X-Frame-Options': 'DENY' } : {}), ...h }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  try {
    if (ON_VERCEL && (!REDIS || !E.AUTH_SECRET)) bad('Di Vercel wajib isi AUTH_SECRET, UPSTASH_REDIS_REST_URL, dan UPSTASH_REDIS_REST_TOKEN', 500);
    if (!pn.startsWith('/api/')) {
      if (req.method !== 'GET' || !['/', '/admin'].includes(pn)) bad('Not found', 404);
      return out(200, page(pn === '/' ? 'index.html' : 'admin.html'), {}, 'text/html; charset=utf-8');
    }
    const fn = R[req.method + ' ' + pn]; if (!fn) bad('Not found', 404);
    let b = req.body; if (typeof b === 'string' && b) { try { b = JSON.parse(b); } catch { bad('JSON tidak valid'); } }
    if (!b || typeof b !== 'object') { let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 4e5) bad('Body terlalu besar', 413); } try { b = raw ? JSON.parse(raw) : {}; } catch { bad('JSON tidak valid'); } }
    const c = { b, path: pn, q: url.searchParams, h: {}, admin: isAdmin(req), origin: origin(req), ip: clientIp(req), https: req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted) };
    out(200, await fn(c), c.h);
  } catch (e) { if (!e.code) console.error(e); out(e.code || 500, { error: e.code ? e.message : 'Kesalahan server' }); }
};
module.exports = handler;
if (require.main === module) http.createServer(handler).listen(E.PORT || 3000, () => console.log('[Shop] port', E.PORT || 3000, '| db:', REDIS ? 'Upstash' : 'file'));
