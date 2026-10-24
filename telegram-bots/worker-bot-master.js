/**
 * USRC BOT MASTER v2.0 (Hub / DM Frontdesk & Academic Assistant)
 * Menangani:
 * 1. Private Chat (DM) untuk /start, pilihan password (sama/beda), dan /login
 * 2. Cek Status Tagihan & Biaya Kuliah (/tagihan) dari SIAKAD
 * 3. Smart Name Fallback (nama Telegram jika SIAKAD belum sinkron)
 * 4. Hapus pesan kredensial otomatis (deleteMessage) demi keamanan
 * 5. Manajemen mandiri akun: /me, /setnama, /logout
 * 6. Push Notification Scheduler (Cloudflare Cron Trigger) pengingat tugas MyBest
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('USRC Master Bot v2.0 Active', { status: 200 });
    }

    // Security (SEC-03): hanya terima webhook asli dari Telegram.
    // Set secret ini via setWebhook(secret_token) dan env Worker TELEGRAM_SECRET_TOKEN.
    const tgSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!env.TELEGRAM_SECRET_TOKEN || tgSecret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const botToken = env.BOT_TOKEN_MASTER;
      const backendUrl = (env.BACKEND_URL || 'https://ubsi-api-production.up.railway.app').replace(/\/$/, '');
      // Security (SEC-07): tanpa fallback — env kosong wajib fail fast, bukan pakai key publik.
      const apiKey = env.BACKEND_API_KEY;
      if (!apiKey) throw new Error('BACKEND_API_KEY environment variable is required');
      const supabaseUrl = env.SUPABASE_URL || 'https://wagvbmkimpswiidnenwx.supabase.co';
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

      // ── 1. TANGANI INTERAKSI TOMBOL (CALLBACK QUERY) ──
      if (update.callback_query) {
        const query = update.callback_query;
        const cbData = query.data;
        const chatId = query.message?.chat?.id || query.from.id;

        if (cbData === 'login_same_pass') {
          await answerCallback(botToken, query.id, "Mode: Password Sama");
          const text = 
            "🟢 *LOGIN: Password SIAKAD & MyBest SAMA*\n\n" +
            "Ketik perintah:\n" +
            "`/login <NIM> <PASSWORD>`\n\n" +
            "Contoh:\n" +
            "`/login 15260124 Rahasia123`\n\n" +
            "🔒 _Pesan kredensialmu akan otomatis dihapus oleh bot demi privasi._";
          await sendTelegram(botToken, chatId, text);
          return new Response('OK', { status: 200 });
        }

        if (cbData === 'login_diff_pass') {
          await answerCallback(botToken, query.id, "Mode: Password Berbeda");
          const text = 
            "🟡 *LOGIN: Password SIAKAD & MyBest BERBEDA*\n\n" +
            "Ketik perintah dengan 2 password berurutan:\n" +
            "`/login <NIM> <PASSWORD_MYBEST> <PASSWORD_SIAKAD>`\n\n" +
            "Contoh:\n" +
            "`/login 15260124 PassMybest123 PassSiakad456`\n\n" +
            "📌 *Keterangan:*\n" +
            "• Password MyBest: untuk presensi & e-learning\n" +
            "• Password SIAKAD: untuk jadwal kuliah, nilai, tagihan & identitas nama\n\n" +
            "🔒 _Pesan kredensialmu akan otomatis dihapus oleh bot demi privasi._";
          await sendTelegram(botToken, chatId, text);
          return new Response('OK', { status: 200 });
        }

        if (cbData === 'cek_tagihan') {
          await answerCallback(botToken, query.id, "Mengambil data tagihan...");
          await handleCekTagihan(botToken, chatId, supabaseUrl, supabaseKey, backendUrl, apiKey);
          return new Response('OK', { status: 200 });
        }

        if (cbData === 'toggle_notif') {
          await answerCallback(botToken, query.id, "Memperbarui preferensi notifikasi...");
          await handleToggleNotif(botToken, chatId, supabaseUrl, supabaseKey);
          return new Response('OK', { status: 200 });
        }

        if (cbData === 'cek_me') {
          await answerCallback(botToken, query.id);
          await handleMe(botToken, chatId, supabaseUrl, supabaseKey);
          return new Response('OK', { status: 200 });
        }

        await answerCallback(botToken, query.id);
        return new Response('OK', { status: 200 });
      }

      // ── 2. TANGANI PESAN TEKS (MESSAGE) ──
      if (!update.message) return new Response('OK', { status: 200 });

      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();
      const isPrivate = msg.chat.type === 'private';

      // Hanya layani chat pribadi (DM)
      if (!isPrivate) {
        return new Response('OK', { status: 200 });
      }

      // Perintah /start
      if (text.startsWith('/start')) {
        const acc = await getStudentAccount(supabaseUrl, supabaseKey, chatId);

        if (acc) {
          const welcomeText = 
            `🎓 *Selamat Datang Kembali, ${acc.full_name || 'Mahasiswa'}!*\n\n` +
            `• *NIM:* \`${acc.nim}\`\n` +
            `• *Prodi:* ${acc.prodi || '-'}\n\n` +
            `Gunakan menu cepat di bawah ini untuk mengakses layanan akademik kampusmu:`;

          const replyMarkup = {
            inline_keyboard: [
              [
                { text: "💰 Cek Tagihan & Biaya", callback_data: "cek_tagihan" },
                { text: "👤 Info Akun", callback_data: "cek_me" }
              ],
              [
                { text: "🔔 Pengaturan Notifikasi", callback_data: "toggle_notif" }
              ]
            ]
          };

          await sendTelegram(botToken, chatId, welcomeText, null, replyMarkup);
          return new Response('OK', { status: 200 });
        }

        const welcomeText = 
          "🎓 *Halo Mahasiswa USRC!*\n\n" +
          "Aku adalah *Bot Master USRC v2.0* — pusat kendali dan akun akademik kampusmu.\n\n" +
          "Sebelum menghubungkan akun, apakah password portal *SIAKAD* (`students.bsi.ac.id`) dan *MyBest* (`elearning.bsi.ac.id`) kamu sama atau berbeda?\n\n" +
          "Pilih salah satu tombol di bawah untuk melihat format login:";

        const replyMarkup = {
          inline_keyboard: [
            [
              { text: "🟢 Password Sama", callback_data: "login_same_pass" },
              { text: "🟡 Password Berbeda", callback_data: "login_diff_pass" }
            ]
          ]
        };

        await sendTelegram(botToken, chatId, welcomeText, null, replyMarkup);
        return new Response('OK', { status: 200 });
      }

      // Perintah /tagihan atau /keuangan
      if (text.startsWith('/tagihan') || text.startsWith('/keuangan') || text.startsWith('/spp')) {
        await handleCekTagihan(botToken, chatId, supabaseUrl, supabaseKey, backendUrl, apiKey);
        return new Response('OK', { status: 200 });
      }

      // Perintah /notif
      if (text.startsWith('/notif')) {
        await handleToggleNotif(botToken, chatId, supabaseUrl, supabaseKey);
        return new Response('OK', { status: 200 });
      }

      // Perintah /me atau /status
      if (text.startsWith('/me') || text.startsWith('/status')) {
        await handleMe(botToken, chatId, supabaseUrl, supabaseKey);
        return new Response('OK', { status: 200 });
      }

      // Perintah /ingat — mesin waktu dari arsip ghost log
      if (text.startsWith('/ingat')) {
        await handleIngat(botToken, chatId, supabaseUrl, supabaseKey, text);
        return new Response('OK', { status: 200 });
      }

      // Perintah /cek — verifikasi resi anti-rekayasa
      if (text.startsWith('/cek')) {
        await handleCekResi(botToken, chatId, supabaseUrl, supabaseKey, text);
        return new Response('OK', { status: 200 });
      }

      // Perintah /setnama <Nama Lengkap>
      if (text.startsWith('/setnama')) {
        const newName = text.replace(/^\/setnama/, '').trim();
        if (!newName) {
          await sendTelegram(botToken, chatId, "⚠️ Format salah! Gunakan:\n`/setnama <Nama Lengkap Anda>`\nContoh:\n`/setnama Ita Puspita`");
          return new Response('OK', { status: 200 });
        }

        try {
          const updateRes = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?telegram_user_id=eq.${chatId}`, {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify({
              full_name: newName,
              updated_at: new Date().toISOString()
            })
          });

          if (!updateRes.ok) throw new Error("Gagal memperbarui database.");
          await sendTelegram(botToken, chatId, `✅ *Nama Tampilan Diperbarui!*\n\nNama aktifmu sekarang: *${newName}*`);
        } catch (err) {
          await sendTelegram(botToken, chatId, `⚠️ Gagal memperbarui nama: ${err.message}`);
        }
        return new Response('OK', { status: 200 });
      }

      // Perintah /logout
      if (text.startsWith('/logout')) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?telegram_user_id=eq.${chatId}`, {
            method: 'DELETE',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            }
          });
          await sendTelegram(botToken, chatId, "👋 *Akun Telah Dihapus dari Sistem USRC.*\n\nKredensialmu sudah dibersihkan. Ketik `/start` kapan pun kamu ingin menghubungkan akun kembali.");
        } catch (err) {
          await sendTelegram(botToken, chatId, `⚠️ Gagal logout: ${err.message}`);
        }
        return new Response('OK', { status: 200 });
      }

      // Perintah /login <nim> <pw_mybest> [pw_siakad]
      if (text.startsWith('/login')) {
        // Hapus pesan pengguna segera agar password tidak tertinggal di layar Telegram
        await deleteTelegramMessage(botToken, chatId, msg.message_id);

        const parts = text.split(/\s+/);
        if (parts.length < 3) {
          await sendTelegram(botToken, chatId, 
            "⚠️ *Format Salah!*\n\n" +
            "• Jika Password Sama:\n`/login <NIM> <PASSWORD>`\n\n" +
            "• Jika Password Berbeda:\n`/login <NIM> <PW_MYBEST> <PW_SIAKAD>`\n\n" +
            "Contoh:\n`/login 15260124 Rahasia123`"
          );
          return new Response('OK', { status: 200 });
        }

        const nim = parts[1].trim();
        let pwMybest = parts[2].trim();
        let pwSiakad = parts.length >= 4 ? parts.slice(3).join(' ').trim() : pwMybest;

        await sendTelegram(botToken, chatId, "⏳ *Sedang memverifikasi kredensial ke sistem kampus...*");

        // 1. Verifikasi SIAKAD (untuk profil & nama lengkap)
        let sv2Ok = false;
        let studentName = null;
        let prodi = "-";

        const sv2Res = await safeFetchJson(`${backendUrl}/v1/studentv2/profile`, {
          headers: {
            'X-API-Key': apiKey,
            'X-StudentV2-NIM': nim,
            'X-StudentV2-Pass': pwSiakad,
            'X-Nim': nim,
            'X-Pass': pwSiakad,
          }
        });

        if (sv2Res.ok && sv2Res.data && sv2Res.data.success && sv2Res.data.data) {
          sv2Ok = true;
          studentName = sv2Res.data.data.nama || sv2Res.data.data.full_name;
          prodi = sv2Res.data.data.program_studi || sv2Res.data.data.prodi || "-";
        }

        // 2. Verifikasi MyBest (untuk absensi & perkuliahan)
        let elOk = false;
        const elRes = await safeFetchJson(`${backendUrl}/v1/elearning/courses`, {
          headers: {
            'X-API-Key': apiKey,
            'X-Elearning-NIM': nim,
            'X-Elearning-Pass': pwMybest,
            'X-Nim': nim,
            'X-Pass': pwMybest,
          }
        });

        if (elRes.ok && elRes.data && elRes.data.success) {
          elOk = true;
        }

        // Jika kedua portal gagal diverifikasi
        if (!sv2Ok && !elOk) {
          await sendTelegram(
            botToken, 
            chatId, 
            "❌ *Verifikasi Gagal!*\n\n" +
            "NIM atau Password tidak cocok dengan portal kampus, atau server kampus sedang down.\n\n" +
            "Pastikan akun MyBest (`elearning.bsi.ac.id`) atau SIAKAD (`students.bsi.ac.id`) kamu dapat login secara normal."
          );
          return new Response('OK', { status: 200 });
        }

        // 3. Smart Name Fallback: Jika SIAKAD gagal/kosong, ambil nama Telegram
        if (!studentName || studentName === "Mahasiswa" || studentName.trim() === "") {
          const tgName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim();
          studentName = tgName || `Mahasiswa (${nim})`;
        }

        // 4. Encrypt passwords securely via backend (Fernet AES) — fail closed (SEC-04)
        let encMybest = null;
        let encSiakad = null;
        try {
          const encRes = await fetch(`${backendUrl}/v1/auth/encrypt-account`, {
            method: 'POST',
            headers: {
              'X-API-Key': apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              elearning_pass: pwMybest,
              studentv2_pass: pwSiakad
            })
          });
          if (encRes.ok) {
            const encJson = await encRes.json();
            if (encJson.data) {
              encMybest = encJson.data.encrypted_elearning;
              encSiakad = encJson.data.encrypted_siakad;
            }
          }
        } catch (e) {
          // fail closed: JANGAN pernah simpan plaintext ke Supabase
        }

        if (!encMybest || !encSiakad) {
          await sendTelegram(botToken, chatId, "⚠️ Gagal mengamankan kredensial kampus (layanan enkripsi sedang tidak tersedia). Coba lagi beberapa saat.");
          return new Response('OK', { status: 200 });
        }

        // 5. Simpan ke Supabase tabel ubsi_accounts
        try {
          const accountPayload = {
            telegram_user_id: chatId,
            nim: nim,
            encrypted_password: encMybest,
            siakad_password: encSiakad,
            full_name: studentName,
            prodi: prodi,
            is_active: true,
            updated_at: new Date().toISOString()
          };

          let upsertRes = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts`, {
            method: 'POST',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ ...accountPayload, notifications_enabled: true })
          });

          // Fallback jika kolom notifications_enabled belum ada di Supabase
          if (!upsertRes.ok) {
            upsertRes = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts`, {
              method: 'POST',
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
              },
              body: JSON.stringify(accountPayload)
            });
          }

          if (!upsertRes.ok) {
            const errText = await upsertRes.text();
            throw new Error(`Gagal menyimpan ke database Supabase: ${errText}`);
          }

          const responseText = 
            `✅ *Akun Berhasil Terhubung!*\n\n` +
            `• *Nama:* ${studentName}\n` +
            `• *NIM:* \`${nim}\`\n` +
            `• *Prodi:* ${prodi}\n\n` +
            `*Status Layanan Kampus:*\n` +
            `${elOk ? '• MyBest (E-Learning & Absen): 🟢 Aktif' : '• MyBest (E-Learning & Absen): 🔴 Password Salah / Gagal'}\n` +
            `${sv2Ok ? '• SIAKAD (Jadwal, Nilai & Profil): 🟢 Aktif' : '• SIAKAD (Jadwal, Nilai & Profil): 🟡 Belum Sinkron (Gunakan opsi password berbeda jika beda)'}\n\n` +
            `🔔 _Notifikasi deadline tugas aktif secara otomatis._\n` +
            `💡 _Kamu bisa mengganti nama tampilan kapan saja dengan perintah:_\n\`/setnama <Nama Baru>\``;

          const replyMarkup = {
            inline_keyboard: [
              [
                { text: "💰 Cek Tagihan Kuliah", callback_data: "cek_tagihan" },
                { text: "👤 Info Akun", callback_data: "cek_me" }
              ]
            ]
          };

          await sendTelegram(botToken, chatId, responseText, null, replyMarkup);
        } catch (dbErr) {
          await sendTelegram(botToken, chatId, `⚠️ Gagal menyimpan akun ke database USRC: ${dbErr.message}`);
        }

        return new Response('OK', { status: 200 });
      }

      // Perintah tidak dikenal di DM
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "💰 Cek Tagihan", callback_data: "cek_tagihan" },
            { text: "👤 Info Akun", callback_data: "cek_me" }
          ]
        ]
      };
      await sendTelegram(
        botToken, 
        chatId, 
        "Ketik `/start` untuk menu utama, `/tagihan` untuk cek status biaya, `/me` untuk informasi akun, atau `/notif` untuk atur pengingat.",
        null,
        replyMarkup
      );
      return new Response('OK', { status: 200 });

    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  },

  // ── 3. SCHEDULER PUSH NOTIFICATION (Cloudflare Cron Trigger) ──
  async scheduled(event, env, ctx) {
    try {
      const botToken = env.BOT_TOKEN_MASTER;
      const backendUrl = (env.BACKEND_URL || 'https://ubsi-api-production.up.railway.app').replace(/\/$/, '');
      const apiKey = env.BACKEND_API_KEY || 'usrc_secret_2026';
      const supabaseUrl = env.SUPABASE_URL || 'https://wagvbmkimpswiidnenwx.supabase.co';
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

      if (!botToken || !supabaseKey) return;

      // Ambil daftar akun aktif
      const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?is_active=eq.true&select=*`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      const accounts = await res.json();
      if (!Array.isArray(accounts) || accounts.length === 0) return;

      for (const acc of accounts) {
        if (acc.notifications_enabled === false) continue;

        try {
          const assignRes = await fetch(`${backendUrl}/v1/elearning/assignments`, {
            headers: {
              'X-API-Key': apiKey,
              'X-Elearning-NIM': acc.nim,
              'X-Elearning-Pass': acc.encrypted_password,
              'X-Nim': acc.nim,
              'X-Pass': acc.encrypted_password,
            }
          });
          const assignData = await assignRes.json();
          if (!assignData.success || !assignData.data || !assignData.data.tasks) continue;

          // Tugas yang sudah dikumpulkan via GDrive tidak perlu diingatkan lagi
          let doneTokens = new Set();
          try {
            const subRes = await fetch(`${supabaseUrl}/rest/v1/ubsi_task_submissions?nim=eq.${encodeURIComponent(acc.nim)}&status=eq.submitted&select=token_tugas`, {
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            const subs = await subRes.json();
            if (Array.isArray(subs)) doneTokens = new Set(subs.map(s => s.token_tugas));
          } catch (_) {}

          const pendingTasks = assignData.data.tasks.filter(t =>
            t.token_tugas && !doneTokens.has(t.token_tugas)
          );

          if (pendingTasks.length > 0) {
            let notifText =
              `⏰ *PENGINGAT TUGAS MYBEST (${acc.full_name || 'Mahasiswa'})*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Ada *${pendingTasks.length} tugas aktif* yang belum dikumpulkan:\n\n`;

            pendingTasks.slice(0, 3).forEach((t, i) => {
              notifText += `${i + 1}. *${t.kode || 'Mata Kuliah'}*\n` +
                          `   📌 Tugas: ${t.judul || 'Tugas Kuliah'}\n` +
                          `   ⏳ Batas: ${t.selesai || '-'}\n\n`;
            });

            notifText += `_Buka Topik Gudang & E-Learning atau ketik /tugas untuk unduh & kumpul tugas!_ 🤍`;

            await sendTelegram(botToken, acc.telegram_user_id, notifText);
          }
        } catch (_) {
          // Lanjut ke akun berikutnya
        }
      }
    } catch (_) {}
  }
};

// ── HANDLER FUNCTIONS ──

async function handleCekTagihan(botToken, chatId, supabaseUrl, supabaseKey, backendUrl, apiKey) {
  const acc = await getStudentAccount(supabaseUrl, supabaseKey, chatId);
  if (!acc) {
    await sendTelegram(botToken, chatId, "🔒 Fitur cek tagihan memerlukan login. Ketik `/start` terlebih dahulu.");
    return;
  }

  const pwSiakad = acc.siakad_password || acc.encrypted_password;
  await sendTelegram(botToken, chatId, "⏳ *Mengambil status tagihan & biaya kuliah dari SIAKAD...*");

  try {
    const profRes = await safeFetchJson(`${backendUrl}/v1/studentv2/profile`, {
      headers: {
        'X-API-Key': apiKey,
        'X-StudentV2-NIM': acc.nim,
        'X-StudentV2-Pass': pwSiakad,
        'X-Nim': acc.nim,
        'X-Pass': pwSiakad,
      }
    });

    if (!profRes.ok || !profRes.data || !profRes.data.success) {
      throw new Error(profRes.data?.error?.message || "Gagal membuka data profil SIAKAD.");
    }

    const p = profRes.data.data || {};
    const nama = p.nama || acc.full_name || "Mahasiswa";
    const nim = p.nim || acc.nim;
    const prodi = p.program_studi || acc.prodi || "-";
    const sem = p.semester_aktif || "-";
    const statusKuliah = p.status_aktif || "Aktif";
    const kondisiBiaya = p.kondisi_biaya_kuliah || "Terverifikasi / Lunas";

    const isLunas = kondisiBiaya.toLowerCase().includes("lunas") || kondisiBiaya.toLowerCase().includes("bebas");

    const message = 
      `💳 *STATUS KEUANGAN & BIAYA KULIAH*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Nama:* ${nama}\n` +
      `🆔 *NIM:* \`${nim}\`\n` +
      `🎓 *Prodi:* ${prodi}\n` +
      `📅 *Semester Aktif:* ${sem}\n` +
      `📌 *Status Akademik:* ${statusKuliah}\n\n` +
      `💰 *Kondisi Biaya Kuliah:*\n` +
      `• *Status:* ${isLunas ? '🟢' : '🟡'} *${kondisiBiaya}*\n` +
      `• *Akses Ujian (UTS/UAS):* ${isLunas ? '✅ Diizinkan' : '⚠️ Selesaikan kewajiban adm'}\n\n` +
      `_Data tersinkronisasi langsung dari database SIAKAD BSI._ 🤍`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "🔄 Muat Ulang", callback_data: "cek_tagihan" },
          { text: "👤 Info Akun", callback_data: "cek_me" }
        ]
      ]
    };

    await sendTelegram(botToken, chatId, message, null, replyMarkup);
  } catch (err) {
    await sendTelegram(botToken, chatId, `⚠️ Gagal membaca status keuangan: ${err.message}\nPastikan password SIAKAD Anda sudah sesuai.`);
  }
}

async function handleToggleNotif(botToken, chatId, supabaseUrl, supabaseKey) {
  const acc = await getStudentAccount(supabaseUrl, supabaseKey, chatId);
  if (!acc) {
    await sendTelegram(botToken, chatId, "🔒 Login terlebih dahulu dengan mengetik `/start`.");
    return;
  }

  const currentNotif = acc.notifications_enabled !== false;
  const newStatus = !currentNotif;

  try {
    await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?telegram_user_id=eq.${chatId}`, {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        notifications_enabled: newStatus,
        updated_at: new Date().toISOString()
      })
    });

    const statusMsg = newStatus 
      ? "🔔 *Notifikasi Pengingat Tugas DIAKTIFKAN!*\n\nBot Master akan secara otomatis mengirimkan pesan pengingat ke DM jika ada tugas MyBest yang mendekati tenggat."
      : "🔕 *Notifikasi Pengingat Tugas DINONAKTIFKAN.*\n\nKamu tidak akan menerima pesan pengingat otomatis berkala.";

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: newStatus ? "🔕 Matikan Notifikasi" : "🔔 Aktifkan Notifikasi", callback_data: "toggle_notif" }
        ]
      ]
    };

    await sendTelegram(botToken, chatId, statusMsg, null, replyMarkup);
  } catch (err) {
    await sendTelegram(botToken, chatId, `⚠️ Gagal mengubah preferensi: ${err.message}`);
  }
}

async function handleMe(botToken, chatId, supabaseUrl, supabaseKey) {
  try {
    const acc = await getStudentAccount(supabaseUrl, supabaseKey, chatId);
    if (!acc) {
      await sendTelegram(botToken, chatId, "⚠️ Kamu belum menghubungkan akun kampus.\nKetik `/start` untuk panduan login.");
      return;
    }

    const hasSiakad = !!acc.siakad_password;
    const notifStatus = acc.notifications_enabled !== false ? '🟢 Aktif' : '🔴 Nonaktif';
    const statusText = 
      "👤 *INFORMASI AKUN KAMPUS TERHUBUNG*\n\n" +
      `• *Nama:* ${acc.full_name || 'Mahasiswa'}\n` +
      `• *NIM:* \`${acc.nim}\`\n` +
      `• *Prodi:* ${acc.prodi || '-'}\n` +
      `• *Status MyBest:* 🟢 Terhubung\n` +
      `• *Status SIAKAD:* ${hasSiakad ? '🟢 Terhubung' : '🟡 Sama dengan MyBest'}\n` +
      `• *Push Notifikasi:* ${notifStatus}\n\n` +
      "Gunakan `/setnama <Nama Lengkap>` jika ingin mengganti nama tampilan, atau `/logout` untuk memutus akun.";

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "💰 Cek Tagihan Kuliah", callback_data: "cek_tagihan" },
          { text: "🔔 Atur Notifikasi", callback_data: "toggle_notif" }
        ]
      ]
    };

    await sendTelegram(botToken, chatId, statusText, null, replyMarkup);
  } catch (err) {
    await sendTelegram(botToken, chatId, `⚠️ Gagal membaca data akun: ${err.message}`);
  }
}

// ── HELPER FUNCTIONS ──

async function getStudentAccount(supabaseUrl, supabaseKey, telegramUserId) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?telegram_user_id=eq.${telegramUserId}&select=*`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });
    const accounts = await res.json();
    return (accounts && accounts.length > 0) ? accounts[0] : null;
  } catch (_) {
    return null;
  }
}

async function safeFetchJson(url, options) {
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) };
    } catch (_) {
      return { ok: false, status: res.status, raw: text };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function sendTelegram(token, chatId, text, threadId = null, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  };
  if (threadId) payload.message_thread_id = threadId;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function answerCallback(token, callbackQueryId, text = null) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;

  return await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function deleteTelegramMessage(token, chatId, messageId) {
  try {
    return await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (_) {}
}

// ── MESIN WAKTU: cari jejak di arsip ghost log (grup melupakan, bot mengingat) ──
async function handleIngat(botToken, chatId, supabaseUrl, supabaseKey, text) {
  const kwRaw = text.replace(/^\/ingat(@\w+)?/, '').trim();
  try {
    let url;
    const kw = encodeURIComponent(kwRaw);
    if (kwRaw && /^\d+$/.test(kwRaw)) {
      url = `${supabaseUrl}/rest/v1/ubsi_ghost_log?or=(command.ilike.*${kw}*,detail.ilike.*${kw}*,user_name.ilike.*${kw}*,nim.eq.${kwRaw})&order=created_at.desc&limit=10`;
    } else if (kwRaw) {
      url = `${supabaseUrl}/rest/v1/ubsi_ghost_log?or=(command.ilike.*${kw}*,detail.ilike.*${kw}*,user_name.ilike.*${kw}*)&order=created_at.desc&limit=10`;
    } else {
      url = `${supabaseUrl}/rest/v1/ubsi_ghost_log?order=created_at.desc&limit=10`;
    }

    const res = await fetch(url, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const rows = await res.json().catch(() => []);

    if (!Array.isArray(rows) || rows.length === 0) {
      await sendTelegram(botToken, chatId, kwRaw
        ? `🧠 Mesin Waktu: tidak ada jejak *"${kwRaw}"* di arsip. Arsipnya bersih.`
        : `🧠 Arsip masih kosong — belum ada aktivitas yang menguap dari grup.`);
      return;
    }

    let out = kwRaw
      ? `🧠 *MESIN WAKTU — jejak "${kwRaw}" (${rows.length}):*\n\n`
      : `🧠 *MESIN WAKTU — 10 aktivitas terakhir:*\n\n`;
    rows.forEach(r => {
      const t = r.created_at ? new Date(r.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Pontianak' }) : '-';
      out += `• ${t} WIB — *${r.user_name || '-'}*${r.nim ? ` (${r.nim})` : ""}\n`;
      out += `  \`${r.command || "-"}\` → ${r.outcome || "-"}\n`;
      if (r.detail) out += `  ${r.detail}\n`;
    });
    out += `\n_Grup melupakan, bot mengingat._ 🤍`;
    await sendTelegram(botToken, chatId, out);
  } catch (err) {
    await sendTelegram(botToken, chatId, `⚠️ Gagal membuka arsip: ${err.message}`);
  }
}

// ── VERIFIKASI RESI: bukti kumpul/absen anti-rekayasa ──
async function handleCekResi(botToken, chatId, supabaseUrl, supabaseKey, text) {
  const kode = text.replace(/^\/cek(@\w+)?/, '').trim().toUpperCase();
  if (!kode) {
    await sendTelegram(botToken, chatId, "🧾 Kirim kode resi yang mau diverifikasi:\n`/cek KMP-7F3A`");
    return;
  }
  if (!/^(KMP|ABS)-[A-Z0-9]{4}$/.test(kode)) {
    await sendTelegram(botToken, chatId,
      `⚠️ Format resi tidak dikenal: \`${kode}\`\nContoh yang benar: \`KMP-7F3A\` (kumpul tugas) atau \`ABS-9QX2\` (absen).`);
    return;
  }
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_receipts?code=ilike.${kode}&select=*`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const rows = await res.json().catch(() => []);
    const r = Array.isArray(rows) ? rows[0] : null;

    if (!r) {
      await sendTelegram(botToken, chatId,
        `❌ *Resi \`${kode}\` TIDAK ditemukan* di sistem USRC.\nHati-hati: bukti yang dipegang bisa jadi bukan asli.`);
      return;
    }

    const t = r.created_at ? new Date(r.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Pontianak' }) : '-';
    await sendTelegram(botToken, chatId,
      `✅ *RESI TERVERIFIKASI ASLI*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🧾 Kode: \`${r.code}\`\n` +
      `📌 Jenis: *${r.type === 'kumpul' ? 'Pengumpulan Tugas' : 'Presensi'}*\n` +
      `👤 ${r.full_name || '-'} (${r.nim || '-'})\n` +
      `📝 ${r.summary || '-'}\n` +
      `📅 ${t} WIB\n\n` +
      `_Bukti ini sah dan tercatat permanen._ 🤍`);
  } catch (err) {
    await sendTelegram(botToken, chatId, `⚠️ Gagal memverifikasi resi: ${err.message}`);
  }
}
