const express  = require('express');
const { Pool } = require('pg');
const app      = express();
const PORT     = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyDAJfuzKGV1aqOyvY-b6kJIwajlwe4LNkQ';

// 配信者専用パスワード（Render の Environment Variable で上書き推奨）
const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'fysc2024';

// ── PostgreSQL 接続 ──────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── テーブル初期化 ───────────────────────────────────
async function initDB() {
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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS videos (
            id           TEXT PRIMARY KEY,
            title        TEXT    NOT NULL DEFAULT 'No Title',
            channel_name TEXT    NOT NULL DEFAULT '',
            channel_icon TEXT    NOT NULL DEFAULT '',
            views        INTEGER NOT NULL DEFAULT 0,
            view_growth  INTEGER NOT NULL DEFAULT 0
        )
    `);
    console.log('DB tables ready.');
}

// ── データ読み書きヘルパー ────────────────────────────
async function getAllChannels() {
    const { rows } = await pool.query(
        'SELECT name, subs, icon, growth, views, view_growth AS "viewGrowth" FROM channels'
    );
    return rows;
}

async function getAllVideos() {
    const { rows } = await pool.query(
        `SELECT id, title, channel_name AS "channelName", channel_icon AS "channelIcon",
                views, view_growth AS "viewGrowth"
         FROM videos WHERE title IS NOT NULL AND title <> ''`
    );
    return rows;
}

// ── ユーティリティ ───────────────────────────────────
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const fetchFn = typeof fetch !== 'undefined'
    ? fetch
    : (...a) => import('node-fetch').then(m => m.default(...a));

function buildSortedChannels(channels) {
    return [...channels].sort((a, b) => b.subs - a.subs).slice(0, 50);
}

// ── 配信者専用ページ保護ミドルウェア ─────────────────
// クッキーにパスワードが入っていなければログインページにリダイレクト
function streamerOnly(req, res, next) {
    const cookie = req.headers.cookie || '';
    const match  = cookie.match(/fysc_auth=([^;]+)/);
    if (match && match[1] === STREAMER_PASSWORD) return next();
    res.redirect('/login.html');
}

// ── 認証API ─────────────────────────────────────────
// パスワード確認：正しければクッキーをセットしてリダイレクト
app.get('/api/auth', (req, res) => {
    const { pw, redirect } = req.query;
    if (pw === STREAMER_PASSWORD) {
        // 7日間有効なクッキーをセット
        res.setHeader('Set-Cookie',
            `fysc_auth=${STREAMER_PASSWORD}; Path=/; Max-Age=${60*60*24*7}; HttpOnly; SameSite=Lax`
        );
        res.redirect(redirect || '/streamer/ranking');
    } else {
        res.redirect('/login.html?error=1');
    }
});

// ── 配信者専用ルート ─────────────────────────────────
const path = require('path');

// /streamer/ranking  → index.html
app.get('/streamer/ranking', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// /streamer/battle   → Battle.html
app.get('/streamer/battle', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'Battle.html'));
});
// /streamer/fastest  → Fastest_growth.html
app.get('/streamer/fastest', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'Fastest_growth.html'));
});
// /streamer/totalsubscribers → Totalsubscribers.html
app.get('/streamer/totalsubscribers', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'Totalsubscribers.html'));
});
// /streamer/totalviews → TotalView.html
app.get('/streamer/totalviews', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'TotalView.html'));
});
// /streamer/videotop → VideoViewTOP50.html
app.get('/streamer/videotop', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'VideoViewTOP50.html'));
});
// /streamer/stats    → stats.html
app.get('/streamer/stats', streamerOnly, (_req, res) => {
    res.sendFile(path.join(__dirname, 'stats.html'));
});

// 旧URLを直打ちされたらログインにリダイレクト（念のため）
const PROTECTED_FILES = ['index.html','Battle.html','Fastest_growth.html',
    'Totalsubscribers.html','TotalView.html','VideoViewTOP50.html','stats.html'];

PROTECTED_FILES.forEach(f => {
    app.get('/' + f, streamerOnly, (req, res) => {
        res.sendFile(path.join(__dirname, f));
    });
    // 拡張子なしアクセスも念のため
    const base = f.replace('.html','').toLowerCase();
    app.get('/' + base, streamerOnly, (req, res) => {
        res.sendFile(path.join(__dirname, f));
    });
});

// ── 定期的な Growth → Subs / Views 変換 (3秒ごと) ──
setInterval(async () => {
    try {
        await pool.query(`
            UPDATE channels SET
                subs        = subs        + GREATEST(1, CEIL(growth      / 1200.0)),
                growth      = GREATEST(0, growth      - GREATEST(1, CEIL(growth      / 1200.0))),
                views       = views       + GREATEST(1, CEIL(view_growth / 1200.0)),
                view_growth = GREATEST(0, view_growth - GREATEST(1, CEIL(view_growth / 1200.0)))
            WHERE growth > 0 OR view_growth > 0
        `);
        await pool.query(`
            UPDATE videos SET
                views       = views       + GREATEST(1, CEIL(view_growth / 1200.0)),
                view_growth = GREATEST(0, view_growth - GREATEST(1, CEIL(view_growth / 1200.0)))
            WHERE view_growth > 0
        `);
    } catch (e) {
        console.error('Growth tick error:', e.message);
    }
}, 3000);

// ── ランキング順位変動検知 ────────────────────────────
let rankingVersion = 0;
let lastOrderStr   = '';

setInterval(async () => {
    try {
        const channels = await getAllChannels();
        const sorted   = buildSortedChannels(channels);
        const orderStr = sorted.map(u => u.name).join('|');
        if (orderStr !== lastOrderStr && lastOrderStr !== '') rankingVersion++;
        lastOrderStr = orderStr;
    } catch (e) {}
}, 3000);

// ── 一回限りのインポートAPI ───────────────────────────
// 使用後は IMPORT_DONE=true を Render の Environment Variable に設定して無効化
app.get('/api/import-data', async (req, res) => {
    if (process.env.IMPORT_DONE === 'true') {
        return res.send('Import already done.');
    }
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
            await pool.query('INSERT INTO channels (name,subs,icon,growth,views,view_growth) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (name) DO UPDATE SET subs=EXCLUDED.subs,icon=EXCLUDED.icon,growth=EXCLUDED.growth,views=EXCLUDED.views,view_growth=EXCLUDED.view_growth',
                [ch.name,ch.subs,ch.icon,ch.growth,ch.views,ch.viewGrowth]);
        }
        for (const v of videos) {
            await pool.query('INSERT INTO videos (id,title,channel_name,channel_icon,views,view_growth) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
                [v.id,v.title,v.channelName,v.channelIcon,v.views,v.viewGrowth]);
        }
        res.send('Import complete! ' + channels.length + ' channels, ' + videos.length + ' videos. Now set IMPORT_DONE=true in Render Environment Variables.');
    } catch(e) { res.status(500).send('Import error: ' + e.message); }
});

// ── YouTube 検索ヘルパー ──────────────────────────────
async function searchYouTubeChannel(query) {
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') return null;
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=1&key=${YOUTUBE_API_KEY}`;
        const r   = await fetchFn(url);
        const d   = await r.json();
        if (!d.items || !d.items.length) return null;
        const item = d.items[0];
        const sn   = item.snippet;
        const th   = sn.thumbnails || {};
        return {
            channelId: sn.channelId || item.id.channelId,
            name:      sn.title || query,
            icon:      (th.high || th.medium || th.default || {}).url || ''
        };
    } catch (e) { console.error('YT search error:', e.message); return null; }
}

