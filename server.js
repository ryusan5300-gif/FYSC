const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const crypto   = require('crypto');
const app      = express();
const PORT     = process.env.PORT || 3000;

const YOUTUBE_API_KEY   = process.env.YOUTUBE_API_KEY   || 'AIzaSyDAJfuzKGV1aqOyvY-b6kJIwajlwe4LNkQ';
const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'fysc2024';

app.use(express.json());

// ── PostgreSQL 接続 ──────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── ユーティリティ & YouTube 検索 ────────────────────
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const fetchFn = typeof fetch !== 'undefined'
    ? fetch
    : (...a) => import('node-fetch').then(m => m.default(...a));

// YouTube 検索・情報取得ヘルパー (チャンネルID、名前、アイコンを返却)
async function searchYouTubeChannel(query) {
    if (!query) return null;
    const q = query.trim();
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') return null;
    try {
        // UCから始まる24文字の場合は直接 channels API を試行
        if (q.startsWith('UC') && q.length === 24) {
            const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
            const r = await fetchFn(url);
            const d = await r.json();
            if (d.items && d.items.length) {
                const item = d.items[0];
                const sn = item.snippet || {};
                const th = sn.thumbnails || {};
                return {
                    channelId: item.id,
                    name: sn.title || query,
                    icon: (th.high || th.medium || th.default || {}).url || ''
                };
            }
        }
        // それ以外（ハンドル名やキーワード）は search API
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(q)}&maxResults=1&key=${YOUTUBE_API_KEY}`;
        const r   = await fetchFn(url);
        const d   = await r.json();
        if (!d.items || !d.items.length) return null;
        const item = d.items[0];
        const sn   = item.snippet;
        const th   = sn.thumbnails || {};
        return {
            channelId: item.id.channelId || sn.channelId || q,
            name:      sn.title || query,
            icon:      (th.high || th.medium || th.default || {}).url || ''
        };
    } catch (e) { console.error('YT search error:', e.message); return null; }
}

// ── テーブル初期化 & データマイグレーション ─────────────
async function initDB() {
    // channels テーブル作成 (id を主キー候補として追加)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS channels (
            name        TEXT PRIMARY KEY,
            subs        INTEGER NOT NULL DEFAULT 0,
            icon        TEXT    NOT NULL DEFAULT '',
            growth      INTEGER NOT NULL DEFAULT 0,
            views       INTEGER NOT NULL DEFAULT 0,
            view_growth INTEGER NOT NULL DEFAULT 0
        )
    `);
    // id カラムを安全に追加
    try {
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS id TEXT;`);
    } catch(e) {}

    await pool.query(`
        CREATE TABLE IF NOT EXISTS videos (
            id           TEXT PRIMARY KEY,
            title        TEXT    NOT NULL DEFAULT 'No Title',
            channel_id   TEXT    NOT NULL DEFAULT '',
            channel_name TEXT    NOT NULL DEFAULT '',
            channel_icon TEXT    NOT NULL DEFAULT '',
            views        INTEGER NOT NULL DEFAULT 0,
            view_growth  INTEGER NOT NULL DEFAULT 0
        )
    `);
    try {
        await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS channel_id TEXT DEFAULT '';`);
    } catch(e) {}

    await pool.query(`
        CREATE TABLE IF NOT EXISTS connect_sessions (
            token        TEXT PRIMARY KEY,
            code         TEXT NOT NULL,
            channel_id   TEXT,
            channel_name TEXT,
            channel_icon TEXT,
            connected    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at   BIGINT  NOT NULL
        )
    `);
    try {
        await pool.query(`ALTER TABLE connect_sessions ADD COLUMN IF NOT EXISTS channel_id TEXT;`);
    } catch(e) {}

    // 既存チャンネルの id マイグレーション
    await migrateChannels();

    console.log('DB tables ready.');
}

