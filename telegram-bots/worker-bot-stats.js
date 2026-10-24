/**
 * USRC BOT STATISTIK v2.0 (Diagnosis Akademik, Nilai, & What-If Simulator IPK)
 * Menangani di Topik Grup (Thread ID: 2):
 * 1. Tombol interaktif: [ 📊 Analisis Performa Saya ] & [ 📈 Simulasi Target IPK ]
 * 2. What-If Simulator IPK (Target 3.50, 3.75, 3.90, atau custom via /target <nilai>)
 * 3. Hitungan murni matematis (deterministik 100% akurat)
 * 4. Kirim notif privasi ke topik + kirim diagnosis lengkap rahasia ke DM via Bot Master
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('USRC Stats Bot v2.0 Active', { status: 200 });
    }

    // Security (SEC-03): hanya terima webhook asli dari Telegram (setWebhook secret_token).
    const tgSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!env.TELEGRAM_SECRET_TOKEN || tgSecret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const botToken = env.BOT_TOKEN_STATS;
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

        // ── KUNCI SATPAM TOPIK STATISTIK (Thread ID: 2) ──
        const isGroup = query.message.chat.type === 'group' || query.message.chat.type === 'supergroup';
        if (isGroup && Number(threadId) !== 2) {
          await answerCallback(botToken, query.id, "Fitur ini hanya aktif di Topik Statistik Mahasiswa!");
          return new Response('OK', { status: 200 });
        }

        const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);

        if (!acc) {
          await answerCallback(botToken, query.id, "Akun belum terhubung! Silakan login di DM Bot Master terlebih dahulu.");
          return new Response('OK', { status: 200 });
        }

        // A. Analisis Nilai & Titik Lemah
        if (cbData === "btn_analisis_nilai") {
          await answerCallback(botToken, query.id, "Menganalisis performa akademik...");
          await executeAnalysis(botToken, masterBotToken, chatId, threadId, userId, userName, acc, backendUrl, apiKey);
          return new Response('OK', { status: 200 });
        }

        // B. Buka Menu Target IPK
        if (cbData === "btn_simulasi_ipk_menu") {
          await answerCallback(botToken, query.id);
          const menuText = 
            `🎯 *PILIH TARGET IPK ANDA (${userName})*\n\n` +
            `Silakan pilih target IPK yang ingin Anda capai untuk melihat analisis kebutuhan semester depan:\n\n` +
            `_Atau ketik langsung perintah:_ \`/target <nilai>\` _(contoh:_ \`/target 3.80\`_)_`;

          const keyboard = {
            inline_keyboard: [
              [
                { text: "🎖️ Target 3.50 (Cumlaude)", callback_data: "sim_target_3.50" },
                { text: "🏅 Target 3.75 (High Honors)", callback_data: "sim_target_3.75" }
              ],
              [
                { text: "🌟 Target 3.90 (Summa Cumlaude)", callback_data: "sim_target_3.90" },
                { text: "📊 Analisis Performa", callback_data: "btn_analisis_nilai" }
              ]
            ]
          };

          await sendTelegram(botToken, chatId, menuText, threadId, keyboard);
          return new Response('OK', { status: 200 });
        }

        // C. Eksekusi Simulasi Target
        if (cbData.startsWith("sim_target_")) {
          const targetGpa = parseFloat(cbData.replace("sim_target_", ""));
          await answerCallback(botToken, query.id, `Menghitung simulasi target IPK ${targetGpa}...`);
          await executeWhatIfSimulation(botToken, masterBotToken, chatId, threadId, userId, userName, acc, backendUrl, apiKey, targetGpa);
          return new Response('OK', { status: 200 });
        }
      }

      // ── 2. HANDLE COMMAND DI TOPIK ──
      if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const threadId = msg.message_thread_id || null;
        const text = (msg.text || '').trim();
        const userId = msg.from.id;
        const userName = msg.from.first_name || "Mahasiswa";

        // ── KUNCI SATPAM TOPIK STATISTIK (Thread ID: 2) ──
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        if (isGroup && Number(threadId) !== 2) {
          return new Response('Ignored out-of-topic message', { status: 200 });
        }

        // Command /target <nilai>
        if (text.startsWith('/target')) {
          const parts = text.split(/\s+/);
          const customTarget = parseFloat(parts[1]);
          if (isNaN(customTarget) || customTarget < 2.0 || customTarget > 4.0) {
            await sendTelegram(
              botToken, 
              chatId, 
              "⚠️ Format salah! Gunakan:\n`/target <nilai IPK antara 2.00 s/d 4.00>`\nContoh:\n`/target 3.75`", 
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          const acc = await getStudentAccount(supabaseUrl, supabaseKey, userId);
          if (!acc) {
            await sendTelegram(botToken, chatId, "🔒 Akun belum terhubung. Silakan login di DM *Bot Master* terlebih dahulu.", threadId);
            return new Response('OK', { status: 200 });
          }

          await sendTelegram(botToken, chatId, `⏳ *Menghitung simulasi target IPK ${customTarget.toFixed(2)} untuk ${userName}...*`, threadId);
          await executeWhatIfSimulation(botToken, masterBotToken, chatId, threadId, userId, userName, acc, backendUrl, apiKey, customTarget);
          return new Response('OK', { status: 200 });
        }

        if (text.startsWith('/stats') || text.startsWith('/nilai') || text.startsWith('/menu')) {
          const menuText = 
            "📈 *PORTAL STATISTIK & PREDIKSI AKADEMIK USRC v2.0*\n\n" +
            "Sistem analisis matematis performa belajar mahasiswa BSI. Privasi 100% terjaga (hasil diagnosis lengkap dikirim langsung ke DM Bot Master):";

          const keyboard = {
            inline_keyboard: [
              [
                { text: "📊 Analisis Performa & Titik Lemah", callback_data: "btn_analisis_nilai" },
                { text: "📈 What-If Simulator IPK", callback_data: "btn_simulasi_ipk_menu" }
              ]
            ]
          };

          await sendTelegram(botToken, chatId, menuText, threadId, keyboard);
          return new Response('OK', { status: 200 });
        }
      }

      return new Response('OK', { status: 200 });

    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  }
};

// ── LOGIC FUNCTIONS ──

async function executeAnalysis(botToken, masterBotToken, chatId, threadId, userId, userName, acc, backendUrl, apiKey) {
  try {
    const pwSiakad = acc.siakad_password || acc.encrypted_password;
    const [khsRes, gradesRes] = await Promise.all([
      fetch(`${backendUrl}/v1/studentv2/khs`, {
        headers: {
          'X-API-Key': apiKey,
          'X-StudentV2-NIM': acc.nim,
          'X-StudentV2-Pass': pwSiakad,
          'X-Nim': acc.nim,
          'X-Pass': pwSiakad,
        }
      }),
      fetch(`${backendUrl}/v1/studentv2/grades`, {
        headers: {
          'X-API-Key': apiKey,
          'X-StudentV2-NIM': acc.nim,
          'X-StudentV2-Pass': pwSiakad,
          'X-Nim': acc.nim,
          'X-Pass': pwSiakad,
        }
      })
    ]);

    const khsData = await khsRes.json();
    const gradesData = await gradesRes.json();

    const khs = khsData.data || {};
    const listGrades = Array.isArray(gradesData.data) ? gradesData.data : [];
    const ipk = typeof khs.ipk === 'number' ? khs.ipk : parseFloat(khs.ipk) || null;
    const totalSks = khs.total_sks || 0;

    // IPS semester berjalan
    let sumWeighted = 0, sumSksNow = 0;
    listGrades.forEach(g => {
      const t = parseFloat(g.total);
      const s = parseInt(g.sks) || 0;
      if (!isNaN(t) && s > 0) { sumWeighted += t * s; sumSksNow += s; }
    });
    const ipsNow = sumSksNow > 0 ? (sumWeighted / sumSksNow) : null;

    // Diagnosis titik bocor komponen nilai (UAS 30, UTS 25, Tugas 25, Absen 20)
    const komponen = [["UAS", 30, "uas"], ["UTS", 25, "uts"], ["Tugas", 25, "tugas"], ["Absen", 20, "absen"]];
    const matkulDiag = [];
    listGrades.forEach(g => {
      const total = parseFloat(g.total);
      if (isNaN(total) || total >= 75) return;
      let worst = null;
      komponen.forEach(k => {
        const v = g[k[2]];
        if (v === null || v === undefined) return;
        const loss = k[1] * (100 - v) / 100;
        if (!worst || loss > worst.loss) worst = { label: k[0], v: v, loss: loss };
      });
      if (worst) matkulDiag.push({ nama: g.nama || g.kode || "Mata Kuliah", total: total, grade: g.grade, worst: worst });
    });
    matkulDiag.sort((a, b) => a.total - b.total);

    let diagText = "";
    if (matkulDiag.length > 0) {
      diagText = "⚠️ *MATKUL YANG PERLU DONGKRAK:*\n";
      matkulDiag.slice(0, 5).forEach(m => {
        diagText += `• *${m.nama}* — nilai ${m.total} (Grade: ${m.grade || "-"})\n`;
        diagText += `  Titik bocor: *${m.worst.label}* (${m.worst.v}) — kontribusi terbesar penurunan nilai.\n`;
      });
    } else {
      diagText = "✨ *Semua matkul berjalan di zona aman (nilai >= 75)! Pertahankan ritmemu!*\n";
    }

    const fullReport =
      `📈 *DIAGNOSIS AKADEMIK LENGKAP*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Nama:* ${acc.full_name || userName}\n` +
      `🆔 *NIM:* ${acc.nim}\n` +
      `🎓 *Prodi:* ${acc.prodi || "-"}\n\n` +
      `📊 *STATISTIK:*\n` +
      `• *IPK Kumulatif:* ${ipk !== null ? ipk.toFixed(2) : "-"}\n` +
      `• *Total SKS Lulus:* ${totalSks || "-"}\n` +
      (ipsNow !== null ? `• *IPS Semester Berjalan:* ${ipsNow.toFixed(2)}\n` : "") +
      `\n${diagText}` +
      `\n💡 _Gunakan tombol What-If Simulator di topik untuk menghitung target IPK semester depan._\n` +
      `\n🤍 Data resmi dari SIAKAD BSI.`;

    const dmResult = await sendTelegram(masterBotToken, userId, fullReport);

    if (!dmResult.ok) {
      await sendTelegram(
        botToken,
        chatId,
        `⚠️ *${userName}*, gagal mengirim laporan ke DM. Tekan /start di *Bot Master* terlebih dahulu!`,
        threadId
      );
    } else {
      await sendTelegram(
        botToken,
        chatId,
        `📊 *Laporan diagnosis performa ${userName} telah dikirim ke DM Bot Master.* 🔒`,
        threadId
      );
    }
  } catch (err) {
    await sendTelegram(botToken, chatId, `❌ Gagal memproses data akademik: ${err.message}`, threadId);
  }
}

async function executeWhatIfSimulation(botToken, masterBotToken, chatId, threadId, userId, userName, acc, backendUrl, apiKey, targetGpa) {
  try {
    const pwSiakad = acc.siakad_password || acc.encrypted_password;
    const khsRes = await fetch(`${backendUrl}/v1/studentv2/khs`, {
      headers: {
        'X-API-Key': apiKey,
        'X-StudentV2-NIM': acc.nim,
        'X-StudentV2-Pass': pwSiakad,
        'X-Nim': acc.nim,
        'X-Pass': pwSiakad,
      }
    });

    const khsData = await khsRes.json();
    const khs = khsData.data || {};
    const ipk = typeof khs.ipk === 'number' ? khs.ipk : parseFloat(khs.ipk) || 0.0;
    const totalSks = khs.total_sks || 0;

    if (totalSks <= 0 || ipk <= 0) {
      await sendTelegram(botToken, chatId, "⚠️ Data SKS atau IPK Anda belum tercatat di SIAKAD.", threadId);
      return;
    }

    let report = 
      `🎯 *SIMULASI TARGET IPK (WHAT-IF SIMULATOR)*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Mahasiswa:* ${acc.full_name || userName} (\`${acc.nim}\`)\n` +
      `📊 *IPK Saat Ini:* ${ipk.toFixed(2)} (Total SKS: ${totalSks})\n` +
      `🎯 *Target IPK:* *${targetGpa.toFixed(2)}*\n\n` +
      `*ANALISIS KEBUTUHAN SEMESTER DEPAN:*\n`;

    const sksVariants = [18, 20, 22, 24];
    let achievable = false;

    sksVariants.forEach(sNext => {
      // Rumus deterministik: (Target * (SKS_lama + SKS_baru) - IPK_lama * SKS_lama) / SKS_baru
      const neededIps = (targetGpa * (totalSks + sNext) - ipk * totalSks) / sNext;

      if (neededIps <= 4.0 && neededIps >= 0) {
        achievable = true;
        report += `• *Ambil ${sNext} SKS:* Butuh IPS semester minimal *${neededIps.toFixed(2)}* ✅\n`;
        
        // Estimasi distribusi nilai (A=4, B=3)
        if (neededIps > 3.5) {
          const aCount = Math.ceil((neededIps - 3.0) * (sNext / 3));
          report += `   👉 _Butuh sekitar ${aCount} matkul Nilai A (4.0) dari ~${Math.round(sNext/3)} matkul._\n`;
        }
      } else if (neededIps > 4.0) {
        report += `• *Ambil ${sNext} SKS:* Butuh IPS ${neededIps.toFixed(2)} — ⚠️ Belum mungkin dalam 1 semester (maksimum IPS adalah 4.00).\n`;
      } else {
        report += `• *Ambil ${sNext} SKS:* Sudah terlampaui! (IPS minimal ${neededIps.toFixed(2)})\n`;
      }
    });

    if (!achievable) {
      // Hitung berapa SKS kumulatif yang dibutuhkan dengan asumsi IPS sempurna 4.00
      const totalSksNeeded = (ipk * totalSks - 4.0 * totalSks) / (targetGpa - 4.0);
      const additionalSks = Math.ceil(totalSksNeeded - totalSks);
      const estSemesters = Math.ceil(additionalSks / 20);
      report += `\n💡 *Rekomendasi Jalur Strategis:*\n` +
                `Untuk mencapai IPK ${targetGpa.toFixed(2)}, Anda membutuhkan sekitar *${additionalSks} SKS* dengan nilai A (IPS 4.00) atau sekitar *${estSemesters} semester* perkuliahan konsisten.\n`;
    }

    report += `\n🤍 _Perhitungan matematis akurat berdasar bobot SKS BSI._`;

    const dmResult = await sendTelegram(masterBotToken, userId, report);

    if (!dmResult.ok) {
      await sendTelegram(
        botToken,
        chatId,
        `⚠️ *${userName}*, simulasi selesai tapi gagal dikirim ke DM. Tekan /start di *Bot Master* terlebih dahulu!`,
        threadId
      );
    } else {
      await sendTelegram(
        botToken,
        chatId,
        `🎯 *Hasil What-If Simulator target IPK ${targetGpa.toFixed(2)} untuk ${userName} telah dikirim ke DM.* 🔒`,
        threadId
      );
    }
  } catch (err) {
    await sendTelegram(botToken, chatId, `❌ Gagal menghitung simulasi: ${err.message}`, threadId);
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
