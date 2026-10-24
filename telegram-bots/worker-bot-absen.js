/**
 * USRC BOT ABSENSI (E-Learning & Presensi MyBest) — V2 "Topik Terkunci"
 *
 * Konsep grup bersih:
 * - Topik absen ditutup; hanya ada 1 pesan PIN berisi 3 tombol:
 *   [ ⚡ Absen Sekarang ] [ 📋 Cek Jadwal ] [ 🔍 Cek Status Absen ]
 * - Output SUKSES (resi absen + jadwal) → DM via Bot Master.
 * - Output GAGAL / STATUS → flash di topik, auto-delete 10 detik.
 * - /pasang (admin) → kirim menu, pin, lalu tutup topik.
 * - /buka   (admin) → buka kembali topik untuk maintenance.
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('USRC Absen Bot Active', { status: 200 });
    }

    // Security (SEC-03): hanya terima webhook asli dari Telegram (setWebhook secret_token).
    const tgSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!env.TELEGRAM_SECRET_TOKEN || tgSecret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const botToken = env.BOT_TOKEN_ABSEN;
      const masterBotToken = env.BOT_TOKEN_MASTER;
      const backendUrl = (env.BACKEND_URL || 'https://ubsi-api-production.up.railway.app').replace(/\/$/, '');
      // Security (SEC-07): tanpa fallback — env kosong wajib fail fast.
      const apiKey = env.BACKEND_API_KEY;
      if (!apiKey) throw new Error('BACKEND_API_KEY environment variable is required');
      const supabaseUrl = env.SUPABASE_URL || 'https://wagvbmkimpswiidnenwx.supabase.co';
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

      // ── 1. HANDLE TOMBOL KLIK (Callback Query) ──
      if (update.callback_query) {
        const query = update.callback_query;
        const cbData = query.data;
        const userId = query.from.id;
        const userName = query.from.first_name || "Mahasiswa";
        const chatId = query.message.chat.id;
        const threadId = query.message.message_thread_id || null;

        // ── KUNCI SATPAM TOPIK ABSEN (Thread ID: 4) ──
        const isGroup = query.message.chat.type === 'group' || query.message.chat.type === 'supergroup';
        if (isGroup && Number(threadId) !== 4) {
          await answerCallback(botToken, query.id, "Fitur ini hanya aktif di Topik E-Learning & Absen!");
          return new Response('OK', { status: 200 });
        }

        // ── SETUP MENU PIN (klik tombol dari pesan setup tidak diproses khusus) ──

        // Ambil akun mahasiswa dari Supabase
        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);

        if (!acc) {
          await answerCallback(botToken, query.id, "Akun belum terhubung! Silakan chat Bot Master untuk login terlebih dahulu.");
          return new Response('OK', { status: 200 });
        }

        // ══ TOMBOL 1: ABSEN SEKARANG ══
        if (cbData === "btn_absen_now") {
          await answerCallback(botToken, query.id, "Sedang memproses presensi ke MyBest...");

          try {
            // Endpoint resmi backend: POST /v1/elearning/presence (token opsional via query)
            const presRes = await safeFetchJson(`${backendUrl}/v1/elearning/presence`, {
              method: 'POST',
              headers: {
                'X-API-Key': apiKey,
                'X-Elearning-NIM': acc.nim,
                'X-Elearning-Pass': acc.encrypted_password,
                'X-Nim': acc.nim,
                'X-Pass': acc.encrypted_password,
              }
            });

            if (!presRes.ok && (!presRes.data || !presRes.data.success)) {
              const errMsg = presRes.data?.error?.message || (presRes.status === 502 ? "Server backend/kampus sedang sibuk (502). Coba sesaat lagi." : `Gagal menghubungi server (${presRes.status})`);
              await sendFlash(ctx, botToken, chatId, threadId, `⚠️ *Gagal Absen (${userName}):*\n${errMsg}`);
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: "btn_absen_now", detail: String(errMsg), outcome: "failed"
              });
              return new Response('OK', { status: 200 });
            }

            const presData = presRes.data || {};

            // PENTING: backend membungkus hasil di dalam "data".
            // Outer success selalu true (HTTP 200) walau sesi tidak aktif,
            // jadi status sukses/gagal yang ASLI ada di presData.data.success
            const r = presData.data || {};

            if (presData.success && r.success) {
              const mkName = r.matakuliah || "Kuliah Hari Ini";
              const dosen = r.dosen || "-";
              const jamAbsen = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Pontianak' });

              // Resi anti-rekayasa (kegagalan tabel tidak memutus alur)
              const resiCode = await saveReceipt(supabaseUrl, supabaseKey, {
                code: genCode("ABS"), type: "absen",
                user_id: userId, nim: acc.nim,
                full_name: acc.full_name || userName,
                summary: `Presensi "${mkName}" (${dosen}) pukul ${jamAbsen} WIB`,
                ref_id: null,
              });

              // Grup tetap BERSIH: sukses hanya dikirim ke DM via Bot Master
              let dmOk = false;
              let dmErr = "";
              if (!masterBotToken) {
                dmErr = "env BOT_TOKEN_MASTER belum diset di worker absen";
                await sendFlash(
                  ctx, botToken, chatId, threadId,
                  `✅ *Presensi ${userName} BERHASIL* — matkul *${mkName}*` +
                  (resiCode ? `\n🧾 Resi: \`${resiCode}\`` : "") +
                  `\n⚙️ Pengiriman bukti ke DM belum terkonfigurasi — lapor admin ya (resimu tetap tercatat, verifikasi: /cek ${resiCode || "-"}).`
                );
              } else {
                const dm = await sendTelegram(
                  masterBotToken,
                  userId,
                  `🎓 *BUKTI PRESENSI ELEARNING BERHASIL*\n\n` +
                  `• Nama: *${acc.full_name || userName}*\n` +
                  `• NIM: *${acc.nim}*\n` +
                  `• Mata Kuliah: *${mkName}*\n` +
                  `• Dosen: *${dosen}*\n` +
                  `• Waktu Absen: *${jamAbsen} WIB*\n` +
                  (resiCode ? `• Resi: \`${resiCode}\` _(verifikasi: /cek ${resiCode})_\n` : "") +
                  `\nStatus kehadiranmu sudah tercatat resmi di portal MyBest kampus! 🤍`
                );
                dmOk = !!(dm && dm.ok);
                if (!dmOk) dmErr = dm ? `Telegram: ${dm.description || "unknown"}` : "fetch error";
                if (!dmOk) {
                  // DM gagal (belum Start Bot Master / diblokir) → flash 10 dtk di topik
                  await sendFlash(
                    ctx, botToken, chatId, threadId,
                    `✅ *Presensi ${userName} BERHASIL* — matkul *${mkName}*` +
                    (resiCode ? `\n🧾 Resi: \`${resiCode}\`` : "") +
                    `\n⚠️ Bukti lengkap gagal dikirim ke DM. Buka DM Bot Master lalu tekan Start.`
                  );
                }
              }

              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: acc.full_name || userName, nim: acc.nim,
                command: "btn_absen_now",
                detail: `presensi "${mkName}" (${dosen}) — resi ${resiCode || "-"} → DM master ${dmOk ? "terkirim" : `GAGAL (${dmErr})`}`,
                outcome: "success"
              });
            } else {
              const msgErr = r.message || r.status || presData.error?.message || "Tidak ada sesi kuliah yang sedang membuka presensi saat ini.";
              await sendFlash(ctx, botToken, chatId, threadId, `⚠️ *Gagal Absen (${userName}):*\n${msgErr}`);
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: "btn_absen_now", detail: String(msgErr), outcome: "failed"
              });
            }
          } catch (err) {
            await sendFlash(ctx, botToken, chatId, threadId, `❌ Terjadi kesalahan sistem: ${err.message}`);
            await ghostLog(supabaseUrl, supabaseKey, botToken, {
              bot: "absen", chat_id: chatId, thread_id: threadId,
              user_id: userId, user_name: userName, nim: acc ? acc.nim : null,
              command: "btn_absen_now", detail: `error sistem: ${err.message}`, outcome: "failed"
            });
          }

          return new Response('OK', { status: 200 });
        }

        // ══ TOMBOL 2: CEK JADWAL (output → DM Bot Master) ══
        if (cbData === "btn_jadwal_today" || cbData === "re_jadwal") {
          await answerCallback(botToken, query.id, "Mengambil jadwal kuliah...");

          try {
            const siakadPass = acc.siakad_password || acc.encrypted_password;
            const schRes = await safeFetchJson(`${backendUrl}/v1/studentv2/schedule`, {
              headers: {
                'X-API-Key': apiKey,
                'X-StudentV2-NIM': acc.nim,
                'X-StudentV2-Pass': siakadPass,
                'X-Nim': acc.nim,
                'X-Pass': siakadPass,
              }
            });

            if (!schRes.ok && (!schRes.data || !schRes.data.success)) {
              const errMsg = schRes.data?.error?.message || (schRes.status === 502 ? "Portal SIAKAD kampus sedang lambat/down (502). Coba sesaat lagi." : `Gagal mengambil jadwal (${schRes.status})`);
              await sendFlash(ctx, botToken, chatId, threadId, `⚠️ *Gagal Jadwal (${userName}):*\n${errMsg}`);
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: cbData, detail: String(errMsg), outcome: "failed"
              });
              return new Response('OK', { status: 200 });
            }

            const schData = schRes.data || {};

            if (!schData.success || !schData.data || schData.data.length === 0) {
              await sendFlash(ctx, botToken, chatId, threadId, `📋 Tidak ada jadwal kuliah terdaftar untuk NIM *${acc.nim}*.`);
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: cbData, detail: "jadwal kosong", outcome: "failed"
              });
              return new Response('OK', { status: 200 });
            }

            const items = schData.data.map(j => ({
              nama: j.nama || j.matakuliah || j.nama_mata_kuliah || "Mata Kuliah",
              sks: j.sks || null,
              hari: j.hari || "-",
              jam: j.jam || j.waktu || "-",
              ruang: j.ruang || "-"
            }));

            // Kirim ke DM mahasiswa via Bot Master (grup tetap bersih)
            let dmOk = false;
            let dmErr = "";
            if (!masterBotToken) {
              dmErr = "env BOT_TOKEN_MASTER belum diset di worker absen";
              sendFlash(ctx, botToken, chatId, threadId,
                `⚙️ *${userName}*, pengiriman DM belum terkonfigurasi — lapor admin ya (jadwal berhasil diambil tapi gak bisa dikirim).`);
            } else {
              const dm = await sendTelegram(masterBotToken, userId, renderJadwalText(items));
              dmOk = !!(dm && dm.ok);
              if (!dmOk) dmErr = dm ? `Telegram: ${dm.description || "unknown"}` : "fetch error";
              if (!dmOk) {
                await sendFlash(
                  ctx, botToken, chatId, threadId,
                  `⚠️ *${userName}*, jadwal gagal dikirim ke DM.\nBuka DM Bot Master dulu lalu tekan Start, setelah itu coba lagi.`
                );
              }
            }

            await ghostLog(supabaseUrl, supabaseKey, botToken, {
              bot: "absen", chat_id: chatId, thread_id: threadId,
              user_id: userId, user_name: userName, nim: acc.nim,
              command: "btn_jadwal_today",
              detail: `${items.length} jadwal → DM master ${dmOk ? "terkirim" : `GAGAL (${dmErr})`}`,
              outcome: dmOk ? "success" : "failed"
            });
          } catch (err) {
            await sendFlash(ctx, botToken, chatId, threadId, `❌ Gagal mengambil jadwal: ${err.message}`);
            await ghostLog(supabaseUrl, supabaseKey, botToken, {
              bot: "absen", chat_id: chatId, thread_id: threadId,
              user_id: userId, user_name: userName, nim: acc ? acc.nim : null,
              command: cbData, detail: `error sistem: ${err.message}`, outcome: "failed"
            });
          }

          return new Response('OK', { status: 200 });
        }

        // ══ TOMBOL 3: CEK STATUS ABSEN (flash 10 dtk di topik) ══
        if (cbData === "btn_status_absen") {
          await answerCallback(botToken, query.id, "Memeriksa status sesi absen...");

          try {
            const stRes = await safeFetchJson(`${backendUrl}/v1/elearning/presence`, {
              headers: {
                'X-API-Key': apiKey,
                'X-Elearning-NIM': acc.nim,
                'X-Elearning-Pass': acc.encrypted_password,
                'X-Nim': acc.nim,
                'X-Pass': acc.encrypted_password,
              }
            });

            if (!stRes.ok && (!stRes.data || !stRes.data.success)) {
              const errMsg = stRes.data?.error?.message || (stRes.status === 502 ? "Server backend/kampus sedang sibuk (502). Coba sesaat lagi." : `Gagal memeriksa status (${stRes.status})`);
              await sendFlash(ctx, botToken, chatId, threadId, `⚠️ *Cek Status (${userName}):*\n${errMsg}`);
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: "btn_status_absen", detail: String(errMsg), outcome: "failed"
              });
              return new Response('OK', { status: 200 });
            }

            const s = (stRes.data && stRes.data.data) || {};

            if (s.can_submit) {
              await sendFlash(
                ctx, botToken, chatId, threadId,
                `🟢 *SESI ABSEN TERBUKA!*\n` +
                `• Matkul: *${s.matakuliah || "-"}*\n` +
                `• Dosen: *${s.dosen || "-"}*\n` +
                `• Jam: *${s.jam_masuk || "-"}${s.jam_keluar ? " - " + s.jam_keluar : ""}*\n` +
                `Gas tekan ⚡ *Absen Sekarang* sebelum tutup!`
              );
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: acc.full_name || userName, nim: acc.nim,
                command: "btn_status_absen",
                detail: `sesi TERBUKA: ${s.matakuliah || "-"} (${s.status_sesi || "-"})`,
                outcome: "success"
              });
            } else {
              const statusTxt = s.status_sesi ? `Status sesi: *${s.status_sesi}*` : "Tidak ada sesi presensi yang aktif saat ini.";
              await sendFlash(
                ctx, botToken, chatId, threadId,
                `🔴 *SESI ABSEN TUTUP*\n${statusTxt}\nTombol ⚡ Absen tetap bisa dicoba saat sesi dibuka dosen.`
              );
              await ghostLog(supabaseUrl, supabaseKey, botToken, {
                bot: "absen", chat_id: chatId, thread_id: threadId,
                user_id: userId, user_name: userName, nim: acc.nim,
                command: "btn_status_absen",
                detail: `sesi tutup: ${s.status_sesi || "tidak ada sesi"}`,
                outcome: "success"
              });
            }
          } catch (err) {
            await sendFlash(ctx, botToken, chatId, threadId, `❌ Gagal memeriksa status: ${err.message}`);
            await ghostLog(supabaseUrl, supabaseKey, botToken, {
              bot: "absen", chat_id: chatId, thread_id: threadId,
              user_id: userId, user_name: userName, nim: acc ? acc.nim : null,
              command: "btn_status_absen", detail: `error sistem: ${err.message}`, outcome: "failed"
            });
          }

          return new Response('OK', { status: 200 });
        }
      }

      // ── 2. HANDLE PESAN / COMMAND DI TOPIK ──
      if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const threadId = msg.message_thread_id || null;
        const text = (msg.text || '').trim();
        const fromId = msg.from ? msg.from.id : null;

        // ── KUNCI SATPAM TOPIK ABSEN (Thread ID: 4) ──
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        if (isGroup && Number(threadId) !== 4) {
          return new Response('Ignored out-of-topic message', { status: 200 });
        }

        // /pasang — ADMIN ONLY: kirim menu, pin, lalu TUTUP topik
        if (isGroup && text.startsWith('/pasang')) {
          if (!(await isAdmin(botToken, chatId, fromId))) {
            await sendFlash(ctx, botToken, chatId, threadId, `⛔ Perintah ini khusus admin.`);
            return new Response('OK', { status: 200 });
          }

          const sent = await sendTelegram(botToken, chatId, MENU_TEXT, threadId, MENU_KEYBOARD);
          if (sent && sent.ok && sent.result && sent.result.message_id) {
            await tgApi(botToken, "pinChatMessage", {
              chat_id: chatId, message_id: sent.result.message_id, disable_notification: true
            });
          }
          await tgApi(botToken, "closeForumTopic", { chat_id: chatId, message_thread_id: 4 });
          await ghostLog(supabaseUrl, supabaseKey, botToken, {
            bot: "absen", chat_id: chatId, thread_id: threadId,
            user_id: fromId, user_name: (msg.from && msg.from.first_name) || "admin", nim: null,
            command: "/pasang", detail: "menu dipin + topik ditutup", outcome: "success"
          });
          return new Response('OK', { status: 200 });
        }

        // /buka — ADMIN ONLY: buka kembali topik (maintenance)
        if (isGroup && text.startsWith('/buka')) {
          if (!(await isAdmin(botToken, chatId, fromId))) {
            await sendFlash(ctx, botToken, chatId, threadId, `⛔ Perintah ini khusus admin.`);
            return new Response('OK', { status: 200 });
          }
          await tgApi(botToken, "reopenForumTopic", { chat_id: chatId, message_thread_id: 4 });
          await ghostLog(supabaseUrl, supabaseKey, botToken, {
            bot: "absen", chat_id: chatId, thread_id: threadId,
            user_id: fromId, user_name: (msg.from && msg.from.first_name) || "admin", nim: null,
            command: "/buka", detail: "topik dibuka untuk maintenance", outcome: "success"
          });
          return new Response('OK', { status: 200 });
        }

        // /menu atau /absen — kirim ulang menu tombol (untuk re-pin manual)
        if (text.startsWith('/absen') || text.startsWith('/menu')) {
          await sendTelegram(botToken, chatId, MENU_TEXT, threadId, MENU_KEYBOARD);
          return new Response('OK', { status: 200 });
        }
      }

      return new Response('OK', { status: 200 });

    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  },

  // ── CRON: sweep pesan ephemeral legacy yang tersisa (menu sekarang 10 dtk via waitUntil) ──
  async scheduled(event, env, ctx) {
    const botToken = env.BOT_TOKEN_ABSEN;
    const supabaseUrl = env.SUPABASE_URL || 'https://wagvbmkimpswiidnenwx.supabase.co';
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!botToken || !supabaseKey) return;

    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/ubsi_ephemeral_msgs?bot=eq.absen&select=*`, {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      });
      const rows = await res.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) return;

      const now = Date.now();
      for (const row of rows) {
        if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
          if (row.message_id) await deleteMessage(botToken, row.chat_id, row.message_id);
          await fetch(`${supabaseUrl}/rest/v1/ubsi_ephemeral_msgs?id=eq.${row.id}`, {
            method: 'DELETE',
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
          }).catch(() => {});
        }
      }
    } catch (_) {}
  }
};

// ── MENU PIN (3 tombol) ──
const MENU_TEXT =
  "⚡ *PORTAL PRESENSI ELEARNING USRC*\n\n" +
  "Topik ini terkunci — cukup tekan tombol di bawah:\n" +
  "• Hasil absen & jadwal dikirim ke *DM Bot Master*\n" +
  "• Notif gagal/status muncul 10 detik lalu terhapus sendiri";

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: "⚡ Absen Sekarang", callback_data: "btn_absen_now" }],
    [{ text: "📋 Cek Jadwal", callback_data: "btn_jadwal_today" }],
    [{ text: "🔍 Cek Status Absen", callback_data: "btn_status_absen" }]
  ]
};

// ── FLASH 10 DETIK: kirim ke topik lalu auto-delete (ctx.waitUntil agar tak mati sebelum hapus) ──
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

async function sendTelegram(token, chatId, text, threadId = null, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  };
  if (threadId) payload.message_thread_id = threadId;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let j = await resp.json().catch(() => ({}));

  // Fallback: kalau Markdown gagal karena karakter aneh (nama matkul/dosen
  // mengandung _ atau *), kirim ulang sebagai teks polos
  if (!j.ok && payload.parse_mode) {
    delete payload.parse_mode;
    const r2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    j = await r2.json().catch(() => ({}));
  }
  return j;
}

async function answerCallback(token, queryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId, text: text })
  });
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

async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  }).catch(() => {});
}

// Ghost Log: yang menguap dari grup tetap tercatat (tabel; /ingat di Bot Master)
async function ghostLog(supabaseUrl, supabaseKey, botToken, entry) {
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

// Render jadwal untuk DM + hitung mundur live per matkul (zona WIB, saat render)
function renderJadwalText(items) {
  const HARI_IDX = { "minggu": 0, "senin": 1, "selasa": 2, "rabu": 3, "kamis": 4, "jumat": 5, "jum'at": 5, "sabtu": 6 };
  // "Sekarang" versi WIB
  const nowWib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Pontianak' }));
  const todayIdx = nowWib.getDay();

  let text = `📋 *JADWAL KULIAH KAMU:*\n\n`;
  items.forEach((j, idx) => {
    const sks = j.sks ? ` (${j.sks} SKS)` : "";
    text += `${idx + 1}. *${j.nama}*${sks}\n`;
    text += `   ⏰ ${j.hari || '-'}, ${j.jam || '-'} (Ruang: ${j.ruang || '-'})\n`;

    // Coba parse hari + jam "HH:MM-HH:MM" untuk hitung mundur
    const dayIdx = HARI_IDX[String(j.hari || '').trim().toLowerCase()];
    const m = String(j.jam || '').match(/(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})/);
    if (dayIdx !== undefined && m) {
      const startM = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      const endM = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
      const nowM = nowWib.getHours() * 60 + nowWib.getMinutes();
      let dayDiff = (dayIdx - todayIdx + 7) % 7;
      if (dayDiff === 0 && nowM >= endM) dayDiff = 7; // sudah lewat minggu ini

      if (dayDiff === 0 && nowM >= startM && nowM < endM) {
        const left = endM - nowM;
        text += `   🔥 *BERLANGSUNG* — selesai dalam ${Math.floor(left / 60)}j ${left % 60}m\n`;
      } else {
        const target = new Date(nowWib);
        target.setDate(target.getDate() + dayDiff);
        target.setHours(Math.floor(startM / 60), startM % 60, 0, 0);
        const diffMin = Math.round((target - nowWib) / 60000);
        const d = Math.floor(diffMin / 1440);
        const h = Math.floor((diffMin % 1440) / 60);
        const mm = diffMin % 60;
        text += `   ⏳ mulai ${d > 0 ? `${d}h ` : ""}${h}j ${mm}m lagi\n`;
      }
    }
    text += `\n`;
  });

  text += `_Data diambil langsung dari SIAKAD. Cek ulang kapan saja lewat tombol 📋 Cek Jadwal._`;
  return text;
}
