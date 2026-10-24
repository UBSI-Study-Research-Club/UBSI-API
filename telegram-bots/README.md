# USRC Telegram Bots Ecosystem (Hub & Worker Architecture)

Sistem otomatisasi layanan akademik mahasiswa Universitas Bina Sarana Informatika untuk komunitas **USRC (UBSI Study & Research Club)**.

Menggunakan **Arsitektur 4 Bot (3 Bot Pekerja Spesialis di Topik Grup + 1 Bot Master Frontdesk di DM Pribadi)** yang terhubung ke Backend Headless FastAPI (`UBSI-API`) dan Database Supabase PostgreSQL.

---

## 1. Arsitektur & Alur Kerja (Workflow)

```
[ SUPERGROUP USRC TELEGRAM ]
  │
  ├── Topik: E-Learning & Absen  ──> [ worker-absen.js ]   ──┐
  ├── Topik: Statistik Nilai     ──> [ worker-stats.js ]   ──┼──> [ FastAPI Engine (Railway) ]
  └── Topik: Gudang Materi       ──> [ worker-gudang.js ]  ──┘                 │
                                                                               ▼
[ CHAT PRIBADI / DM ]                                                 [ Portal Kampus UBSI ]
  └── Frontdesk Mahasiswa        ──> [ worker-master.js ] <── (Bukti)  (MyBest, SIAKAD, EPrints)
                                             │
                                             ▼
                                    [ Supabase USRC DB ]
                                    (Tabel ubsi_accounts)
```

### Prinsip Keamanan & Privasi:
1. **Pemisahan Kredensial:** Hanya `worker-master.js` yang memiliki izin membaca/menulis akun login mahasiswa di Supabase. Bot di grup publik tidak memegang password.
2. **Kerahasiaan Nilai (Zero Leak):** Nilai KHS, IPK, dan detail komponen nilai tidak pernah dikirim ke grup publik. Bot Statistik hanya mengonfirmasi perhitungan di grup, sementara laporan detail dikirim rahasia ke DM via Bot Master.
3. **Absensi Transparan:** Anggota mengeksekusi tombol absen secara sadar di grup, bukti kehadiran lengkap langsung diteruskan ke DM pribadi.

---

## 2. Rincian Peran Masing-Masing Bot

### 👑 1. Bot Master (`worker-master.js`)
- **Lokasi:** Chat Pribadi (DM)
- **Fungsi:**
  - `/start`: Panduan onboarding mahasiswa.
  - `/login <NIM> <PASSWORD>`: Verifikasi akun ke sistem kampus dan simpan aman ke Supabase.
  - Pusat pengiriman bukti presensi dan laporan analisis nilai rahasia.
  - `/ingat <kata kunci>`: Mesin Waktu — cari jejak di arsip ghost log (semua yang menguap dari grup tercatat di `ubsi_ghost_log`). Tanpa kata kunci = 10 aktivitas terakhir.
  - `/cek <KODE>`: Verifikasi resi anti-rekayasa (contoh `/cek KMP-7F3A`). Resi tidak ditemukan = bukti yang dipegang bukan asli.

### 📚 2. Bot Gudang Materi (`worker-gudang.js`)
- **Lokasi:** Topik *Gudang Materi & Jurnal*
- **Fungsi:**
  - `/buku <kata kunci>`: Pencarian katalog OPAC Perpustakaan BSI beserta tautan baca.
  - `/cari <kata kunci>`: Pencarian skripsi, tugas akhir, dan riset di EPrints Repository BSI.
  - `/jurnal`: Menampilkan direktori e-journal resmi kampus.
  - `/materi <kata kunci>`: Unduh slide/PDF materi MyBest (dikirim sebagai file + mirror DATACENTER).
  - `/tugas`: Daftar tugas aktif (nama matkul, deadline, status pengumpulan) + tombol unduh soal.
    Hasil personal dikirim ke DM anggota; di grup hanya notifikasi ringkas (command dihapus).
  - `/kumpul <token_tugas> <link_gdrive> [catatan]`: Pengumpulan tugas via Google Drive
    (wajib link dengan akses *"Anyone with the link"*; tersimpan di tabel `ubsi_task_submissions`).
    Saat berhasil, command + pesan proses dihapus otomatis — yang nempel hanya bukti berhasil + resi `KMP-XXXX`.

### ⚡ 3. Bot Absensi MyBest (`worker-absen.js`)
- **Lokasi:** Topik *E-Learning & Absen*
- **Fungsi:**
  - `/absen` atau `/menu`: Memunculkan menu interaktif.
  - Tombol `[ ⚡ Absen Kelas Sekarang ]`: Deteksi sesi aktif di MyBest, bypass captcha teks, dan submit presensi mahasiswa.
  - Tombol `[ 📋 Cek Jadwal Kuliah ]`: **List hidup** jadwal kuliah — hitung mundur live per matkul, update sendiri tiap menit, menguap otomatis dalam 20 menit.
  - Mengirimkan bukti kehadiran resmi ke DM via Bot Master, lengkap dengan resi `ABS-XXXX`.

