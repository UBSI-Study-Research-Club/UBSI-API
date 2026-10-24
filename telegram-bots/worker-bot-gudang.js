/**
 * USRC BOT GUDANG MATERI v3.0 (Perpustakaan, Repository, Materi, & Ruang Tugas MyBest)
 * Menangani di Topik Grup (Thread ID: 7) & DM:
 * 1. /buku <kata kunci>     -> Katalog OPAC Perpustakaan BSI
 * 2. /cari <kata kunci>     -> Skripsi / TA di EPrints Repository BSI (portal baru, AJAX+token)
 * 3. /jurnal                -> Katalog e-journal resmi kampus
 * 4. /materi <kata kunci>   -> Slide/PDF materi MyBest (judul=judul, URL absolut)
 * 5. /tugas                 -> Daftar tugas valid (nama matkul, deadline, status GDrive/MyBest) + tombol soal (short_id)
 * 6. /kumpul <token> <link_gdrive> [catatan] -> Pengumpulan tugas via Google Drive (wajib link)
 *
 * V4 "Topik Terkunci" (pola sama dengan Bot Absen V2):
 * - /pasang (admin) -> menu pin 4 tombol + tutup topik; /buka untuk maintenance
 * - Semua konten (list/file/hasil cari) -> DM via bot ini; notif gagal/status -> flash 10 detik
 * - Tombol: gd_materi, gd_matkul_<sid>, dl_mat_<sid>, gd_tugas, gd_buku, gd_riset,
 *   gd_cari, gd_jurnal, kumpul_btn_<sid> (sid = ubsi_short_map, lihat sql-gudang-short-map.sql)
 * - Kumpul 2 langkah: klik tombol -> balas DM bot dengan link GDrive (tanpa ketik token)
 * - Resi KMP tetap + salinan resi ke DM Bot Master (env BOT_TOKEN_MASTER, opsional)
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('USRC Gudang Materi Bot v3.0 Active', { status: 200 });
    }

    // Security (SEC-03): hanya terima webhook asli dari Telegram (setWebhook secret_token).
    const tgSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!env.TELEGRAM_SECRET_TOKEN || tgSecret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const botToken = env.BOT_TOKEN_GUDANG;
      const backendUrl = (env.BACKEND_URL || 'https://ubsi-api-production.up.railway.app').replace(/\/$/, '');
      // Security (SEC-07): tanpa fallback — env kosong wajib fail fast.
      const apiKey = env.BACKEND_API_KEY;
      if (!apiKey) throw new Error('BACKEND_API_KEY environment variable is required');
      const supabaseUrl = env.SUPABASE_URL || 'https://wagvbmkimpswiidnenwx.supabase.co';
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
      const datacenterChatId = env.DATACENTER_CHAT_ID || '';
      const masterBotToken = env.BOT_TOKEN_MASTER || '';

      // ── 1. TANGANI TOMBOL KLIK (Callback Query) ──
      if (update.callback_query) {
        const query = update.callback_query;
        const cbData = query.data;
        const userId = query.from.id;
        const userName = query.from.first_name || "Mahasiswa";
        const chatId = query.message?.chat?.id || userId;
        const threadId = query.message?.message_thread_id || null;

        // Satpam topik 7
        const isGroup = query.message?.chat?.type === 'group' || query.message?.chat?.type === 'supergroup';
        if (isGroup && Number(threadId) !== 7) {
          await answerCallback(botToken, query.id, "Fitur ini hanya aktif di Topik Gudang Materi!");
          return new Response('OK', { status: 200 });
        }

        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
        if (!acc) {
          await answerCallback(botToken, query.id, "Akun belum terhubung! Silakan login di DM Bot Master.");
          return new Response('OK', { status: 200 });
        }

        if (cbData === "btn_list_tugas" || cbData === "gd_tugas") {
          await answerCallback(botToken, query.id, "Mengambil daftar tugas aktif...");
          await handleListTugas(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, {
            dmUserId: userId, userName, datacenterChatId, ctx,
          });
          if (String(chatId) !== String(userId)) {
            sendFlash(ctx, botToken, chatId, threadId, `📋 *${userName}*, daftar tugas dikirim ke DM kamu (Bot Gudang).`);
          }
          return new Response('OK', { status: 200 });
        }

        // dl_soal_<short_id 10 hex> (total 18 byte, aman di bawah batas 64 byte Telegram)
        if (cbData.startsWith("dl_soal_")) {
          const sid = cbData.replace("dl_soal_", "");
          await answerCallback(botToken, query.id, "Mengunduh berkas soal tugas...");
          const linkRes = await safeFetchJson(`${backendUrl}/v1/elearning/soal-map/${sid}`, {
            headers: { 'X-API-Key': apiKey }
          });
          const fileUrl = linkRes.ok && linkRes.data?.data?.url;
          if (!fileUrl) {
            await sendTelegram(botToken, chatId, `⚠️ ${linkRes.data?.error?.message || "Daftar tugas kedaluwarsa, ketik /tugas untuk muat ulang."}`, threadId);
            return new Response('OK', { status: 200 });
          }
          await handleDownloadFile(botToken, chatId, threadId, acc, backendUrl, apiKey, fileUrl, datacenterChatId, "Soal Tugas");
          return new Response('OK', { status: 200 });
        }

        // ── V4: SHORT MAP CALLBACKS (matkul / file materi / kumpul) ──
        if (cbData.startsWith("gd_matkul_") || cbData.startsWith("dl_mat_") || cbData.startsWith("kumpul_btn_")) {
          const sid = cbData.replace(/^gd_matkul_|^dl_mat_|^kumpul_btn_/, "");
          const val = await getShortMap(supabaseUrl, supabaseKey, sid);
          if (!val) {
            await answerCallback(botToken, query.id, "Referensi kedaluwarsa — buka ulang menunya ya.");
            return new Response('OK', { status: 200 });
          }

          // kumpul_btn_<sid>: kirim prompt kumpul ke DM (balas dengan link GDrive)
          if (cbData.startsWith("kumpul_btn_")) {
            await answerCallback(botToken, query.id, "Siap! Lanjut di DM ya.");
            const prompt =
              `📤 *KUMPUL TUGAS*\n` +
              `🔑 Token: \`${val}\`\n\n` +
              `Balas (reply) pesan ini dengan *link Google Drive* jawabanmu.\n` +
              `Pastikan akses file *"Anyone with the link"* supaya dosen bisa membuka.`;
            const dm = await sendTelegram(botToken, userId, prompt);
            if ((!dm || !dm.ok) && String(chatId) !== String(userId)) {
              sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
            }
            return new Response('OK', { status: 200 });
          }

          // gd_matkul_<sid>: val = "<token_learning>|||<nama matkul>" -> daftar file materi ke DM
          if (cbData.startsWith("gd_matkul_")) {
            await answerCallback(botToken, query.id, "Mengambil daftar materi...");
            const sep = val.indexOf("|||");
            const courseToken = sep >= 0 ? val.slice(0, sep) : val;
            const courseName = sep >= 0 ? val.slice(sep + 3) : "Mata Kuliah";

            const mRes = await safeFetchJson(`${backendUrl}/v1/elearning/materials?token=${encodeURIComponent(courseToken)}`, {
              headers: {
                'X-API-Key': apiKey,
                'X-Elearning-NIM': acc.nim,
                'X-Elearning-Pass': acc.encrypted_password,
                'X-Nim': acc.nim,
                'X-Pass': acc.encrypted_password,
              }
            });
            const files = [];
            collectFileUrls(mRes.data ? mRes.data.data : null, courseName, files);

            if (files.length === 0) {
              await sendTelegram(botToken, userId, `📭 Matkul *${courseName}* belum punya file materi di MyBest.`);
              if (String(chatId) !== String(userId)) {
                sendFlash(ctx, botToken, chatId, threadId, `📭 Matkul *${courseName}* belum punya materi — info dikirim ke DM.`);
              }
              return new Response('OK', { status: 200 });
            }

            const shown = files.slice(0, 8);
            const mapped = await saveShortMap(supabaseUrl, supabaseKey, shown.map(f => f.url), "file", userId);
            const rows = [];
            shown.forEach((f, i) => {
              if (mapped[i]) rows.push([{ text: `📄 ${String(f.title).slice(0, 40)}`, callback_data: `dl_mat_${mapped[i].sid}` }]);
            });
            const dm = await sendTelegram(botToken, userId, `📚 *${courseName}*\nPilih file materi:`, null, { inline_keyboard: rows });
            if ((!dm || !dm.ok) && String(chatId) !== String(userId)) {
              sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
            }
            return new Response('OK', { status: 200 });
          }

          // dl_mat_<sid>: val = URL file -> kirim PDF ke chat tempat tombol berada (DM)
          await answerCallback(botToken, query.id, "Mengunduh materi...");
          const ok = await handleDownloadFile(botToken, chatId, threadId, acc, backendUrl, apiKey, val, datacenterChatId, "Materi Kuliah");
          if (!ok) {
            await sendTelegram(botToken, chatId, `⚠️ Gagal mengirim file (server kampus sibuk?). Coba lagi sebentar ya.`, threadId);
          }
          return new Response('OK', { status: 200 });
        }

        // ── V4: MENU GUDANG (dari pesan pin / menu DM) ──
        const originTopic = String(chatId) !== String(userId);

        if (cbData === "gd_materi") {
          await answerCallback(botToken, query.id, "Mengambil daftar matkul...");
          const cRes = await safeFetchJson(`${backendUrl}/v1/elearning/courses`, {
            headers: {
              'X-API-Key': apiKey,
              'X-Elearning-NIM': acc.nim,
              'X-Elearning-Pass': acc.encrypted_password,
              'X-Nim': acc.nim,
              'X-Pass': acc.encrypted_password,
            }
          });
          const courses = ((cRes.data && cRes.data.data) || []).filter(c => c.token_learning).slice(0, 8);
          if (courses.length === 0) {
            sendFlash(ctx, botToken, chatId, threadId, `📭 Tidak ada matkul aktif dengan materi di MyBest-mu.`);
            return new Response('OK', { status: 200 });
          }
          const mapped = await saveShortMap(
            supabaseUrl, supabaseKey,
            courses.map(c => `${c.token_learning}|||${c.nama || c.matakuliah || c.name || c.kode || "Mata Kuliah"}`),
            "matkul", userId
          );
          const rows = [];
          courses.forEach((c, i) => {
            if (mapped[i]) {
              const nama = (c.nama || c.matakuliah || c.name || c.kode || "Mata Kuliah");
              rows.push([{ text: `📚 ${String(nama).slice(0, 32)}`, callback_data: `gd_matkul_${mapped[i].sid}` }]);
            }
          });
          const dm = await sendTelegram(botToken, userId, `📚 *MATERI KULIAH MYBEST*\nPilih matkul:`, null, { inline_keyboard: rows });
          if (dm && dm.ok) {
            if (originTopic) sendFlash(ctx, botToken, chatId, threadId, `📚 *${userName}*, daftar matkul dikirim ke DM kamu.`);
          } else if (originTopic) {
            sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
          }
          return new Response('OK', { status: 200 });
        }

        if (cbData === "gd_buku") {
          await answerCallback(botToken, query.id, "Mode cari buku siap!");
          const dm = await sendTelegram(botToken, userId,
            `📖 *CARI BUKU PERPUSTAKAAN*\n\nBalas (reply) pesan ini dengan *judul buku* yang kamu cari.\nContoh: pemrograman web`
          );
          if (dm && dm.ok) {
            if (originTopic) sendFlash(ctx, botToken, chatId, threadId, `📖 *${userName}*, balas pesan di DM dengan judul bukunya.`);
          } else if (originTopic) {
            sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
          }
          return new Response('OK', { status: 200 });
        }

        if (cbData === "gd_riset") {
          await answerCallback(botToken, query.id, "Portal riset siap!");
          const dm = await sendTelegram(botToken, userId,
            `🎓 *PORTAL RISET USRC*\nPilih:`,
            null,
            { inline_keyboard: [
              [{ text: "🔍 Cari Skripsi / TA", callback_data: "gd_cari" }],
              [{ text: "📑 Katalog Jurnal Kampus", callback_data: "gd_jurnal" }],
            ] }
          );
          if (dm && dm.ok) {
            if (originTopic) sendFlash(ctx, botToken, chatId, threadId, `🎓 *${userName}*, portal riset dikirim ke DM kamu.`);
          } else if (originTopic) {
            sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
          }
          return new Response('OK', { status: 200 });
        }

        if (cbData === "gd_cari") {
          await answerCallback(botToken, query.id, "Mode riset siap!");
          const dm = await sendTelegram(botToken, userId,
            `🎓 *CARI SKRIPSI / TA*\n\nBalas (reply) pesan ini dengan *topik penelitian* yang kamu cari.\nContoh: sistem pakar`
          );
          if (dm && dm.ok) {
            if (originTopic) sendFlash(ctx, botToken, chatId, threadId, `🎓 *${userName}*, balas pesan di DM dengan topik risetmu.`);
          } else if (originTopic) {
            sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
          }
          return new Response('OK', { status: 200 });
        }

        if (cbData === "gd_jurnal") {
          await answerCallback(botToken, query.id, "Mengambil katalog jurnal...");
          try {
            const res = await fetch(`${backendUrl}/v1/ejournal/journals`, { headers: { 'X-API-Key': apiKey } });
            const json = await res.json();
            if (!json.success || !json.data || json.data.length === 0) {
              await sendTelegram(botToken, userId, `📑 Belum ada katalog jurnal yang terdaftar.`);
              return new Response('OK', { status: 200 });
            }
            const rows = [];
            json.data.slice(0, 8).forEach(j => {
              if (j.url && /^https:\/\//i.test(j.url)) {
                rows.push([{ text: `📑 ${String(j.name || j.title || "Jurnal").slice(0, 32)}`, url: j.url }]);
              }
            });
            const dm = await sendTelegram(botToken, userId, `📑 *KATALOG E-JOURNAL OJS UBSI*\nKlik untuk membuka portal:`, null, { inline_keyboard: rows });
            if (dm && dm.ok) {
              if (originTopic) sendFlash(ctx, botToken, chatId, threadId, `📑 *${userName}*, katalog jurnal dikirim ke DM kamu.`);
            } else if (originTopic) {
              sendFlash(ctx, botToken, chatId, threadId, `⚠️ *${userName}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
            }
          } catch (err) {
            sendFlash(ctx, botToken, chatId, threadId, `❌ Gagal mengambil e-journal: ${err.message}`);
          }
          return new Response('OK', { status: 200 });
        }

        // Konfirmasi pengumpulan GDrive
        if (cbData.startsWith("kumpul_ok_") || cbData.startsWith("kumpul_no_")) {
          const subId = cbData.replace("kumpul_ok_", "").replace("kumpul_no_", "");
          if (!/^\d+$/.test(subId)) {
            await answerCallback(botToken, query.id);
            return new Response('OK', { status: 200 });
          }

          if (cbData.startsWith("kumpul_no_")) {
            await fetch(`${supabaseUrl}/rest/v1/ubsi_task_submissions?id=eq.${subId}`, {
              method: 'DELETE',
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            await answerCallback(botToken, query.id, "Dibatalkan.");
            await sendTelegram(botToken, chatId, "❌ *Pengumpulan dibatalkan.* Tidak ada data yang tersimpan.", threadId);
            await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
              bot: "gudang", chat_id: chatId, thread_id: threadId,
              user_id: userId, user_name: userName, nim: acc ? acc.nim : null,
              command: "kumpul_no", detail: `batal konfirmasi submission #${subId}`, outcome: "cancelled"
            });
            return new Response('OK', { status: 200 });
          }

          // Ambil data submission lalu konfirmasi
          const rowRes = await safeFetchJson(`${supabaseUrl}/rest/v1/ubsi_task_submissions?id=eq.${subId}&select=*`, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
          });
          const row = Array.isArray(rowRes.data) ? rowRes.data[0] : null;
          if (!row) {
            await answerCallback(botToken, query.id, "Data tidak ditemukan.");
            return new Response('OK', { status: 200 });
          }

          await fetch(`${supabaseUrl}/rest/v1/ubsi_task_submissions?id=eq.${subId}`, {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'submitted', confirmed_at: new Date().toISOString() })
          });

          await answerCallback(botToken, query.id, "Tugas terkumpul!");

          // Resi anti-rekayasa (kegagalan tabel tidak memutus alur)
          const resiCode = await saveReceipt(supabaseUrl, supabaseKey, {
            code: genCode("KMP"), type: "kumpul",
            user_id: row.telegram_user_id || userId, nim: row.nim,
            full_name: row.full_name || userName,
            summary: `Kumpul "${row.judul_tugas || row.token_tugas}" ${row.is_late ? "(TERLAMBAT)" : "(tepat waktu)"}`,
            ref_id: Number(subId),
          });

          // Transaksi berhasil → hapus pesan preview + command asli
          const pvRes = await safeFetchJson(
            `${supabaseUrl}/rest/v1/ubsi_ephemeral_msgs?kind=eq.kumpul_preview&ref_id=eq.${subId}&select=*`,
            { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
          );
          const pvRow = Array.isArray(pvRes.data) ? pvRes.data[0] : null;
          if (pvRow) {
            await deleteMessage(botToken, chatId, pvRow.message_id);
            if (pvRow.cmd_msg_id) await deleteMessage(botToken, chatId, pvRow.cmd_msg_id);
            await fetch(`${supabaseUrl}/rest/v1/ubsi_ephemeral_msgs?id=eq.${pvRow.id}`, {
              method: 'DELETE',
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            }).catch(() => {});
          }

          await sendTelegram(
            botToken, chatId,
            `🎉 *TUGAS BERHASIL DIKUMPULKAN (GOOGLE DRIVE)*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Mahasiswa:* ${row.full_name || userName} (\`${row.nim}\`)\n` +
            `📌 *Tugas:* ${row.judul_tugas || row.token_tugas}\n` +
            `🔑 *Token:* \`${row.token_tugas}\`\n` +
            `🔗 *Link:* ${row.drive_link}\n` +
            (row.catatan ? `💬 *Catatan:* ${row.catatan}\n` : "") +
            (row.is_late ? `⚠️ *Status: TERLAMBAT (melewati deadline)*\n` : `✅ *Status: TEPAT WAKTU*\n`) +
            (resiCode ? `🧾 *Resi:* \`${resiCode}\` _(verifikasi: /cek ${resiCode} ke Bot Master)_\n` : "") +
            `\n_Bukti pengumpulan tercatat permanen di sistem USRC._ 🤍`,
            threadId,
            { inline_keyboard: [[{ text: "🔄 Cek Tugas Lagi", callback_data: "re_tugas" }]] }
          );

          // V4: salinan resi resmi ke DM Bot Master (kalau konfirmasi terjadi di topik)
          if (masterBotToken && String(chatId) !== String(userId)) {
            await sendTelegram(masterBotToken, userId,
              `🧾 *RESI PENGUMPULAN TUGAS*\n` +
              `📌 *Tugas:* ${row.judul_tugas || row.token_tugas}\n` +
              (row.is_late ? `⚠️ Status: TERLAMBAT\n` : `✅ Status: TEPAT WAKTU\n`) +
              (resiCode ? `🧾 *Resi:* \`${resiCode}\` _(verifikasi: /cek ${resiCode})_` : "")
            ).catch(() => {});
          }

          // Arsip ke DATACENTER USRC
          if (datacenterChatId) {
            await sendTelegram(botToken, datacenterChatId,
              `📥 *ARSIP PENGUMPULAN TUGAS (GDRIVE)*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `👤 ${row.full_name || '-'} (${row.nim})\n` +
              `📌 ${row.judul_tugas || '-'}\n` +
              `🔑 Token: ${row.token_tugas}\n` +
              `🔗 ${row.drive_link}\n` +
              `💬 ${row.catatan || '-'}\n` +
              `⏰ ${row.is_late ? 'TERLAMBAT' : 'TEPAT WAKTU'}\n` +
              `🧾 Resi: ${resiCode || '-'}\n` +
              `📅 ${new Date().toISOString()}`
            ).catch(() => {});
          }

          await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
            bot: "gudang", chat_id: chatId, thread_id: threadId,
            user_id: row.telegram_user_id || userId, user_name: row.full_name || userName,
            nim: row.nim, command: "kumpul_ok",
            detail: `${row.judul_tugas || row.token_tugas} — resi ${resiCode || "-"}`,
            outcome: "success"
          });
          return new Response('OK', { status: 200 });
        }

        // Tombol ajaib: muat ulang daftar tugas pribadi ke DM
        if (cbData === "re_tugas") {
          await answerCallback(botToken, query.id, "Memuat daftar tugas terbaru...");
          const accR = await getStudentAccount(supabaseUrl, supabaseKey, userId);
          if (!accR) {
            await sendTelegram(botToken, chatId, "🔒 Akun belum terhubung. Login dulu di DM *Bot Master*.", threadId);
            return new Response('OK', { status: 200 });
          }
          await runTugasPersonal(botToken, chatId, threadId, accR, backendUrl, apiKey, supabaseUrl, supabaseKey, datacenterChatId, {
            userName, userId, cmdMsgId: null,
            srcMessageId: query.message.chat.type === "private" ? query.message.message_id : null
          });
          return new Response('OK', { status: 200 });
        }

        await answerCallback(botToken, query.id);
        return new Response('OK', { status: 200 });
      }

      // ── 2. TANGANI PESAN (MESSAGE) ──
      if (!update.message) return new Response('OK', { status: 200 });

      const msg = update.message;
      const chatId = msg.chat.id;
      const threadId = msg.message_thread_id || null;
      const text = (msg.text || '').trim();
      const userId = msg.from.id;
      const userName = msg.from.first_name || "Mahasiswa";

      // ── KUNCI SATPAM TOPIK GUDANG MATERI (Thread ID: 7) ──
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      if (isGroup && Number(threadId) !== 7) {
        return new Response('Ignored out-of-topic message', { status: 200 });
      }

      // ── V4: /pasang (admin) — menu pin + tutup topik ──
      if (isGroup && text.startsWith('/pasang')) {
        if (!(await isAdmin(botToken, chatId, userId))) {
          sendFlash(ctx, botToken, chatId, threadId, `⛔ Perintah ini khusus admin.`);
          return new Response('OK', { status: 200 });
        }
        const sent = await sendTelegram(botToken, chatId, GD_MENU_TEXT, threadId, GD_MENU_KEYBOARD);
        if (sent && sent.ok && sent.result && sent.result.message_id) {
          await tgApi(botToken, "pinChatMessage", {
            chat_id: chatId, message_id: sent.result.message_id, disable_notification: true
          });
        }
        await tgApi(botToken, "closeForumTopic", { chat_id: chatId, message_thread_id: 7 });
        await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
          bot: "gudang", chat_id: chatId, thread_id: threadId,
          user_id: userId, user_name: userName, nim: null,
          command: "/pasang", detail: "menu gudang dipin + topik ditutup", outcome: "success"
        });
        return new Response('OK', { status: 200 });
      }

      // ── V4: /buka (admin) — buka topik untuk maintenance ──
      if (isGroup && text.startsWith('/buka')) {
        if (!(await isAdmin(botToken, chatId, userId))) {
          sendFlash(ctx, botToken, chatId, threadId, `⛔ Perintah ini khusus admin.`);
          return new Response('OK', { status: 200 });
        }
        await tgApi(botToken, "reopenForumTopic", { chat_id: chatId, message_thread_id: 7 });
        await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
          bot: "gudang", chat_id: chatId, thread_id: threadId,
          user_id: userId, user_name: userName, nim: null,
          command: "/buka", detail: "topik gudang dibuka", outcome: "success"
        });
        return new Response('OK', { status: 200 });
      }

      // ── V4: REPLY FLOW DI DM (kumpul via link, cari buku, cari skripsi) ──
      const rep = msg.reply_to_message;
      if (!isGroup && rep && rep.from && rep.from.is_bot && rep.text) {
        const rt = rep.text;

        // Balasan prompt kumpul: ambil token dari pesan prompt, validasi link
        if (rt.includes("KUMPUL TUGAS")) {
          const tm = rt.match(/🔑\s*Token:\s*`?([A-Za-z0-9._-]+)`?/);
          const link = text;
          if (tm && /^https:\/\/(drive|docs)\.google\.com\//i.test(link)) {
            const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
            if (!acc) {
              await sendTelegram(botToken, chatId, "🔒 Akun MyBest belum terhubung. Login dulu di DM *Bot Master*.");
              return new Response('OK', { status: 200 });
            }
            // Jalur sama dengan /kumpul: preview + konfirmasi, jejak command dibersihkan otomatis
            await handleKumpulGDrive(botToken, chatId, null, acc, backendUrl, apiKey, supabaseUrl, supabaseKey,
              `/kumpul ${tm[1]} ${link}`, userName, datacenterChatId, msg.message_id);
            return new Response('OK', { status: 200 });
          }
          if (tm) {
            await sendTelegram(botToken, chatId,
              `⚠️ *Link tidak valid!* Kirim link langsung Google Drive (\`https://drive.google.com/...\`)\nJangan lupa akses *"Anyone with the link"*.`
            );
            return new Response('OK', { status: 200 });
          }
        }

        // Balasan prompt cari buku (OPAC publik — tanpa perlu akun MyBest)
        if (rt.includes("CARI BUKU") && text) {
          const lm = await sendTelegram(botToken, chatId, `📚 Mencari buku "${text.slice(0, 60)}" di OPAC...`);
          await bukuSearchCore(backendUrl, apiKey, botToken, chatId, null, text, lm && lm.result ? lm.result.message_id : null);
          return new Response('OK', { status: 200 });
        }

        // Balasan prompt cari skripsi (repositori publik — tanpa perlu akun MyBest)
        if (rt.includes("CARI SKRIPSI") && text) {
          const lm = await sendTelegram(botToken, chatId, `🎓 Mencari riset "${text.slice(0, 60)}" di repositori...`);
          await cariSearchCore(backendUrl, apiKey, botToken, chatId, null, text, lm && lm.result ? lm.result.message_id : null);
          return new Response('OK', { status: 200 });
        }
      }

      // ── A. PERINTAH KUMPUL TUGAS VIA GOOGLE DRIVE ──
      if (text.startsWith('/kumpul')) {
        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
        if (!acc) {
          await sendTelegram(botToken, chatId, "🔒 Pengumpulan tugas memerlukan akun MyBest. Login dulu di DM *Bot Master*.", threadId);
          return new Response('OK', { status: 200 });
        }

        // Info upload file lama -> arahkan ke GDrive
        if (msg.document) {
          await sendTelegram(
            botToken, chatId,
            "⚠️ *Metode upload file via Telegram sudah diganti.*\n\nSekarang pengumpulan wajib menggunakan **link Google Drive**:\n`/kumpul <token_tugas> <link_gdrive> [catatan]`",
            threadId
          );
          return new Response('OK', { status: 200 });
        }

        await handleKumpulGDrive(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, text, userName, datacenterChatId, msg.message_id);
        return new Response('OK', { status: 200 });
      }

      // ── B. RUANG TUGAS MYBEST (/tugas) ──
      if (text.startsWith('/tugas')) {
        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
        if (!acc) {
          await sendTelegram(botToken, chatId, "🔒 Ruang tugas memerlukan akun MyBest. Login dulu di DM *Bot Master* dengan `/login <NIM> <PASSWORD>`.", threadId);
          return new Response('OK', { status: 200 });
        }

        // Personal ke DM; command + loading dihapus saat berhasil (lihat handleListTugas)
        await runTugasPersonal(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, datacenterChatId, {
          userName, userId, cmdMsgId: msg.message_id, srcMessageId: null, ctx
        });
        return new Response('OK', { status: 200 });
      }

      // ── C. CARI BUKU PERPUSTAKAAN OPAC (/buku <keyword>) ──
      if (text.startsWith('/buku')) {
        const query = text.replace(/^\/buku(@\w+)?/, '').trim();
        if (!query) {
          await sendTelegram(botToken, chatId, "📚 *Perpustakaan BSI*\n\nKetik `/buku <kata kunci judul buku>`\nContoh: `/buku pemrograman web`", threadId);
          return new Response('OK', { status: 200 });
        }

        await bukuSearchCore(backendUrl, apiKey, botToken, chatId, threadId, query, null, { dmUserId: userId, userName, ctx });
        return new Response('OK', { status: 200 });
      }

      // ── D. CARI SKRIPSI / TA / MAKALAH EPRINTS (/cari <keyword>) ──
      if (text.startsWith('/cari')) {
        const query = text.replace(/^\/cari(@\w+)?/, '').trim();
        if (!query) {
          await sendTelegram(botToken, chatId, "🎓 *Repositori Skripsi & Riset USRC*\n\nKetik `/cari <kata kunci penelitian>`\nContoh: `/cari sistem pakar` atau `/cari machine learning`", threadId);
          return new Response('OK', { status: 200 });
        }

        await cariSearchCore(backendUrl, apiKey, botToken, chatId, threadId, query, null, { dmUserId: userId, userName, ctx });
        return new Response('OK', { status: 200 });
      }

      // ── E. KATALOG JURNAL ILMIAH (/jurnal) ──
      if (text.startsWith('/jurnal')) {
        try {
          const res = await fetch(`${backendUrl}/v1/ejournal/journals`, {
            headers: { 'X-API-Key': apiKey }
          });
          const json = await res.json();

          if (!json.success || !json.data || json.data.length === 0) {
            await sendTelegram(botToken, chatId, "⚠️ Belum ada katalog jurnal yang terdaftar.", threadId);
            return new Response('OK', { status: 200 });
          }

          let out = `📑 *KATALOG E-JOURNAL OJS UBSI:*\n\n`;
          json.data.slice(0, 6).forEach((j, idx) => {
            out += `${idx + 1}. *${j.name || j.title}*\n   🔗 [Kunjungi Portal](${j.url})\n\n`;
          });

          await sendTelegram(botToken, chatId, out, threadId);
        } catch (err) {
          await sendTelegram(botToken, chatId, `❌ Gagal mengambil e-journal: ${err.message}`, threadId);
        }

        return new Response('OK', { status: 200 });
      }

      // ── F. SLIDE MATERI MYBEST (/materi <keyword>) ──
      if (text.startsWith('/materi')) {
        const query = text.replace(/^\/materi(@\w+)?/, '').trim().toLowerCase();
        if (!query) {
          await sendTelegram(botToken, chatId, "📗 *Materi Kuliah MyBest*\n\nKetik `/materi <kata kunci>`\nContoh: `/materi basis data`\n\nFile PDF langsung dikirim ke sini + diarsipkan di DATACENTER USRC.", threadId);
          return new Response('OK', { status: 200 });
        }

        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
        if (!acc) {
          await sendTelegram(botToken, chatId, "🔒 Materi butuh akun MyBest. Login dulu di DM *Bot Master* dengan `/login <NIM> <PASSWORD>`.", threadId);
          return new Response('OK', { status: 200 });
        }

        const statusMsg = await sendTelegram(botToken, chatId, `🔍 Mencari materi "${query}" di MyBest...`, threadId);
        const statusMsgId = statusMsg && statusMsg.result ? statusMsg.result.message_id : null;

        try {
          const cRes = await fetch(`${backendUrl}/v1/elearning/courses`, {
            headers: {
              'X-API-Key': apiKey,
              'X-Elearning-NIM': acc.nim,
              'X-Elearning-Pass': acc.encrypted_password,
              'X-Nim': acc.nim,
              'X-Pass': acc.encrypted_password,
            }
          });
          const cJson = await cRes.json();
          const courses = (cJson.data || []).filter(c => c.token_learning);

          const files = [];
          for (const c of courses.slice(0, 8)) {
            const courseName = c.nama || c.matakuliah || c.name || c.kode || "Matkul";
            try {
              const mRes = await fetch(`${backendUrl}/v1/elearning/materials?token=${encodeURIComponent(c.token_learning)}`, {
                headers: {
                  'X-API-Key': apiKey,
                  'X-Elearning-NIM': acc.nim,
                  'X-Elearning-Pass': acc.encrypted_password,
                  'X-Nim': acc.nim,
                  'X-Pass': acc.encrypted_password,
                }
              });
              const mJson = await mRes.json();
              collectFileUrls(mJson.data, courseName, files);
            } catch (e) {}
          }

          const matches = files.filter(f => f.title.toLowerCase().includes(query));
          if (matches.length === 0) {
            if (statusMsgId) await deleteMessage(botToken, chatId, statusMsgId);
            await sendTelegram(botToken, chatId, `⚠️ Tidak ada materi yang cocok dengan "${query}". Coba kata kunci lain.`, threadId);
            return new Response('OK', { status: 200 });
          }

          if (statusMsgId) await deleteMessage(botToken, chatId, statusMsgId);
          await sendTelegram(botToken, chatId, `📗 Ditemukan ${matches.length} materi. Mengirim berkas...`, threadId);

          let sent = 0;
          for (const f of matches.slice(0, 3)) {
            const ok = await handleDownloadFile(botToken, chatId, threadId, acc, backendUrl, apiKey, f.url, datacenterChatId, f.title, f.course);
            if (ok) sent++;
          }

          if (sent === 0) {
            await sendTelegram(botToken, chatId, "⚠️ Materi ditemukan tapi gagal dikirim sebagai file.", threadId);
          }

        } catch (err) {
          if (statusMsgId) await deleteMessage(botToken, chatId, statusMsgId);
          await sendTelegram(botToken, chatId, `❌ Gagal mencari materi: ${err.message}`, threadId);
        }
        return new Response('OK', { status: 200 });
      }

      // Menu default topik
      if (text.startsWith('/menu') || text.startsWith('/start')) {
        const menuText =
          "📚 *GUDANG MATERI & RUANG TUGAS USRC v3.0*\n\n" +
          "Akses seluruh pustaka akademik dan tugas E-Learning MyBest langsung dari Telegram:\n\n" +
          "• `/tugas` — Daftar tugas aktif + status pengumpulan\n" +
          "• `/kumpul <token> <link_gdrive> [catatan]` — Kumpul tugas via Google Drive\n" +
          "• `/materi <keyword>` — Unduh slide kuliah MyBest\n" +
          "• `/buku <keyword>` — Cari buku katalog OPAC\n" +
          "• `/cari <keyword>` — Riset & skripsi EPrints\n" +
          "• `/jurnal` — Daftar e-journal kampus";

        const replyMarkup = {
          inline_keyboard: [
            [
              { text: "📚 Materi", callback_data: "gd_materi" },
              { text: "📝 Tugas", callback_data: "gd_tugas" }
            ],
            [
              { text: "📖 Buku", callback_data: "gd_buku" },
              { text: "🎓 Riset", callback_data: "gd_riset" }
            ]
          ]
        };

        await sendTelegram(botToken, chatId, menuText, threadId, replyMarkup);
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });

    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  }
};

// ── HANDLER FUNCTIONS ──

function parseDeadline(selesaiStr) {
  if (!selesaiStr) return null;
  // Format umum MyBest: "YYYY-MM-DD HH:MM:SS" (atau dengan detik terpotong)
  const m = String(selesaiStr).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}+07:00`);
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(String(selesaiStr).replace(" ", "T") + "+07:00");
  return isNaN(fallback.getTime()) ? null : fallback;
}

async function handleListTugas(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, opts = {}) {
  try {
    const credHeaders = {
      'X-API-Key': apiKey,
      'X-Elearning-NIM': acc.nim,
      'X-Elearning-Pass': acc.encrypted_password,
      'X-Nim': acc.nim,
      'X-Pass': acc.encrypted_password,
    };

    const [asgRes, crsRes] = await Promise.all([
      safeFetchJson(`${backendUrl}/v1/elearning/assignments`, { headers: credHeaders }),
      safeFetchJson(`${backendUrl}/v1/elearning/courses`, { headers: credHeaders }),
    ]);

    if (!asgRes.ok || !asgRes.data?.success) {
      throw new Error(asgRes.data?.error?.message || `Gagal membuka data ruang tugas (${asgRes.status || "timeout"}).`);
    }

    const tasks = asgRes.data?.data?.tasks || [];
    const subs = asgRes.data?.data?.submissions || [];
    const courses = (crsRes.ok && crsRes.data?.data) || [];

    // Map kode matkul -> nama matkul
    const courseMap = {};
    courses.forEach(c => {
      if (c.kode) courseMap[String(c.kode).toUpperCase()] = c.nama || c.matakuliah || c.name || null;
    });

    // Status GDrive dari tabel submission USRC (abaikan error bila tabel belum dibuat)
    let gdriveMap = {};
    try {
      const gRes = await safeFetchJson(
        `${supabaseUrl}/rest/v1/ubsi_task_submissions?nim=eq.${encodeURIComponent(acc.nim)}&status=eq.submitted&select=token_tugas`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
      );
      if (gRes.ok && Array.isArray(gRes.data)) {
        gdriveMap = Object.fromEntries(gRes.data.map(r => [r.token_tugas, true]));
      }
    } catch (_) {}

    if (tasks.length === 0) {
      // Sukses (0 tugas): bersihkan jejak di grup, kabar pribadi ke DM
      if (opts.cmdMsgId) await deleteMessage(botToken, chatId, opts.cmdMsgId);
      if (opts.loadingMsgId) await deleteMessage(botToken, chatId, opts.loadingMsgId);
      const emptyText = "🎉 *Tidak ada tugas aktif di MyBest saat ini.* Waktunya santai atau riset!";
      if (opts.dmUserId) {
        const dm = await sendTelegram(botToken, opts.dmUserId, emptyText);
        if (dm && dm.ok) {
          sendFlash(opts.ctx, botToken, chatId, threadId, `📋 *${opts.userName || "Kamu"}*, tidak ada tugas aktif — detail dikirim ke DM kamu.`);
          await ghostLog(supabaseUrl, supabaseKey, opts.datacenterChatId, botToken, {
            bot: "gudang", chat_id: chatId, thread_id: threadId,
            user_id: opts.dmUserId, user_name: opts.userName, nim: acc.nim,
            command: opts.srcMessageId ? "re_tugas" : "/tugas", detail: "0 tugas aktif → DM", outcome: "success"
          });
          return;
        }
      }
      await sendTelegram(botToken, chatId, emptyText, threadId);
      return;
    }

    // Tandai status tiap tugas + urutkan berdasarkan deadline terdekat
    const enriched = tasks.map(t => {
      const deadline = parseDeadline(t.selesai);
      const doneGDrive = !!gdriveMap[t.token_tugas];
      const doneMyBest = subs.some(s => s.kode === t.kode && s.judul === t.judul);
      return { ...t, deadline, doneGDrive, doneMyBest };
    }).sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    // Daftarkan URL soal ke backend -> short_id (callback_data ≤64 byte)
    const soalUrls = enriched.map(t => t.file_soal_url).filter(Boolean).slice(0, 6);
    let soalMap = {};
    if (soalUrls.length > 0) {
      const mapRes = await safeFetchJson(`${backendUrl}/v1/elearning/soal-map`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: soalUrls })
      });
      if (mapRes.ok && mapRes.data?.data?.map) soalMap = mapRes.data.data.map;
    }

    // V4: token tugas yang belum dikumpul -> short map (tombol kumpul 2 langkah)
    const kumpulTokens = enriched
      .filter(t => !t.doneGDrive && !t.doneMyBest && t.token_tugas)
      .map(t => t.token_tugas)
      .slice(0, 6);
    let kumpulSidMap = {};
    if (kumpulTokens.length > 0) {
      const kMap = await saveShortMap(supabaseUrl, supabaseKey, kumpulTokens, "kumpul", opts.dmUserId || null);
      kMap.forEach(e => { kumpulSidMap[e.val] = e.sid; });
    }

    let out = `📝 *DAFTAR TUGAS E-LEARNING AKTIF (${enriched.length} Tugas)*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    const keyboardRows = [];

    enriched.slice(0, 6).forEach((t, i) => {
      const matkul = courseMap[String(t.kode || "").toUpperCase()] || t.kode || "Mata Kuliah";
      let statusLine;
      if (t.doneGDrive) statusLine = "✅ Dikumpulkan via GDrive";
      else if (t.doneMyBest) statusLine = "✅ Terkumpul (tercatat MyBest)";
      else statusLine = "❌ Belum dikumpulkan";

      let deadlineLine = "⏳ *Batas:* -";
      if (t.deadline) {
        const sisaMs = t.deadline - Date.now();
        const sisaJam = Math.floor(sisaMs / 3600000);
        if (sisaMs < 0) deadlineLine = `⏳ *Batas:* ${t.selesai} (🔴 lewat)`;
        else if (sisaJam < 24) deadlineLine = `⏳ *Batas:* ${t.selesai} 🔥 *(${sisaJam} jam lagi!)*`;
        else deadlineLine = `⏳ *Batas:* ${t.selesai}`;
      }

      out += `*${i + 1}. ${matkul}*\n`;
      out += `   📌 *Tugas:* ${t.judul || "Tugas Pertemuan"}${t.kelas ? ` (Kelas ${t.kelas})` : ""}\n`;
      out += `   ${deadlineLine}\n`;
      out += `   📊 *Status:* ${statusLine}\n`;
      if (t.token_tugas) out += `   🔑 *Token:* \`${t.token_tugas}\`\n`;
      out += `\n`;

      const sid = soalMap[t.file_soal_url];
      if (sid) keyboardRows.push([{ text: `📥 Soal #${i + 1}`, callback_data: `dl_soal_${sid}` }]);
      const ks = kumpulSidMap[t.token_tugas];
      if (ks) keyboardRows.push([{ text: `📤 Kumpul #${i + 1}`, callback_data: `kumpul_btn_${ks}` }]);
    });

    out += `━━━━━━━━━━━━━━━━━━━━\n` +
           `📤 *Cara Kumpul Tugas:*\n` +
           `Klik tombol 📤 *Kumpul* di atas, lalu balas DM bot dengan link Google Drive jawabanmu (akses *"Anyone with the link"*).\n` +
           `_Atau tetap bisa manual:_ \`/kumpul <token> <link> [catatan]\` 🤍`;

    keyboardRows.push([{ text: "🔁 Muat Ulang", callback_data: "re_tugas" }]);
    const replyMarkup = { inline_keyboard: keyboardRows };

    // Refresh edit-in-place (dari tombol 🔁 Muat Ulang di DM)
    if (opts.srcMessageId && opts.dmUserId) {
      const ed = await tgApi(botToken, "editMessageText", {
        chat_id: opts.dmUserId, message_id: opts.srcMessageId,
        text: out, parse_mode: "Markdown", reply_markup: replyMarkup
      });
      if (ed.ok) return;
      // gagal edit (pesan terlalu tua / tidak berubah) → lanjut kirim baru
    }

    // Sukses: hapus jejak di grup (command + loading), hasil personal ke DM
    if (opts.cmdMsgId) await deleteMessage(botToken, chatId, opts.cmdMsgId);
    if (opts.loadingMsgId) await deleteMessage(botToken, chatId, opts.loadingMsgId);

    if (opts.dmUserId) {
      const dm = await sendTelegram(botToken, opts.dmUserId, out, null, replyMarkup);
      if (dm && dm.ok) {
        await sendTelegram(botToken, chatId, `📋 *${opts.userName || "Kamu"}*, daftar tugas (${enriched.length}) terkirim ke DM kamu.`, threadId);
        await ghostLog(supabaseUrl, supabaseKey, opts.datacenterChatId, botToken, {
          bot: "gudang", chat_id: chatId, thread_id: threadId,
          user_id: opts.dmUserId, user_name: opts.userName, nim: acc.nim,
          command: opts.srcMessageId ? "re_tugas" : "/tugas",
          detail: `${enriched.length} tugas aktif → DM`, outcome: "success"
        });
        return;
      }
      // DM gagal (anggota belum /start bot ini) → fallback: tampil di grup
      await ghostLog(supabaseUrl, supabaseKey, opts.datacenterChatId, botToken, {
        bot: "gudang", chat_id: chatId, thread_id: threadId,
        user_id: opts.dmUserId, user_name: opts.userName, nim: acc.nim,
        command: opts.srcMessageId ? "re_tugas" : "/tugas",
        detail: "DM gagal (belum /start), fallback ke grup", outcome: "dm_fallback"
      });
    }
    await sendTelegram(botToken, chatId, out, threadId, replyMarkup);

  } catch (err) {
    // Gagal = biarkan semua pesan tetap ada agar penyebabnya terlihat
    await sendTelegram(botToken, chatId, `⚠️ Gagal memuat daftar tugas: ${err.message}`, threadId);
  }
}

async function handleKumpulGDrive(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, text, userName, datacenterChatId, cmdMsgId) {
  const parts = text.split(/\s+/);
  // /kumpul <token> <link> [catatan...]
  if (parts.length < 3) {
    await sendTelegram(
      botToken, chatId,
      "⚠️ *Format Salah!*\n\n" +
      "`/kumpul <token_tugas> <link_gdrive> [catatan]`\n\n" +
      "*Langkah:*\n" +
      "1️⃣ Upload jawaban ke Google Drive\n" +
      "2️⃣ Klik kanan file → *Bagikan* → ubah ke *\"Anyone with the link\"*\n" +
      "3️⃣ Salin link → kirim dengan format di atas\n\n" +
      "_Lihat token aktif dengan mengetik /tugas._",
      threadId
    );
    await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
      bot: "gudang", chat_id: chatId, thread_id: threadId,
      user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
      command: "/kumpul", detail: "format salah (kurang argumen)", outcome: "failed"
    });
    return;
  }

  const tokenTugas = parts[1].trim();
  const driveLink = parts[2].trim();
  const catatan = parts.slice(3).join(" ") || "-";

  // 1. Validasi link Google Drive
  if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(driveLink)) {
    await sendTelegram(
      botToken, chatId,
      "⚠️ *Link tidak valid!*\n\nWajib link Google Drive (`https://drive.google.com/...`).\nJangan lupa set akses *\"Anyone with the link\"* agar dosen bisa membuka.",
      threadId
    );
    await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
      bot: "gudang", chat_id: chatId, thread_id: threadId,
      user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
      command: "/kumpul", detail: `link tidak valid: ${driveLink}`, outcome: "failed"
    });
    return;
  }

  // 2. Validasi token + deadline
  const credHeaders = {
    'X-API-Key': apiKey,
    'X-Elearning-NIM': acc.nim,
    'X-Elearning-Pass': acc.encrypted_password,
    'X-Nim': acc.nim,
    'X-Pass': acc.encrypted_password,
  };
  const asgRes = await safeFetchJson(`${backendUrl}/v1/elearning/assignments`, { headers: credHeaders });
  const tasks = (asgRes.ok && asgRes.data?.data?.tasks) || [];
  const task = tasks.find(t => t.token_tugas === tokenTugas);

  if (!task) {
    const tokens = tasks.map(t => t.token_tugas).filter(Boolean);
    let hint = "";
    if (tokens.length > 0) hint = `\n\n*Token aktif:*\n${tokens.map(t => `• \`${t}\``).join("\n")}`;
    await sendTelegram(
      botToken, chatId,
      `⚠️ *Token tugas "${tokenTugas}" tidak ditemukan di daftar aktif MyBest.*${hint}\n\n_Cek kembali dengan mengetik /tugas._`,
      threadId
    );
    await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
      bot: "gudang", chat_id: chatId, thread_id: threadId,
      user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
      command: "/kumpul", detail: `token "${tokenTugas}" tidak ditemukan`, outcome: "failed"
    });
    return;
  }

  const deadline = parseDeadline(task.selesai);
  const isLate = deadline ? (Date.now() > deadline.getTime()) : false;

  // 3. Simpan ke Supabase (upsert: kumpul ulang = replace versi terakhir)
  const payload = {
    telegram_user_id: acc.telegram_user_id,
    nim: acc.nim,
    full_name: acc.full_name || userName,
    token_tugas: tokenTugas,
    judul_tugas: task.judul || null,
    drive_link: driveLink,
    catatan: catatan,
    status: 'pending',
    is_late: isLate,
  };

  const upRes = await safeFetchJson(`${supabaseUrl}/rest/v1/ubsi_task_submissions`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(payload)
  });

  if (!upRes.ok) {
    const errMsg = upRes.data?.message || upRes.data?.error?.message || `HTTP ${upRes.status}`;
    const hintTable = /404|not found|schema/i.test(errMsg)
      ? "\n\n_(Tabel ubsi_task_submissions belum ada — jalankan sql-add-task-submissions.sql di Supabase.)_"
      : "";
    await sendTelegram(botToken, chatId, `⚠️ Gagal menyimpan pengumpulan: ${errMsg}${hintTable}`, threadId);
    await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
      bot: "gudang", chat_id: chatId, thread_id: threadId,
      user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
      command: "/kumpul", detail: `gagal simpan: ${errMsg} — token ${tokenTugas}`, outcome: "failed"
    });
    return;
  }

  const row = Array.isArray(upRes.data) ? upRes.data[0] : null;
  const subId = row ? row.id : null;

  // 4. Preview + konfirmasi
  const preview =
    `📋 *KONFIRMASI PENGUMPULAN TUGAS*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *Tugas:* ${task.judul || tokenTugas}\n` +
    `🔑 *Token:* \`${tokenTugas}\`\n` +
    `🔗 *Link:* ${driveLink}\n` +
    `💬 *Catatan:* ${catatan}\n` +
    (deadline ? `⏳ *Deadline:* ${task.selesai}${isLate ? " 🔴 (TERLAMBAT)" : " 🟢 (masih buka)"}\n` : "") +
    `\n_Yakin ingin mengumpulkan?_`;

  const replyMarkup = subId ? {
    inline_keyboard: [[
      { text: "✅ Ya, Kumpulkan Sekarang", callback_data: `kumpul_ok_${subId}` },
      { text: "❌ Batal", callback_data: `kumpul_no_${subId}` }
    ]]
  } : null;

  if (!subId) {
    // Tidak dapat id (mis. duplikat tanpa upsert) -> anggap sukses: bersihkan command, pesan tetap
    if (cmdMsgId) await deleteMessage(botToken, chatId, cmdMsgId);
    await sendTelegram(botToken, chatId, `✅ *Pengumpulan tugas tercatat.* Token: \`${tokenTugas}\``, threadId);
    await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
      bot: "gudang", chat_id: chatId, thread_id: threadId,
      user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
      command: "/kumpul", detail: `tersimpan tanpa id — token ${tokenTugas}`, outcome: "success"
    });
    return;
  }

  const pvSent = await sendTelegram(botToken, chatId, preview, threadId, replyMarkup);

  // Daftarkan preview + command untuk dibersihkan otomatis saat dikonfirmasi
  try {
    await fetch(`${supabaseUrl}/rest/v1/ubsi_ephemeral_msgs`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bot: "gudang", chat_id: chatId, message_id: pvSent?.result?.message_id || 0,
        thread_id: threadId, user_id: acc.telegram_user_id, user_name: userName,
        kind: "kumpul_preview", ref_id: subId, cmd_msg_id: cmdMsgId || null
      })
    });
  } catch (_) {}

  await ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, {
    bot: "gudang", chat_id: chatId, thread_id: threadId,
    user_id: acc.telegram_user_id, user_name: userName, nim: acc.nim,
    command: "/kumpul", detail: `menunggu konfirmasi #${subId} — ${task.judul || tokenTugas}`, outcome: "pending"
  });
}

async function handleDownloadFile(botToken, chatId, threadId, acc, backendUrl, apiKey, fileUrl, datacenterChatId, title = "Dokumen", course = "") {
  try {
    const dlRes = await fetch(`${backendUrl}/v1/elearning/assignments/download?file_url=${encodeURIComponent(fileUrl)}`, {
      headers: {
        'X-API-Key': apiKey,
        'X-Elearning-NIM': acc.nim,
        'X-Elearning-Pass': acc.encrypted_password,
        'X-Nim': acc.nim,
        'X-Pass': acc.encrypted_password,
      }
    });

    if (!dlRes.ok) return false;
    const buf = await dlRes.arrayBuffer();
    if (buf.byteLength < 500) return false;

    const safeTitle = title.replace(/[^\w\s.\-()]/g, '').trim().slice(0, 50) || 'berkas';
    const filename = safeTitle.endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`;

    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (threadId) form.append('message_thread_id', String(threadId));
    form.append('caption', `📄 *${title}*` + (course ? `\n📚 Matkul: ${course}` : "") + `\n\n_Diunduh via USRC Bot Gudang_ 🤍`);
    form.append('document', new Blob([buf], { type: 'application/pdf' }), filename);

    const sd = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form
    });
    const sdJson = await sd.json().catch(() => ({ ok: false }));

    // Auto-Mirror ke DATACENTER USRC
    if (datacenterChatId && sdJson.ok && sdJson.result) {
      await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: datacenterChatId,
          from_chat_id: chatId,
          message_id: sdJson.result.message_id
        })
      });
    }

    return true;
  } catch (_) {
    return false;
  }
}

// ── UTILITY FUNCTIONS ──

function collectFileUrls(node, courseName, out) {
  if (!node) return;
  if (typeof node === 'string') {
    if (/storage\/(soal|tugas|learning)|\.(pdf|pptx?|docx?|zip|rar)(\?|$)/i.test(node)) {
      out.push({ url: node, title: node.split('/').pop() || 'materi', course: courseName });
    }
    return;
  }
  if (Array.isArray(node)) { node.forEach(x => collectFileUrls(x, courseName, out)); return; }
  if (typeof node === 'object') {
    // Backend parse_materials memakai field "judul" (bukan "title")
    let title = null;
    if (typeof node.judul === 'string' && node.judul.trim()) title = node.judul.trim();
    else if (typeof node.title === 'string' && node.title.trim()) title = node.title.trim();
    Object.values(node).forEach(v => {
      if (typeof v === 'string') {
        if (/storage\/(soal|tugas|learning)|\.(pdf|pptx?|docx?|zip|rar)(\?|$)/i.test(v)) {
          out.push({ url: v, title: title || v.split('/').pop() || 'materi', course: courseName });
        }
      } else {
        collectFileUrls(v, courseName, out);
      }
    });
  }
}

async function getStudentAccount(supabaseUrl, supabaseKey, telegramUserId) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_accounts?telegram_user_id=eq.${telegramUserId}&select=*`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });
    const rows = await res.json();
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch {
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

async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  }).catch(() => {});
}

async function sendTelegram(token, chatId, text, threadId = null, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  if (threadId) payload.message_thread_id = threadId;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let j = await resp.json().catch(() => ({ ok: false }));

  // Fallback: kalau Markdown ditolak, kirim polos
  if (!j.ok && payload.parse_mode) {
    delete payload.parse_mode;
    const r2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    j = await r2.json().catch(() => ({ ok: false }));
  }
  return j;
}

async function answerCallback(token, queryId, text = null) {
  const payload = { callback_query_id: queryId };
  if (text) payload.text = text;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function tgApi(token, method, body) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await resp.json().catch(() => ({ ok: false }));
  } catch (_) {
    return { ok: false };
  }
}

// Ghost Log: semua yang menguap dari grup tercatat di Supabase + mirror 1 baris ke DATACENTER
async function ghostLog(supabaseUrl, supabaseKey, datacenterChatId, botToken, entry) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/ubsi_ghost_log`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(entry)
    });
  } catch (_) {}
  if (datacenterChatId && botToken) {
    const line =
      `👻 *GHOST LOG* — ${entry.user_name || "-"}${entry.nim ? ` (${entry.nim})` : ""} • \`${entry.command || "-"}\` • ${entry.outcome || "-"}\n` +
      `${entry.detail || ""}`;
    await sendTelegram(botToken, datacenterChatId, line).catch(() => {});
  }
}

// Kode resi unik (set aman: tanpa I, L, O, 0, 1)
function genCode(prefix) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += chars[b % chars.length];
  return `${prefix}-${s}`;
}

// Simpan resi; kegagalan tabel tidak boleh memutus alur utama
async function saveReceipt(supabaseUrl, supabaseKey, r) {
  if (!r || !r.code) return null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_receipts`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=representation'
      },
      body: JSON.stringify(r)
    });
    if (res.ok) return r.code;
  } catch (_) {}
  return null;
}

// /tugas versi personal: loading di grup, hasil ke DM, jejak dibersihkan saat berhasil
async function runTugasPersonal(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, datacenterChatId, opts = {}) {
  const userName = opts.userName || "Mahasiswa";
  let loadingMsgId = null;
  if (!opts.srcMessageId) {
    const lm = await sendTelegram(botToken, chatId, `⏳ *Mengambil daftar tugas kuliah aktif untuk ${userName}...*`, threadId);
    if (lm && lm.ok && lm.result) loadingMsgId = lm.result.message_id;
  }
  await handleListTugas(botToken, chatId, threadId, acc, backendUrl, apiKey, supabaseUrl, supabaseKey, {
    ...opts,
    loadingMsgId,
    dmUserId: opts.dmUserId || opts.userId || null,
    datacenterChatId
  });
}

// ── V4 HELPERS ──

// FLASH 10 DETIK: kirim status singkat lalu auto-delete (ctx.waitUntil)
const FLASH_SECONDS = 10;

function sendFlash(ctx, token, chatId, threadId, text) {
  return sendTelegram(token, chatId, text, threadId).then(sent => {
    const msgId = sent && sent.result && sent.result.message_id;
    if (msgId) {
      const job = new Promise(r => setTimeout(r, FLASH_SECONDS * 1000))
        .then(() => deleteMessage(token, chatId, msgId));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    }
    return sent;
  });
}

async function isAdmin(token, chatId, userId) {
  if (!userId) return false;
  const res = await tgApi(token, "getChatMember", { chat_id: chatId, user_id: userId });
  const st = res && res.result && res.result.status;
  return st === 'creator' || st === 'administrator';
}

// SHORT MAP: token/URL panjang -> short_id 10 hex (tabel ubsi_short_map, TTL 24 jam)
function genSid() {
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

async function saveShortMap(supabaseUrl, supabaseKey, vals, kind, userId) {
  const now = Date.now();
  const rows = (vals || []).slice(0, 8).map(v => ({
    sid: genSid(), val: String(v), kind,
    user_id: userId || null,
    expires_at: new Date(now + 24 * 3600 * 1000).toISOString()
  }));
  // bersihkan yang kedaluwarsa (opportunistic, biar tabel tetap kurus)
  fetch(`${supabaseUrl}/rest/v1/ubsi_short_map?expires_at=lt.${new Date(now).toISOString()}`, {
    method: 'DELETE',
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
  }).catch(() => {});
  if (rows.length === 0) return [];
  try {
    await fetch(`${supabaseUrl}/rest/v1/ubsi_short_map`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates'
      },
      body: JSON.stringify(rows)
    });
  } catch (_) {}
  return rows.map(r => ({ sid: r.sid, val: r.val }));
}

async function getShortMap(supabaseUrl, supabaseKey, sid) {
  try {
    const res = await safeFetchJson(
      `${supabaseUrl}/rest/v1/ubsi_short_map?sid=eq.${encodeURIComponent(sid)}&select=val,expires_at`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const row = Array.isArray(res.data) ? res.data[0] : null;
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return row.val;
  } catch (_) {
    return null;
  }
}

// MENU PIN GUDANG (4 tombol)
const GD_MENU_TEXT =
  "📚 *GUDANG MATERI & RUANG TUGAS USRC*\n\n" +
  "Topik ini terkunci — cukup tekan tombol:\n" +
  "• List, file & hasil cari dikirim ke *DM bot ini*\n" +
  "• Notif gagal/status muncul 10 detik lalu terhapus sendiri";

const GD_MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📚 Materi", callback_data: "gd_materi" },
      { text: "📝 Tugas", callback_data: "gd_tugas" }
    ],
    [
      { text: "📖 Buku", callback_data: "gd_buku" },
      { text: "🎓 Riset", callback_data: "gd_riset" }
    ]
  ]
};

// CORE: cari buku OPAC (publik) — hasil teks + tombol URL ke DM
async function bukuSearchCore(backendUrl, apiKey, botToken, chatId, threadId, query, loadingMsgId, opts = {}) {
  const target = opts.dmUserId || chatId;
  try {
    const res = await fetch(`${backendUrl}/v1/elibrary/search?q=${encodeURIComponent(query)}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const json = await res.json();
    if (loadingMsgId) await deleteMessage(botToken, chatId, loadingMsgId);

    if (!json.success || !json.data || json.data.length === 0) {
      const msg = `⚠️ Tidak ditemukan buku untuk kata kunci "${query}".`;
      await sendTelegram(botToken, target, msg);
      if (target !== chatId) sendFlash(opts.ctx, botToken, chatId, threadId, msg);
      return;
    }

    const rows = [];
    let out = `📚 *KATALOG OPAC PERPUSTAKAAN BSI:*\n\n`;
    json.data.slice(0, 5).forEach((b, idx) => {
      out += `${idx + 1}. *${b.title}*\n`;
      if (b.author) out += `   ✍️ ${b.author}\n`;
      if (b.year) out += `   📅 ${b.year}\n`;
      out += `\n`;
      if (b.url && /^https:/i.test(b.url)) {
        rows.push([{ text: `📖 ${String(b.title).slice(0, 30)}`, url: b.url }]);
      }
    });
    out += `_Klik tombol untuk membuka katalog buku._`;

    const sent = await sendTelegram(botToken, target, out, null, rows.length ? { inline_keyboard: rows } : null);
    if (sent && sent.ok && target !== chatId) {
      sendFlash(opts.ctx, botToken, chatId, threadId, `📚 *${opts.userName || "Kamu"}*, hasil pencarian buku dikirim ke DM kamu.`);
    } else if ((!sent || !sent.ok) && target !== chatId) {
      sendFlash(opts.ctx, botToken, chatId, threadId, `⚠️ *${opts.userName || "Kamu"}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
    }
  } catch (err) {
    if (loadingMsgId) await deleteMessage(botToken, chatId, loadingMsgId);
    await sendTelegram(botToken, chatId, `❌ Gagal menghubungi perpustakaan: ${err.message}`, threadId);
  }
}

// CORE: cari skripsi/TA EPrints (publik) — hasil teks + tombol URL ke DM
async function cariSearchCore(backendUrl, apiKey, botToken, chatId, threadId, query, loadingMsgId, opts = {}) {
  const target = opts.dmUserId || chatId;
  try {
    const res = await fetch(`${backendUrl}/v1/repository/search?q=${encodeURIComponent(query)}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const json = await res.json();
    if (loadingMsgId) await deleteMessage(botToken, chatId, loadingMsgId);

    if (!json.success || !json.data || json.data.length === 0) {
      const msg = `⚠️ Tidak ditemukan dokumen riset untuk kata kunci "${query}".`;
      await sendTelegram(botToken, target, msg);
      if (target !== chatId) sendFlash(opts.ctx, botToken, chatId, threadId, msg);
      return;
    }

    const rows = [];
    let out = `🎓 *REPOSITORI KAMPUS UBSI:*\n\n`;
    json.data.slice(0, 5).forEach((r, idx) => {
      out += `${idx + 1}. *${r.title}*\n`;
      if (r.author) out += `   👤 ${r.author}\n`;
      if (r.year) out += `   📅 ${r.year}\n`;
      out += `\n`;
      if (r.url && /^https:/i.test(r.url)) {
        rows.push([{ text: `📄 ${String(r.title).slice(0, 30)}`, url: r.url }]);
      }
    });
    out += `_Klik tombol untuk membuka dokumen._`;

    const sent = await sendTelegram(botToken, target, out, null, rows.length ? { inline_keyboard: rows } : null);
    if (sent && sent.ok && target !== chatId) {
      sendFlash(opts.ctx, botToken, chatId, threadId, `🎓 *${opts.userName || "Kamu"}*, hasil riset dikirim ke DM kamu.`);
    } else if ((!sent || !sent.ok) && target !== chatId) {
      sendFlash(opts.ctx, botToken, chatId, threadId, `⚠️ *${opts.userName || "Kamu"}*, aku gak bisa DM kamu. Buka DM Bot Gudang dulu lalu tekan Start.`);
    }
  } catch (err) {
    if (loadingMsgId) await deleteMessage(botToken, chatId, loadingMsgId);
    await sendTelegram(botToken, chatId, `❌ Gagal menghubungi repositori kampus: ${err.message}`, threadId);
  }
}