// ── API: ranking-version ─────────────────────────────
app.get('/api/ranking-version', (_req, res) => {
    res.json({ version: rankingVersion });
});

// ── API: command ─────────────────────────────────────
const RESTRICTED    = ['video','short','stream','viral','trend','growth','subcount','viewcount'];
const videoCommands = ['video','short','stream','viral','trend'];

app.get('/api/command', async (req, res) => {
    const { user, cmd, title } = req.query;
    if (!user) return res.send('User error');

    try {
        const { rows } = await pool.query(
            'SELECT * FROM channels WHERE LOWER(name) = LOWER($1)', [user]
        );
        let ch = rows[0] || null;

        if (!ch && RESTRICTED.includes(cmd)) {
            return res.send(`@${user} You are not registered. Use !add first.`);
        }

        let message = '';

        switch (cmd) {
            case 'add': {
                const yt = await searchYouTubeChannel(user);
                if (!ch) {
                    await pool.query(
                        `INSERT INTO channels (name, subs, icon, growth, views, view_growth)
                         VALUES ($1, 0, $2, 0, 0, 0)`,
                        [user, yt ? yt.icon : '']
                    );
                    message = `@${user} Added to rankings and system.`;
                } else {
                    if (yt) await pool.query('UPDATE channels SET icon=$1 WHERE LOWER(name)=LOWER($2)', [yt.icon, user]);
                    message = `@${user} is already in the ranking!`;
                }
                break;
            }
            case 'growth':
                message = `@${user} Growth: ${(ch.growth || 0).toLocaleString()}`;
                break;
            case 'subcount':
                message = `@${user} Subscribers: ${(ch.subs || 0).toLocaleString()}`;
                break;
            case 'viewcount':
                message = `@${user} Views: ${(ch.views || 0).toLocaleString()}`;
                break;
            default: {
                if (videoCommands.includes(cmd)) {
                    let g, vg, prefix;
                    switch (cmd) {
                        case 'video':  g = rand(10, 50);   vg = rand(g*2, g*4); prefix = '[Video]';  break;
                        case 'short':  g = rand(10, 50);   vg = rand(g*2, g*4); prefix = '[Short]';  break;
                        case 'stream': g = rand(1, 350);   vg = rand(g*2, g*5); prefix = '[Stream]'; break;
                        case 'viral':  g = rand(10, 500);  vg = rand(g*3, g*6); prefix = '[Viral]';  break;
                        case 'trend':  g = rand(10, 1000); vg = rand(g*3, g*7); prefix = '[Trend]';  break;
                    }

                    await pool.query(
                        `UPDATE channels SET growth = growth + $1, view_growth = view_growth + $2
                         WHERE LOWER(name) = LOWER($3)`,
                        [g, vg, user]
                    );

                    const videoTitle = (title && title.trim() !== '') ? title.trim() : 'No Title';
                    const videoId    = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

                    const { rows: chRows } = await pool.query(
                        'SELECT icon FROM channels WHERE LOWER(name)=LOWER($1)', [user]
                    );
                    const icon = chRows[0] ? chRows[0].icon : '';

                    await pool.query(
                        `INSERT INTO videos (id, title, channel_name, channel_icon, views, view_growth)
                         VALUES ($1,$2,$3,$4,0,$5)`,
                        [videoId, videoTitle, user, icon, vg]
                    );

                    message = `${prefix} @${user} posted "${videoTitle}" (+${g} growth)`;
                } else {
                    return res.send(`Unknown command: !${cmd}`);
                }
            }
        }

        res.send(message);
    } catch (e) {
        console.error('Command error:', e.message);
        res.send('Server error. Please try again.');
    }
});