// 既存チャンネルデータの ID 補填マイグレーション
async function migrateChannels() {
    try {
        const { rows } = await pool.query(`SELECT name, icon FROM channels WHERE id IS NULL OR id = ''`);
        if (!rows.length) return;
        console.log(`Migrating ${rows.length} channels to use YouTube Channel IDs...`);
        for (const row of rows) {
            const yt = await searchYouTubeChannel(row.name);
            const channelId = (yt && yt.channelId) ? yt.channelId : row.name;
            const updatedName = (yt && yt.name) ? yt.name : row.name;
            const updatedIcon = (yt && yt.icon) ? yt.icon : row.icon;

            await pool.query(
                `UPDATE channels SET id = $1, name = $2, icon = COALESCE(NULLIF($3, ''), icon) WHERE name = $4`,
                [channelId, updatedName, updatedIcon, row.name]
            );
            console.log(`Migrated: ${row.name} -> ID: ${channelId}`);
        }
    } catch (e) {
        console.error('Migration error:', e.message);
    }
}

// ── データ読み書きヘルパー ────────────────────────────
async function getAllChannels() {
    const { rows } = await pool.query(
        'SELECT COALESCE(NULLIF(id, \'\'), name) AS id, name, subs, icon, growth, views, view_growth AS "viewGrowth" FROM channels'
    );
    return rows;
}

