const admin = require('firebase-admin');
const XLSX = require('xlsx');
const fetch = require('node-fetch');

// Initialize Firebase Admin with environment variables
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
});

const db = admin.firestore();

async function main() {
    console.log('📊 Starting daily report...');

    // Load settings
    const settingsDoc = await db.collection('settings').doc('main').get();
    const settings = settingsDoc.data();

    if (!settings?.token || !settings?.chatId) {
        console.log('❌ No Telegram token/chatId found in settings');
        process.exit(0);
    }

    const token  = settings.token;
    const chatId = settings.chatId;

    // Load students
    const studentsSnap = await db.collection('students').get();
    const students = studentsSnap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(s => !s.deleted);

    // Load today's results (Tashkent = UTC+5)
    const now     = new Date();
    const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const today   = tashkent.toDateString();

    const resultsSnap = await db.collection('results').get();
    const todayResults = resultsSnap.docs
        .map(d => d.data())
        .filter(r => {
            if (!r.timestamp) return false;
            const rDate = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
            return rDate.toDateString() === today && r.type === 'daily';
        });

    // Load active daily tasks
    const DAILY_ACTIVE_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const dailySnap = await db.collection('dailyTasks').get();
    const activeTasks = dailySnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(dt => dt.activatedAt && (nowMs - dt.activatedAt) < DAILY_ACTIVE_MS);

    if (!activeTasks.length) {
        console.log('No active daily tasks today');
        await sendTelegramText(token, chatId,
            `📊 Kunlik hisobot — ${tashkent.toLocaleDateString('uz-UZ')}\n\n⚠️ Bugun faol kunlik topshiriq yo'q edi.`
        );
        return;
    }

    // Build report rows
    const rows = [['Ism', 'Sinf', 'Login', 'Holat', 'Ball', 'Topshiriq', 'Vaqt']];

    for (const s of students) {
        const myTasks = activeTasks.filter(dt =>
            dt.isUniversal || (dt.grades || []).includes(s.grade)
        );
        if (!myTasks.length) continue;

        const done = todayResults.filter(r =>
            r.student === s.name && r.grade === s.grade
        );

        if (done.length) {
            done.forEach(r => {
                const rTime = new Date(new Date(r.timestamp).getTime() + 5 * 60 * 60 * 1000);
                rows.push([
                    s.name || s.username,
                    s.grade,
                    s.username,
                    '✅ Bajarildi',
                    `${r.score}/${r.total}`,
                    r.title,
                    rTime.toLocaleTimeString('uz-UZ')
                ]);
            });
        } else {
            rows.push([
                s.name || s.username,
                s.grade,
                s.username,
                '❌ Bajarilmadi',
                '-',
                '-',
                '-'
            ]);
        }
    }

    // Sort: completed first, then by grade
    const header = rows[0];
    const data   = rows.slice(1).sort((a, b) => {
        if (a[3] === b[3]) return a[1].localeCompare(b[1]);
        return a[3] === '✅ Bajarildi' ? -1 : 1;
    });
    const sorted = [header, ...data];

    // Build Excel
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sorted);
    ws['!cols'] = [
        { wch: 22 }, { wch: 8 }, { wch: 16 },
        { wch: 14 }, { wch: 8 }, { wch: 24 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Hisobot');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Summary
    const doneCount   = data.filter(r => r[3] === '✅ Bajarildi').length;
    const missedCount = data.filter(r => r[3] === '❌ Bajarilmadi').length;
    const dateStr     = tashkent.toLocaleDateString('uz-UZ');
    const caption     = `📊 Kunlik hisobot — ${dateStr}\n\n✅ Bajarildi: ${doneCount} ta\n❌ Bajarilmadi: ${missedCount} ta\nJami: ${doneCount + missedCount} ta o'quvchi`;

    // Send Excel to Telegram
    await sendTelegramDocument(token, chatId, buffer, `hisobot_${dateStr.replace(/\./g,'-')}.xlsx`, caption);
    console.log(`✅ Report sent! Done: ${doneCount}, Missed: ${missedCount}`);
}

async function sendTelegramText(token, chatId, text) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
}

async function sendTelegramDocument(token, chatId, buffer, filename, caption) {
    const { FormData, Blob } = require('node-fetch');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('document', new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), filename);

    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form
    });
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