// ── API: ranking ─────────────────────────────────────
app.get('/api/ranking', async (_req, res) => {
    try {
        const channels = await getAllChannels();
        res.json({ ranking: buildSortedChannels(channels) });
    } catch (e) { res.status(500).json({ ranking: [] }); }
});

// ── API: total-stats ─────────────────────────────────
app.get('/api/total-stats', async (_req, res) => {
    try {
        const channels   = await getAllChannels();
        const totalSubs  = channels.reduce((s, u) => s + (u.subs  || 0), 0);
        const totalViews = channels.reduce((s, u) => s + (u.views || 0), 0);
        const sorted     = [...channels].sort((a, b) => b.subs - a.subs);
        res.json({ totalSubs, totalViews, count: channels.length, ranking: sorted });
    } catch (e) { res.status(500).json({ totalSubs:0, totalViews:0, count:0, ranking:[] }); }
});

// ── API: fastest-growth ──────────────────────────────
app.get('/api/fastest-growth', async (_req, res) => {
    try {
        const channels = await getAllChannels();
        const sorted = [...channels]
            .map(u => ({ ...u, growthPerHr: u.growth || 0 }))
            .sort((a, b) => b.growthPerHr - a.growthPerHr)
            .slice(0, 50);
        res.json({ channels: sorted });
    } catch (e) { res.status(500).json({ channels: [] }); }
});