async function findChannel(queryStr) {
    if (!queryStr) return null;
    const q = queryStr.trim();
    const { rows } = await pool.query(
        `SELECT id, name, subs, icon, growth, views, view_growth FROM channels
         WHERE LOWER(id) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
        [q]
    );
    return rows[0] || null;
}

async function getAllVideos() {
    const { rows } = await pool.query(
        `SELECT id, title, channel_id AS "channelId", channel_name AS "channelName", channel_icon AS "channelIcon",
                views, view_growth AS "viewGrowth"
         FROM videos WHERE title IS NOT NULL AND title <> ''`
    );
    return rows;
}

function buildSortedChannels(channels) {
    return [...channels].sort((a, b) => b.subs - a.subs).slice(0, 50);
}

// ── 配信者専用保護ミドルウェア ────────────────────────
function streamerOnly(req, res, next) {
    if (req.query.password === STREAMER_PASSWORD) {
        res.setHeader('Set-Cookie',
            `fysc_auth=${STREAMER_PASSWORD}; Path=/; Max-Age=${60*60*24*30}; SameSite=Lax`
        );
        return next();
    }
    const cookie = req.headers.cookie || '';
    const match  = cookie.match(/fysc_auth=([^;]+)/);
    if (match && match[1] === STREAMER_PASSWORD) return next();
    res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
}

// ── 認証API (既存) ───────────────────────────────────
app.get('/api/auth', (req, res) => {
    const { pw, redirect } = req.query;
    if (pw === STREAMER_PASSWORD) {
        res.setHeader('Set-Cookie',
            `fysc_auth=${STREAMER_PASSWORD}; Path=/; Max-Age=${60*60*24*30}; SameSite=Lax`
        );
        res.redirect(redirect || '/streamer/ranking');
    } else {
        res.redirect('/login.html?error=1');
    }
});

// ════════════════════════════════════════════════════════════════
//  !connect ログイン API
// ════════════════════════════════════════════════════════════════

// 期限切れセッションを定期削除 (130秒以上経過)
setInterval(async () => {
    try {
        await pool.query(
            `DELETE FROM connect_sessions WHERE created_at < $1`,
            [Date.now() - 130_000]
        );
    } catch(e) {}
}, 60_000);

// POST /api/auth/connect-code
// player.html から呼ばれる。6桁コードと検証用トークンを生成して返す
app.post('/api/auth/connect-code', async (req, res) => {
    try {
        const code  = String(Math.floor(100_000 + Math.random() * 900_000));
        const token = crypto.randomBytes(20).toString('hex');
        await pool.query(
            `INSERT INTO connect_sessions (token, code, connected, created_at)
             VALUES ($1, $2, FALSE, $3)`,
            [token, code, Date.now()]
        );
        res.json({ code, token, expiresIn: 120 });
    } catch(e) {
        console.error('connect-code error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/auth/connect-status?token=xxx
// player.html がポーリングして認証完了を検知する
app.get('/api/auth/connect-status', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.json({ connected: false });
    try {
        const { rows } = await pool.query(
            `SELECT connected, channel_name, channel_icon FROM connect_sessions WHERE token=$1`,
            [token]
        );
        if (!rows.length) return res.json({ connected: false });
        const row = rows[0];
        if (!row.connected) return res.json({ connected: false });
        res.json({
            connected: true,
            user: { name: row.channel_name, icon: row.channel_icon || '' }
        });
    } catch(e) {
        res.json({ connected: false });
    }
});

// POST /api/auth/connect-verify
// チャットBot (Twitch/YouTube Bot) から呼ばれる。
// !connect <code> コマンドを受信したら、このエンドポイントをPOSTする。
//
// Body: { code: "123456", channelName: "@YourChannel", channelIcon: "https://..." }
//
// チャットBotでの使い方例 (Node.js Bot):
//   const res = await fetch('http://localhost:3000/api/auth/connect-verify', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ code, channelName: user, channelIcon: icon })
//   });
//
app.post('/api/auth/connect-verify', async (req, res) => {
    const { code, channelName, channelIcon } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });

    try {
        const { rows } = await pool.query(
            `SELECT token, created_at FROM connect_sessions
             WHERE code=$1 AND connected=FALSE
             ORDER BY created_at DESC LIMIT 1`,
            [String(code)]
        );
        if (!rows.length) {
            return res.status(404).json({ ok: false, error: 'Code not found or already used' });
        }
        const row = rows[0];
        // 期限チェック (120秒)
        if (Date.now() - Number(row.created_at) > 120_000) {
            await pool.query(`DELETE FROM connect_sessions WHERE token=$1`, [row.token]);
            return res.status(410).json({ ok: false, error: 'Code expired' });
        }
        // 認証完了フラグをセット
        await pool.query(
            `UPDATE connect_sessions
             SET connected=TRUE, channel_name=$1, channel_icon=$2
             WHERE token=$3`,
            [channelName || '', channelIcon || '', row.token]
        );
        res.json({ ok: true });
    } catch(e) {
        console.error('connect-verify error:', e.message);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// ════════════════════════════════════════════════════════════════
//  配信者専用ルート
// ════════════════════════════════════════════════════════════════
app.get('/streamer/ranking',          streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/streamer/battle',           streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'Battle.html')));
app.get('/streamer/fastest',          streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'Fastest_growth.html')));
app.get('/streamer/totalsubscribers', streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'Totalsubscribers.html')));
app.get('/streamer/totalviews',       streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'TotalView.html')));
app.get('/streamer/videotop',         streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'VideoViewTOP50.html')));
app.get('/streamer/stats',            streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

// 直打ちアクセスも保護
const PROTECTED_FILES = [
    'index.html','Battle.html','Fastest_growth.html',
    'Totalsubscribers.html','TotalView.html','VideoViewTOP50.html','stats.html'
];
PROTECTED_FILES.forEach(f => {
    app.get('/' + f, streamerOnly, (_req, res) => res.sendFile(path.join(__dirname, f)));
});

// ════════════════════════════════════════════════════════════════
//  定期処理
// ════════════════════════════════════════════════════════════════

// Growth → Subs / Views 変換 (3秒ごと、チャンネルごとにランダム遅延 0〜3秒)
async function runGrowthTick() {
    try {
        const { rows } = await pool.query(
            `SELECT name FROM channels WHERE growth > 0 OR view_growth > 0`
        );
        for (const row of rows) {
            const delay = Math.floor(Math.random() * 3000);
            setTimeout(async () => {
                try {
                    await pool.query(`
                        UPDATE channels SET
                            subs        = GREATEST(1, subs + GREATEST(1, CEIL(growth / 1200.0))),
                            growth      = GREATEST(0, growth      - GREATEST(1, CEIL(growth      / 1200.0))),
                            views       = views       + GREATEST(1, CEIL(view_growth / 1200.0)),
                            view_growth = GREATEST(0, view_growth - GREATEST(1, CEIL(view_growth / 1200.0)))
                        WHERE name = $1
                    `, [row.name]);
                } catch (e) { console.error('Channel tick error:', e.message); }
            }, delay);
        }
        const { rows: vrows } = await pool.query(
            `SELECT id FROM videos WHERE view_growth > 0`
        );
        for (const vrow of vrows) {
            const delay = Math.floor(Math.random() * 3000);
            setTimeout(async () => {
                try {
                    await pool.query(`
                        UPDATE videos SET
                            views       = views       + GREATEST(1, CEIL(view_growth / 1200.0)),
                            view_growth = GREATEST(0, view_growth - GREATEST(1, CEIL(view_growth / 1200.0)))
                        WHERE id = $1
                    `, [vrow.id]);
                } catch (e) { console.error('Video tick error:', e.message); }
            }, delay);
        }
    } catch (e) { console.error('Growth tick error:', e.message); }
}
setInterval(runGrowthTick, 3000);

// 自然減少 (Decay) — growth=0 かつ subs>1 のチャンネルは60秒ごとに微量減少
async function runDecayTick() {
    try {
        const { rows } = await pool.query(
            `SELECT name FROM channels WHERE growth = 0 AND subs > 1`
        );
        for (const row of rows) {
            const delay = Math.floor(Math.random() * 60000);
            setTimeout(async () => {
                try {
                    await pool.query(`
                        UPDATE channels
                        SET subs = GREATEST(1, subs - LEAST(5, GREATEST(1, FLOOR(subs * 0.00008)::int)))
                        WHERE name = $1 AND growth = 0 AND subs > 1
                    `, [row.name]);
                } catch (e) { console.error('Decay channel error:', e.message); }
            }, delay);
        }
    } catch (e) { console.error('Decay tick error:', e.message); }
}
setInterval(runDecayTick, 60000);

// ランキング順位変動検知
let rankingVersion = 0;
let lastOrderStr   = '';

async function checkRankingVersion() {
    try {
        const channels = await getAllChannels();
        const sorted   = buildSortedChannels(channels);
        const orderStr = sorted.map(u => u.name).join('|');
        if (orderStr !== lastOrderStr && lastOrderStr !== '') rankingVersion++;
        lastOrderStr = orderStr;
    } catch (e) {}
}
setInterval(() => setTimeout(checkRankingVersion, 3500), 3000);

// ════════════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════════════

// インポートAPI (一回限り)
app.get('/api/import-data', async (req, res) => {
    if (process.env.IMPORT_DONE === 'true') return res.send('Import already done.');
    const { secret } = req.query;
    if (secret !== STREAMER_PASSWORD) return res.status(403).send('Forbidden');
    try {
        const channels = [
            {name:'@ryushorts5300v2',subs:47607,icon:'https://yt3.ggpht.com/RSfHfY2m_0ky-vqSsbS5zzdffBWjaeeahsXjwVT7wKLioKjy4DxOnV7wLdBJpSEa1w3ZobBTEQ=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:6198,viewGrowth:0},
            {name:'@I_DunnoLOLL',subs:65097,icon:'https://yt3.ggpht.com/HP_4YiG5fqNfdE5MISegstXk9qnP6vtti4kfKEiG1MB8dqvo2uvtTycLI6SjVO_cCWOGsLAN=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:0,viewGrowth:0},
            {name:'@SupermanBloxJP',subs:39530,icon:'https://yt3.ggpht.com/YWahipoL-mqyZTCsl9WIOXm-S-MygBJzhrhYmr9qPCLGdDVpB-xo2TVIiaGW1S6fkTsjhMGT=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:0,viewGrowth:0},
            {name:'@AarusheditsOP',subs:19822,icon:'https://yt3.ggpht.com/Lc_wJK5lX4vRXgCib3ttpDMp_Mx6jNfdDwfp54xVtrW31a8X4BshLJCJsNzXmj5cN0zjUCVFMg=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:0,viewGrowth:0},
            {name:'@Charliedan06',subs:1722,icon:'https://yt3.ggpht.com/EgSS0XYcrvgl0KlHvocnq2QQozyEFZLC9_v1Rcfj2Ur_oej06rUDf3LCWth3ANY_A9gp0muqAA=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:6389,viewGrowth:0},
            {name:'@wadman12-n6t',subs:263,icon:'',growth:0,views:836,viewGrowth:0},
            {name:'@IndiaYeshins',subs:118,icon:'',growth:0,views:552,viewGrowth:0},
            {name:'@환장강',subs:15408,icon:'https://yt3.ggpht.com/V1mmiN_2gd2dIS6vOyCOl1Wceb8bNmn1jrtYC5qVTxgAkMhSecs1Y6ePbDGyqdt7oBK9m9F6JQ=s800-c-k-c0xffffffff-no-rj-mo',growth:0,views:71370,viewGrowth:284}
        ];
        const videos = [
            {id:'mova91pc83a23',title:'No Title',channelName:'@ryushorts5300v2',channelIcon:'https://yt3.ggpht.com/RSfHfY2m_0ky-vqSsbS5zzdffBWjaeeahsXjwVT7wKLioKjy4DxOnV7wLdBJpSEa1w3ZobBTEQ=s800-c-k-c0xffffffff-no-rj-mo',views:78,viewGrowth:0}
        ];
        for (const ch of channels) {
            await pool.query(
                `INSERT INTO channels (name,subs,icon,growth,views,view_growth) VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (name) DO UPDATE SET subs=EXCLUDED.subs,icon=EXCLUDED.icon,
                 growth=EXCLUDED.growth,views=EXCLUDED.views,view_growth=EXCLUDED.view_growth`,
                [ch.name,ch.subs,ch.icon,ch.growth,ch.views,ch.viewGrowth]);
        }
        for (const v of videos) {
            await pool.query(
                `INSERT INTO videos (id,title,channel_name,channel_icon,views,view_growth) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
                [v.id,v.title,v.channelName,v.channelIcon,v.views,v.viewGrowth]);
        }
        res.send(`Import complete! ${channels.length} channels, ${videos.length} videos. Now set IMPORT_DONE=true in Render Environment Variables.`);
    } catch(e) { res.status(500).send('Import error: ' + e.message); }
});

