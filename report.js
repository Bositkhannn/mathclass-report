const admin = require('firebase-admin');
const XLSX  = require('xlsx');
const https = require('https');

// ── Firebase init ──────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
});

const db = admin.firestore();

// ── Main ───────────────────────────────────────────────────────
async function main() {
    console.log('📊 Starting daily report...');

    // Load settings
    const settingsDoc = await db.collection('settings').doc('main').get();
    const settings    = settingsDoc.exists ? settingsDoc.data() : {};

    if (!settings.token || !settings.chatId) {
        console.log('❌ No Telegram token/chatId found in Firestore settings');
        process.exit(0);
    }

    const { token, chatId } = settings;

    // Load students
    const studentsSnap = await db.collection('students').get();
    const students = studentsSnap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(s => !s.deleted);

    console.log(`👥 Total active students: ${students.length}`);

    // Tashkent = UTC+5
    const nowUTC     = new Date();
    const tashkentMs = nowUTC.getTime() + 5 * 60 * 60 * 1000;
    const tashkent   = new Date(tashkentMs);
    const todayStr   = tashkent.toDateString();

    // Load today's results
    const resultsSnap  = await db.collection('results').get();
    const todayResults = resultsSnap.docs
        .map(d => d.data())
        .filter(r => {
            if (!r.timestamp) return false;
            const rTashkent = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
            return rTashkent.toDateString() === todayStr && r.type === 'daily';
        });

    console.log(`📋 Today's daily results: ${todayResults.length}`);

    // Load active daily tasks (activated within last 24 hours)
    const DAILY_ACTIVE_MS = 24 * 60 * 60 * 1000;
    const nowMs           = Date.now();
    const dailySnap       = await db.collection('dailyTasks').get();
    const activeTasks     = dailySnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(dt => dt.activatedAt && (nowMs - dt.activatedAt) < DAILY_ACTIVE_MS);

    console.log(`✅ Active daily tasks: ${activeTasks.length}`);

    if (!activeTasks.length) {
        await sendText(token, chatId,
            `📊 Kunlik hisobot — ${tashkent.toLocaleDateString('uz-UZ')}\n\n` +
            `⚠️ Bugun faol kunlik topshiriq yo'q edi.`
        );
        console.log('No active tasks — sent notice to Telegram');
        return;
    }

    // Build Excel rows
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
                const rTashkent = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
                rows.push([
                    s.name || s.username,
                    s.grade,
                    s.username || '',
                    '✅ Bajarildi',
                    `${r.score}/${r.total}`,
                    r.title || '',
                    rTashkent.toLocaleTimeString('uz-UZ')
                ]);
            });
        } else {
            rows.push([
                s.name || s.username,
                s.grade,
                s.username || '',
                '❌ Bajarilmadi',
                '-',
                '-',
                '-'
            ]);
        }
    }

    // Sort: completed first, then alphabetically by grade
    const header  = rows[0];
    const dataRows = rows.slice(1).sort((a, b) => {
        if (a[3] !== b[3]) return a[3] === '✅ Bajarildi' ? -1 : 1;
        return a[1].localeCompare(b[1]);
    });
    const sorted = [header, ...dataRows];

    // Build Excel file
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sorted);
    ws['!cols'] = [
        { wch: 22 }, { wch: 8 }, { wch: 18 },
        { wch: 14 }, { wch: 8 }, { wch: 26 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Hisobot');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Summary caption
    const doneCount   = dataRows.filter(r => r[3] === '✅ Bajarildi').length;
    const missedCount = dataRows.filter(r => r[3] === '❌ Bajarilmadi').length;
    const dateStr     = tashkent.toLocaleDateString('uz-UZ');
    const caption     =
        `📊 Kunlik hisobot — ${dateStr}\n\n` +
        `✅ Bajarildi: ${doneCount} ta\n` +
        `❌ Bajarilmadi: ${missedCount} ta\n` +
        `👥 Jami: ${doneCount + missedCount} ta o'quvchi`;

    const filename = `hisobot_${dateStr.replace(/\./g, '-')}.xlsx`;
    await sendDocument(token, chatId, buffer, filename, caption);
    console.log(`✅ Report sent! Done: ${doneCount}, Missed: ${missedCount}`);
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
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve(data); }
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
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve(data); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Run ────────────────────────────────────────────────────────
main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
