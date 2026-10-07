# Toko Akun Premium

Katalog publik tanpa login, checkout pakai nomor WhatsApp, bayar QRIS lewat **Saya Pay**, akun dikirim otomatis
(halaman invoice + WhatsApp via Fonnte). Admin di `/admin` (sidebar kiri): Transaksi, Produk, Stok, Voucher, Pengaturan (nama website + logo).

## Deploy ke Vercel
1. Repo baru (jangan digabung dengan project payment gateway lama). Upload isi folder ini, `.env` jangan ikut.
2. Buat database gratis di upstash.com (Redis), salin REST URL dan REST TOKEN.
3. Vercel > Settings > Environment Variables, isi semua variabel di `.env.example`
   (minimal: ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET, PAY_KEY, UPSTASH_*).
4. Deploy. Toko di `/`, admin di `/admin`.

## Saya Pay
- `PAY_KEY` = API key dari dashboard Saya Pay. Kalau whitelist IP di Saya Pay diisi, kosongkan dulu (IP Vercel berubah-ubah).
- Fee (ditanggung pembeli / penjual) diatur di dashboard Saya Pay. Total yang tampil ke pembeli mengikuti `total` dari Saya Pay.
- Webhook (opsional tapi disarankan, supaya akun terkirim walau pembeli menutup halaman):
  isi Webhook URL di Saya Pay dengan `https://DOMAIN-TOKO/api/webhook`.
- Total transaksi minimal Rp 1.000 (batas Saya Pay).

## Format stok
- Produk jenis **akun**: satu baris per akun `email|password|pin|profile|a2f` (pin, profile, a2f opsional).
- Produk jenis **link**: satu link per baris.

## Voucher
Buat di menu Voucher: jenis persen / potongan tetap, minimal belanja, maksimal potongan, kuota, tanggal berlaku. Pembeli memasukkan kode di jendela checkout. Kuota otomatis dikembalikan kalau pesanan kedaluwarsa.

## Nama & logo
Menu Pengaturan. Nilai `SITE_NAME` di env hanya jadi nama awal sebelum diubah dari admin.