// ── API: command ─────────────────────────────────────
const RESTRICTED    = ['video','short','stream','viral','trend','growth','subcount','viewcount'];
const videoCommands = ['video','short','stream','viral','trend'];

app.get('/api/command', async (req, res) => {
    const { user, cmd, title } = req.query;
    const authPw = req.query.password || req.query.pw || req.query.secret;
    if (authPw !== STREAMER_PASSWORD) {
        return res.status(403).send('Forbidden: Invalid password');
    }
    if (!user) return res.send('User error');

    // ── !connect <code> 処理 ─────────────────────────
    if (cmd === 'connect') {
        const code = (req.query.code || req.query.querystring || '').trim();
        if (!code) return res.send(`@${user} Please provide a code. Example: !connect 123456`);
        try {
            const ch = await findChannel(user);
            const channelName = ch ? ch.name : user;
            const channelIcon = ch ? ch.icon : '';
            const channelId   = ch ? ch.id   : '';

            const { rows } = await pool.query(
                `SELECT token, created_at FROM connect_sessions
                 WHERE code=$1 AND connected=FALSE
                 ORDER BY created_at DESC LIMIT 1`,
                [String(code)]
            );
            if (!rows.length) return res.send(`@${user} Code not found or already used. Please generate a new code.`);
            if (Date.now() - Number(rows[0].created_at) > 120_000) {
                await pool.query(`DELETE FROM connect_sessions WHERE token=$1`, [rows[0].token]);
                return res.send(`@${user} Code expired. Please generate a new code.`);
            }
            await pool.query(
                `UPDATE connect_sessions SET connected=TRUE, channel_id=$1, channel_name=$2, channel_icon=$3 WHERE token=$4`,
                [channelId, channelName, channelIcon, rows[0].token]
            );
            return res.send(`@${user} ✅ Successfully connected! You are now logged in.`);
        } catch(e) {
            console.error('connect command error:', e.message);
            return res.send(`@${user} Server error. Please try again.`);
        }
    }

    try {
        let ch = await findChannel(user);
        if (!ch && RESTRICTED.includes(cmd)) return res.send(`@${user} You are not registered. Use !add first.`);
        let message = '';
        switch (cmd) {
            case 'add': {
                const yt = await searchYouTubeChannel(user);
                const channelId   = (yt && yt.channelId) ? yt.channelId : user;
                const channelName = (yt && yt.name)      ? yt.name      : user;
                const channelIcon = (yt && yt.icon)      ? yt.icon      : '';

                if (!ch) ch = await findChannel(channelId);

                if (!ch) {
                    await pool.query(
                        `INSERT INTO channels (id, name, subs, icon, growth, views, view_growth)
                         VALUES ($1, $2, 0, $3, 0, 0, 0)`,
                        [channelId, channelName, channelIcon]
                    );
                    message = `@${user} Added to rankings and system.`;
                } else {
                    if (yt) {
                        await pool.query(
                            `UPDATE channels SET name=$1, icon=COALESCE(NULLIF($2, ''), icon)
                             WHERE id=$3 OR LOWER(name)=LOWER($4)`,
                            [channelName, channelIcon, ch.id || channelId, user]
                        );
                    }
                    message = `@${user} is already in the ranking!`;
                }
                break;
            }
            case 'refresh': {
                rankingVersion++;
                message = `@${user} 🔄 Refreshed! Reloading index.html...`;
                break;
            }
            case 'growth':    message = `@${user} Growth: ${(ch.growth||0).toLocaleString()}`; break;
            case 'subcount':  message = `@${user} Subscribers: ${(ch.subs||0).toLocaleString()}`; break;
            case 'viewcount': message = `@${user} Views: ${(ch.views||0).toLocaleString()}`; break;
            default: {
                if (videoCommands.includes(cmd)) {
                    let g, vg;
                    switch(cmd) {
                        case 'video':  g=rand(10,50);   vg=rand(g*2,g*4); break;
                        case 'short':  g=rand(10,50);   vg=rand(g*2,g*4); break;
                        case 'stream': g=rand(1,350);   vg=rand(g*2,g*5); break;
                        case 'viral':  g=rand(10,500);  vg=rand(g*3,g*6); break;
                        case 'trend':  g=rand(10,1000); vg=rand(g*3,g*7); break;
                    }
                    const targetId = ch.id || ch.name;
                    await pool.query(
                        `UPDATE channels SET growth=growth+$1, view_growth=view_growth+$2 WHERE id=$3 OR LOWER(name)=LOWER($4)`,
                        [g, vg, targetId, user]
                    );
                    const qs = req.query;
                    const rawTitle = [
                        qs.title, qs.q, qs.message, qs.text, qs.arg, qs['1']
                    ].map(v => (v || '').trim()).filter(v => v !== '' && v !== 'undefined').find(Boolean) || '';
                    const videoTitle = rawTitle !== '' ? rawTitle : 'No Title';
                    const videoId    = Date.now().toString(36)+Math.random().toString(36).substr(2,5);
                    const icon = ch ? ch.icon : '';
                    await pool.query(
                        `INSERT INTO videos (id, title, channel_id, channel_name, channel_icon, views, view_growth)
                         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
                        [videoId, videoTitle, targetId, ch.name || user, icon, vg]
                    );
                    message = `@${user} Posted a Video "${videoTitle}"`;
                } else {
                    return res.send(`Unknown command: !${cmd}`);
                }
            }
        }
        res.send(message);
    } catch(e) { console.error('Command error:',e.message); res.send('Server error. Please try again.'); }
});

// ── API: ranking-version ─────────────────────────────
app.get('/api/ranking-version', (_req, res) => res.json({ version: rankingVersion }));

// ── API: ranking ─────────────────────────────────────
app.get('/api/ranking', async (_req, res) => {
    try { const channels=await getAllChannels(); res.json({ranking:buildSortedChannels(channels)}); }
    catch(e) { res.status(500).json({ranking:[]}); }
});

// ── API: total-stats ─────────────────────────────────
app.get('/api/total-stats', async (_req, res) => {
    try {
        const channels=await getAllChannels();
        const totalSubs=channels.reduce((s,u)=>s+(u.subs||0),0);
        const totalViews=channels.reduce((s,u)=>s+(u.views||0),0);
        res.json({totalSubs,totalViews,count:channels.length,ranking:[...channels].sort((a,b)=>b.subs-a.subs)});
    } catch(e) { res.status(500).json({totalSubs:0,totalViews:0,count:0,ranking:[]}); }
});

// ── API: fastest-growth ──────────────────────────────
app.get('/api/fastest-growth', async (_req, res) => {
    try {
        const channels=await getAllChannels();
        const sorted=[...channels].map(u=>({...u,growthPerHr:u.growth||0})).sort((a,b)=>b.growthPerHr-a.growthPerHr).slice(0,50);
        res.json({channels:sorted});
    } catch(e) { res.status(500).json({channels:[]}); }
});

// ── API: video-top50 ─────────────────────────────────
app.get('/api/video-top50', async (_req, res) => {
    try { const videos=await getAllVideos(); res.json({videos:[...videos].sort((a,b)=>b.views-a.views).slice(0,50)}); }
    catch(e) { res.status(500).json({videos:[]}); }
});

// ── API: suggest ─────────────────────────────────────
app.get('/api/suggest', async (req, res) => {
    const q=(req.query.q||'').toLowerCase().trim();
    if(!q) return res.json({channels:[]});
    try {
        const channels=await getAllChannels();
        const matched=channels
            .filter(ch=>ch.name.toLowerCase().includes(q))
            .sort((a,b)=>b.subs-a.subs).slice(0,4)
            .map(ch=>({name:ch.name,icon:ch.icon||'',subs:ch.subs}));
        res.json({channels:matched});
    } catch(e) { res.json({channels:[]}); }
});

// ── API: YouTube Stats proxy ─────────────────────────
app.get('/api/stats/channel', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({error:'Missing id'});
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY==='YOUR_YOUTUBE_API_KEY_HERE')
        return res.json({error:'API key not set',name:id,thumbnail:'',subscribers:0,views:0,likes:0,watching:0,isLive:false});
    try {
        const chRes=await fetchFn(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(id)}&key=${YOUTUBE_API_KEY}`);
        const chData=await chRes.json();
        if (!chData.items||!chData.items.length)
            return res.json({error:'Not found',name:id,thumbnail:'',subscribers:0,views:0,likes:0,watching:0,isLive:false});
        const ch=chData.items[0];
        const snippet=ch.snippet||{};
        const stats=ch.statistics||{};
        const th=snippet.thumbnails||{};
        const thumb=(th.high||th.medium||th.default||{}).url||'';
        const isLive=snippet.liveBroadcastContent==='live';
        let watching=0,likes=0,liveViews=0;
        if (isLive) {
            const srRes=await fetchFn(`https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(id)}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`);
            const srData=await srRes.json();
            if (srData.items&&srData.items.length) {
                const vid=srData.items[0].id.videoId;
                const vRes=await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,statistics&id=${encodeURIComponent(vid)}&key=${YOUTUBE_API_KEY}`);
                const vData=await vRes.json();
                if (vData.items&&vData.items.length) {
                    watching=parseInt((vData.items[0].liveStreamingDetails||{}).concurrentViewers||0);
                    likes=parseInt((vData.items[0].statistics||{}).likeCount||0);
                    liveViews=parseInt((vData.items[0].statistics||{}).viewCount||0);
                }
            }
        }
        res.json({name:snippet.title||id,thumbnail:thumb,subscribers:parseInt(stats.subscriberCount||0),
            totalViews:parseInt(stats.viewCount||0),likes,watching,liveViews,isLive});
    } catch(e) { res.json({error:e.message,name:id,thumbnail:'',subscribers:0,totalViews:0,likes:0,watching:0,liveViews:0,isLive:false}); }
});

// ── トップページ → player.html（視聴者向け）──────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'player.html')));

// ── Static files ─────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use('/streamer', express.static(path.join(__dirname)));

initDB().then(() => {
    app.listen(PORT, () => console.log(`FYSC Server running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