// ── API: video-top50 ─────────────────────────────────
app.get('/api/video-top50', async (_req, res) => {
    try {
        const videos = await getAllVideos();
        const sorted = [...videos].sort((a, b) => b.views - a.views).slice(0, 50);
        res.json({ videos: sorted });
    } catch (e) { res.status(500).json({ videos: [] }); }
});

// ── API: YouTube Stats proxy ─────────────────────────
app.get('/api/stats/channel', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE')
        return res.json({ error:'API key not set', name:id, thumbnail:'', subscribers:0, views:0, likes:0, watching:0, isLive:false });

    try {
        const chRes  = await fetchFn(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(id)}&key=${YOUTUBE_API_KEY}`);
        const chData = await chRes.json();
        if (!chData.items || !chData.items.length)
            return res.json({ error:'Not found', name:id, thumbnail:'', subscribers:0, views:0, likes:0, watching:0, isLive:false });

        const ch      = chData.items[0];
        const snippet = ch.snippet    || {};
        const stats   = ch.statistics || {};
        const th      = snippet.thumbnails || {};
        const thumb   = (th.high || th.medium || th.default || {}).url || '';
        const isLive  = snippet.liveBroadcastContent === 'live';

        let watching = 0, likes = 0, liveViews = 0;
        if (isLive) {
            const srRes  = await fetchFn(`https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(id)}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`);
            const srData = await srRes.json();
            if (srData.items && srData.items.length) {
                const vid   = srData.items[0].id.videoId;
                const vRes  = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,statistics&id=${encodeURIComponent(vid)}&key=${YOUTUBE_API_KEY}`);
                const vData = await vRes.json();
                if (vData.items && vData.items.length) {
                    watching  = parseInt((vData.items[0].liveStreamingDetails||{}).concurrentViewers||0);
                    likes     = parseInt((vData.items[0].statistics||{}).likeCount||0);
                    liveViews = parseInt((vData.items[0].statistics||{}).viewCount||0);
                }
            }
        }

        res.json({
            name: snippet.title || id, thumbnail: thumb,
            subscribers: parseInt(stats.subscriberCount||0),
            totalViews:  parseInt(stats.viewCount||0),
            likes, watching, liveViews, isLive
        });
    } catch (e) {
        res.json({ error:e.message, name:id, thumbnail:'', subscribers:0, totalViews:0, likes:0, watching:0, liveViews:0, isLive:false });
    }
});


// ── Static files ─────────────────────────────────────
// ルートパスで静的ファイルを提供（/streamer/ 配下からでも /Default_icon.jpg が取れるよう両方登録）
app.use(express.static(path.join(__dirname)));
app.use('/streamer', express.static(path.join(__dirname)));

initDB().then(() => {
    app.listen(PORT, () => console.log(`FYSC Server running on port ${PORT}`));
}).catch(e => {
    console.error('DB init failed:', e.message);
    process.exit(1);
});