### 📈 4. Bot Statistik & Nilai (`worker-stats.js`)
- **Lokasi:** Topik *Statistik Mahasiswa*
- **Fungsi:**
  - `/stats` atau `/menu`: Memunculkan menu diagnosis.
  - Tombol `[ 📊 Analisis Performa & Titik Lemah ]`:
    - Mengambil KHS dan rincian nilai berjalan dari SIAKAD.
    - Analisis matematis: mendeteksi matkul dengan nilai bocor (<70).
    - Menghitung simulasi target IPK / Cumlaude.
    - Mengirim laporan lengkap secara privat ke DM via Bot Master.

---

## 3. Konfigurasi Environment Variables (Cloudflare Workers)

Setiap Worker di Cloudflare membutuhkan Secrets/Variables berikut:

| Key | Worker yang Membutuhkan | Keterangan |
|---|---|---|
| `BACKEND_URL` | Semua Worker | URL Backend Railway (`https://ubsi-api-production.up.railway.app`) |
| `BACKEND_API_KEY` | Semua Worker | API Key internal backend (wajib diisi, tanpa fallback — jangan pernah di-commit) |
| `TELEGRAM_SECRET_TOKEN` | Semua Worker | Secret webhook Telegram. Wajib sama dengan `secret_token` yang dikirim saat `setWebhook`; request tanpa header `X-Telegram-Bot-Api-Secret-Token` yang cocok ditolak 403 |
| `SUPABASE_URL` | Master, Absen, Stats | URL Supabase USRC |
| `SUPABASE_SERVICE_ROLE_KEY` | Master, Absen, Stats | Kunci Service Role Supabase untuk akses tabel `ubsi_accounts` |
| `BOT_TOKEN_MASTER` | Master, Absen, Stats | Token Telegram Bot Master |
| `BOT_TOKEN_GUDANG` | Gudang | Token Telegram Bot Gudang |
| `BOT_TOKEN_ABSEN` | Absen | Token Telegram Bot Absen |
| `BOT_TOKEN_STATS` | Stats | Token Telegram Bot Stats |

---

## 4. Cara Setting Webhook Telegram

Setelah masing-masing Worker di-deploy di Cloudflare, hubungkan webhook via browser:

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<NAMA-WORKER>.workers.dev
```

*Tips:* Jika server Telegram mengalami kendala DNS (`Temporary failure in name resolution`), sertakan IP Cloudflare Edge:
```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<NAMA-WORKER>.workers.dev", "ip_address": "172.67.171.211"}'
```

---

## 4b. Clean Group Experience (v2.1)

Prinsip: grup tampil seperti papan informasi yang selalu bersih — yang nempel hanya bukti berhasil dan menu; sisanya menguap tapi tercatat.

- **Transaksi** (`/kumpul`, absen): proses tampil normal → saat **berhasil**, command + pesan proses dihapus otomatis; yang tersisa hanya bukti berhasil + resi. **Gagal = tidak ada yang dihapus** (penyebab tetap terlihat).
- **Jadwal (list hidup):** tombol `[ 📋 Cek Jadwal Kuliah ]` menghasilkan list dengan hitung mundur live; diedit tiap menit oleh cron worker absen, menguap otomatis dalam 20 menit. Tombol `[ 🔄 Perbarui ]` memuat ulang tanpa pesan baru.
- **Tugas personal:** `/tugas` mengirim hasil ke DM anggota; grup hanya menerima notifikasi ringkas. Fallback: bila anggota belum `/start` bot gudang, list tampil di grup seperti biasa.
- **Ghost Log:** setiap command/list yang menguap dicatat ke tabel `ubsi_ghost_log` (+ mirror satu baris ke channel DATACENTER dari worker gudang). Telusuri lewat `/ingat <kata kunci>` di Bot Master.
- **Resi anti-rekayasa:** bukti kumpul (`KMP-XXXX`) dan absen (`ABS-XXXX`) tersimpan di `ubsi_receipts`; verifikasi via `/cek <KODE>` di Bot Master.

**Wajib saat deploy:**
1. Jalankan `sql-ghost-resi-ephemeral.sql` di Supabase SQL Editor (3 tabel baru: ghost log, receipts, ephemeral msgs).
2. Worker **absen** harus diberi Cron Trigger `* * * * *` di dashboard Cloudflare (Settings → Triggers) agar list jadwal berdetak dan sweep berjalan.
3. Env `DATACENTER_CHAT_ID` di worker gudang mengaktifkan mirror ghost log ke channel arsip (opsional).

---

## 5. Skema Database Supabase

Tabel pendukung di PostgreSQL Supabase:

```sql
create table if not exists public.ubsi_accounts (
  telegram_user_id bigint primary key,
  user_id uuid references public.profiles(id) on delete set null,
  nim text not null,
  encrypted_password text not null,
  full_name text,
  prodi text,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.ubsi_accounts enable row level security;

create policy "Service role manage ubsi accounts"
  on public.ubsi_accounts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
```
