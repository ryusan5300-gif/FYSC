const express = require('express');
const fs      = require('fs');
const path    = require('path');
const app     = express();
const PORT    = 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

// YouTube Data API キー
const YOUTUBE_API_KEY = 'AIzaSyDAJfuzKGV1aqOyvY-b6kJIwajlwe4LNkQ';

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ channels: [], videos: [] }));

function readData() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (Array.isArray(raw)) {
            return { channels: raw, videos: [] };
        }
        return {
            channels: raw.channels || [],
            videos: raw.videos || []
        };
    } catch (e) { return { channels: [], videos: [] }; }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const fetchFn = typeof fetch !== 'undefined'
    ? fetch
    : (...a) => import('node-fetch').then(m => m.default(...a));

// ── 定期的な Growth → Subs / Views 変換 ──
setInterval(() => {
    const data = readData();
    let dirty = false;

    data.channels.forEach(u => {
        if (u.growth > 0) {
            const convert = Math.max(1, Math.ceil(u.growth / 1200));
            u.subs   += convert;
            u.growth  = Math.max(0, u.growth - convert);
            dirty = true;
        }
        if (u.viewGrowth > 0) {
            const convert = Math.max(1, Math.ceil(u.viewGrowth / 1200));
            u.views      += convert;
            u.viewGrowth  = Math.max(0, u.viewGrowth - convert);
            dirty = true;
        }
    });

    if (data.videos && data.videos.length) {
        data.videos = data.videos.filter(v => v.title);
        data.videos.forEach(v => {
            if (v.viewGrowth > 0) {
                const convert = Math.max(1, Math.ceil(v.viewGrowth / 1200));
                v.views      += convert;
                v.viewGrowth  = Math.max(0, v.viewGrowth - convert);
                dirty = true;
            }
        });
    }

    if (dirty) saveData(data);
}, 3000);

// ── ランキング順位変動検知 ──
let rankingVersion = 0;
let lastOrderStr   = '';

function buildSortedChannels(data) {
    return [...data.channels].sort((a, b) => b.subs - a.subs).slice(0, 50);
}

setInterval(() => {
    const data = readData();
    const sorted  = buildSortedChannels(data);
    const orderStr = sorted.map(u => u.name).join('|');
    if (orderStr !== lastOrderStr && lastOrderStr !== '') {
        rankingVersion++;
    }
    lastOrderStr = orderStr;
}, 3000);

app.get('/api/ranking-version', (_req, res) => {
    res.json({ version: rankingVersion });
});

// ── YouTube 検索ヘルパー ──
async function searchYouTubeChannel(query) {
    if (YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') return null;
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

// ── コマンド API（title 強制 "No Title" に対応） ──
const RESTRICTED = ['video','short','stream','viral','trend','growth','subcount','viewcount'];

app.get('/api/command', async (req, res) => {
    const { user, cmd, title } = req.query;
    if (!user) return res.send('❌ User error');

    const data = readData();
    let idx    = data.channels.findIndex(u => u.name.toLowerCase() === user.toLowerCase());

    if (idx === -1 && RESTRICTED.includes(cmd)) {
        return res.send(`⚠️ @${user} You are not registered in the system & ranking. Use !add first.`);
    }

    let message = '';

    const videoCommands = ['video','short','stream','viral','trend'];

    switch (cmd) {
        case 'add': {
            const yt = await searchYouTubeChannel(user);
            if (idx === -1) {
                data.channels.push({
                    name: user,
                    subs: 0,
                    icon: yt ? yt.icon : '',
                    growth: 0,
                    views: 0,
                    viewGrowth: 0
                });
                idx = data.channels.length - 1;
                message = `@${user} Added to rankings and system.`;
            } else {
                if (yt) { data.channels[idx].icon = yt.icon; }
                message = `✅ @${user} is already in the ranking!`;
            }
            break;
        }
        case 'growth':   { message = `📊 @${user} Growth: ${data.channels[idx].growth.toLocaleString()}`; break; }
        case 'subcount': { message = `📺 @${user} Subscribers: ${data.channels[idx].subs.toLocaleString()}`; break; }
        case 'viewcount': { message = `👁️ @${user} Views: ${(data.channels[idx].views || 0).toLocaleString()}`; break; }
        default: {
            if (videoCommands.includes(cmd)) {
                let g, vg, prefix;
                switch (cmd) {
                    case 'video':  g = rand(10, 50); vg = rand(g * 2, g * 4); prefix = '🎬'; break;
                    case 'short':  g = rand(10, 50); vg = rand(g * 2, g * 4); prefix = '📱'; break;
                    case 'stream': g = rand(1, 350); vg = rand(g * 2, g * 5); prefix = '🔴'; break;
                    case 'viral':  g = rand(10, 500); vg = rand(g * 3, g * 6); prefix = '🚀'; break;
                    case 'trend':  g = rand(10, 1000); vg = rand(g * 3, g * 7); prefix = '📈'; break;
                }

                // チャンネル成長を加算
                data.channels[idx].growth    += g;
                data.channels[idx].viewGrowth += vg;

                // ★ 動画タイトルがない場合は "No Title" に強制
                const videoTitle = (title && title.trim() !== '') ? title.trim() : 'No Title';

                const videoId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                const ch = data.channels[idx];
                data.videos.push({
                    id: videoId,
                    title: videoTitle,
                    channelName: ch.name,
                    channelIcon: ch.icon || '',
                    views: 0,
                    viewGrowth: vg   // 動画の再生回数成長を設定
                });

                message = `${prefix} @${user} posted ${cmd}: ${videoTitle}!`;
            } else {
                return res.send(`❓ Unknown command: !${cmd}`);
            }
        }
    }

    saveData(data);
    res.send(message);
});

// ── チャンネルランキング API ──
app.get('/api/ranking', (_req, res) => {
    const data = readData();
    res.json({ ranking: buildSortedChannels(data) });
});

// ── 合計統計 API ──
app.get('/api/total-stats', (_req, res) => {
    const data = readData();
    const totalSubs  = data.channels.reduce((sum, u) => sum + (u.subs  || 0), 0);
    const totalViews = data.channels.reduce((sum, u) => sum + (u.views || 0), 0);
    const sorted = [...data.channels].sort((a, b) => b.subs - a.subs);
    res.json({ totalSubs, totalViews, count: data.channels.length, ranking: sorted });
});

// ── 最速成長 API ──
app.get('/api/fastest-growth', (_req, res) => {
    const data = readData();
    const sorted = [...data.channels]
        .map(u => ({ ...u, growthPerHr: u.growth || 0 }))
        .sort((a, b) => b.growthPerHr - a.growthPerHr)
        .slice(0, 50);
    res.json({ channels: sorted });
});

// ── 動画TOP50 API ──
app.get('/api/video-top50', (_req, res) => {
    const data = readData();
    const sorted = [...data.videos]
        .sort((a, b) => b.views - a.views)
        .slice(0, 50);
    res.json({ videos: sorted });
});

// ── YouTube Stats proxy (変更なし) ──
app.get('/api/stats/channel', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE')
        return res.json({ error: 'API key not set', name:id, thumbnail:'', subscribers:0, views:0, likes:0, watching:0, isLive:false });

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
            likes, watching,
            liveViews,
            isLive
        });
    } catch (e) {
        res.json({ error:e.message, name:id, thumbnail:'', subscribers:0, totalViews:0, likes:0, watching:0, liveViews:0, isLive:false });
    }
});

app.use(express.static('.'));
app.listen(PORT, () => console.log(`✅ FYSC Server → http://localhost:${PORT}`));