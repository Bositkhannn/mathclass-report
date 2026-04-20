const admin = require('firebase-admin');
const XLSX   = require('xlsx');
const https  = require('https');

// ── Firebase init ──────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
});

const db              = admin.firestore();
const DAILY_ACTIVE_MS = 24 * 60 * 60 * 1000;

// ── Tashkent time helper ───────────────────────────────────────
function tashkentNow() {
    return new Date(Date.now() + 5 * 60 * 60 * 1000);
}

// ── Telegram: send text ────────────────────────────────────────
function sendText(token, chatId, text) {
    return new Promise((resolve, reject) => {
        const body    = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
        const bodyBuf = Buffer.from(body, 'utf8');
        const options = {
            hostname: 'api.telegram.org',
            path:     `/bot${token}/sendMessage`,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': bodyBuf.length
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
            });
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}

// ── Telegram: send Excel document ─────────────────────────────
function sendDocument(token, chatId, buffer, filename, caption) {
    return new Promise((resolve, reject) => {
        const boundary = 'BOUNDARY_' + Date.now();
        const CRLF     = '\r\n';

        const metaPart =
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}` +
            `${chatId}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}` +
            `${caption}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}` +
            `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet${CRLF}${CRLF}`;

        const closing = `${CRLF}--${boundary}--${CRLF}`;
        const body    = Buffer.concat([
            Buffer.from(metaPart, 'utf8'),
            buffer,
            Buffer.from(closing, 'utf8')
        ]);

        const options = {
            hostname: 'api.telegram.org',
            path:     `/bot${token}/sendDocument`,
            method:   'POST',
            headers:  {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Daily Report ───────────────────────────────────────────────
async function runDailyReport(settings) {
    console.log('\n📊 Running daily report...');

    const tashkent = tashkentNow();
    const todayStr = tashkent.toDateString();
    const dateStr  = tashkent.toLocaleDateString('uz-UZ');

    // Load students
    const studentsSnap = await db.collection('students').get();
    const students     = studentsSnap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(s => !s.deleted);

    console.log(`👥 Active students: ${students.length}`);

    // Load today's daily results
    const resultsSnap  = await db.collection('results').get();
    const todayResults = resultsSnap.docs
        .map(d => d.data())
        .filter(r => {
            if (!r.timestamp || r.type !== 'daily') return false;
            const rTashkent = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
            return rTashkent.toDateString() === todayStr;
        });

    console.log(`📋 Today's daily submissions: ${todayResults.length}`);

    // Load active daily tasks
    const nowMs       = Date.now();
    const dailySnap   = await db.collection('dailyTasks').get();
    const activeTasks = dailySnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(dt => dt.activatedAt && (nowMs - dt.activatedAt) < DAILY_ACTIVE_MS);

    if (!activeTasks.length) {
        console.log('ℹ️ No active daily tasks today');
        await sendText(settings.token, settings.chatId,
            `📊 Kunlik hisobot — ${dateStr}\n\n` +
            `⚠️ Bugun faol kunlik topshiriq bo'lmadi.`
        );
        return;
    }

    // Build rows
    const rows = [['Ism', 'Sinf', 'Login', 'Holat', 'Ball', 'Topshiriq', 'Vaqt']];

    for (const s of students) {
        const myTasks = activeTasks.filter(dt =>
            dt.isUniversal || (dt.grades || []).includes(s.grade)
        );
        if (!myTasks.length) continue;

        const done = todayResults.filter(r =>
            r.student === (s.name || s.username) && r.grade === s.grade
        );

        if (done.length) {
            done.forEach(r => {
                const rTime = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
                rows.push([
                    s.name || s.username,
                    s.grade,
                    s.username || '',
                    '✅ Bajarildi',
                    `${r.score}/${r.total}`,
                    r.title || '',
                    rTime.toLocaleTimeString('uz-UZ')
                ]);
            });
        } else {
            rows.push([
                s.name || s.username,
                s.grade,
                s.username || '',
                '❌ Bajarilmadi',
                '-', '-', '-'
            ]);
        }
    }

    // Sort: done first, then by grade
    const header   = rows[0];
    const dataRows = rows.slice(1).sort((a, b) => {
        if (a[3] !== b[3]) return a[3] === '✅ Bajarildi' ? -1 : 1;
        return a[1].localeCompare(b[1]);
    });
    const sorted = [header, ...dataRows];

    // Build Excel
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sorted);
    ws['!cols'] = [
        { wch: 22 }, { wch: 8 },  { wch: 18 },
        { wch: 14 }, { wch: 8 },  { wch: 26 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Hisobot');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const doneCount   = dataRows.filter(r => r[3] === '✅ Bajarildi').length;
    const missedCount = dataRows.filter(r => r[3] === '❌ Bajarilmadi').length;

    const caption =
        `📊 Kunlik hisobot — ${dateStr}\n\n` +
        `✅ Bajarildi: ${doneCount} ta\n` +
        `❌ Bajarilmadi: ${missedCount} ta\n` +
        `👥 Jami: ${doneCount + missedCount} ta o'quvchi`;

    const filename = `hisobot_${dateStr.replace(/\./g, '-')}.xlsx`;
    await sendDocument(settings.token, settings.chatId, buffer, filename, caption);

    console.log(`✅ Report sent — Done: ${doneCount}, Missed: ${missedCount}`);
}

// ── Auto-assign daily task ─────────────────────────────────────
async function runAutoAssign(settings) {
    console.log('\n🔍 Checking for active daily task...');

    const nowMs     = Date.now();
    const dailySnap = await db.collection('dailyTasks').get();
    const allTasks  = dailySnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const hasActive = allTasks.some(dt =>
        dt.activatedAt && (nowMs - dt.activatedAt) < DAILY_ACTIVE_MS
    );

    if (hasActive) {
        console.log('✅ Active task exists — skipping auto-assign');
        return;
    }

    console.log('⚠️ No active task — auto-assigning...');

    // Load questions
    const qSnap     = await db.collection('questions').get();
    const questions = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (questions.length < 3) {
        console.log('❌ Not enough questions (need at least 3)');
        if (settings.token && settings.chatId) {
            await sendText(settings.token, settings.chatId,
                `⚠️ <b>Diqqat!</b> Kunlik topshiriq avtomatik tayinlanmadi.\n` +
                `Savol bazasida 3 tadan kam savol bor.\n` +
                `Iltimos, savollar qo'shing va qo'lda topshiriq bering.`
            );
        }
        return;
    }

    // Pick 3–5 random questions
    const shuffled = questions.sort(() => Math.random() - 0.5);
    const count    = Math.floor(Math.random() * 3) + 3;
    const picked   = shuffled.slice(0, count);

    const tashkent = tashkentNow();
    const dateStr  = tashkent.toLocaleDateString('uz-UZ');

    const newTask = {
        id:           'auto_' + nowMs,
        title:        `Avtomatik kunlik mashq — ${dateStr}`,
        qids:         picked.map(q => q.id),
        isUniversal:  true,
        grades:       [],
        activatedAt:  nowMs,
        autoAssigned: true,
        createdAt:    new Date().toISOString()
    };

    await db.collection('dailyTasks').doc(newTask.id).set(newTask);
    console.log(`✅ Auto task created with ${count} questions`);

    if (settings.token && settings.chatId) {
        const qList = picked.map((q, i) =>
            `${i + 1}. ${(q.text || '(matn yo\'q)').substring(0, 70)}`
        ).join('\n');

        await sendText(settings.token, settings.chatId,
            `⚠️ <b>Avtomatik kunlik mashq tayinlandi!</b>\n\n` +
            `Siz 14:00 gacha kunlik mashq bermagansiz.\n` +
            `Tizim avtomatik ravishda <b>${count} ta savol</b> tanladi:\n\n` +
            `${qList}\n\n` +
            `📅 ${dateStr} · Barcha o'quvchilarga ko'rinadi`
        );
        console.log('📬 Teacher notified via Telegram');
    }
}

// ── Entry point ────────────────────────────────────────────────
async function main() {
    console.log('🚀 MathClass script starting...');
    console.log(`🕐 UTC:      ${new Date().toISOString()}`);
    console.log(`🕔 Tashkent: ${tashkentNow().toLocaleString('uz-UZ')}`);

    const settingsDoc = await db.collection('settings').doc('main').get();
    const settings    = settingsDoc.exists ? settingsDoc.data() : {};

    if (!settings.token || !settings.chatId) {
        console.log('❌ No Telegram token/chatId in Firestore — exiting');
        process.exit(0);
    }

    const task = process.argv[2]; // 'autoassign' or nothing (= report)

    if (task === 'autoassign') {
        await runAutoAssign(settings);
    } else {
        await runDailyReport(settings);
    }

    console.log('\n✅ All done');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
