function getLiveWallPage(event, prompts, topPrompts, options = {}) {
    const { orgFilter = null, mode = 'default' } = options;
    const subtitle = orgFilter ? `🏢 ${orgFilter}` : '';
    const isLeaderboard = mode === 'leaderboard';

    if (isLeaderboard) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🏆 Top Prompts — ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color: white; min-height: 100vh; padding: 2rem; }
        h1 { text-align: center; font-size: 2.5rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #fbbf24, #f472b6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { text-align: center; color: rgba(255,255,255,0.6); margin-bottom: 2rem; font-size: 1.1rem; }
        .leaderboard { max-width: 900px; margin: 0 auto; }
        .entry { display: flex; gap: 1.25rem; align-items: flex-start; background: rgba(255,255,255,0.07); border-radius: 14px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; backdrop-filter: blur(6px); transition: background 0.3s; }
        .entry.top1 { background: rgba(251,191,36,0.18); border: 1px solid rgba(251,191,36,0.4); }
        .entry.top2 { background: rgba(148,163,184,0.15); border: 1px solid rgba(148,163,184,0.3); }
        .entry.top3 { background: rgba(217,119,6,0.15); border: 1px solid rgba(217,119,6,0.3); }
        .rank { font-size: 2rem; font-weight: 900; min-width: 2.5rem; text-align: center; }
        .rank.r1 { color: #fbbf24; }
        .rank.r2 { color: #94a3b8; }
        .rank.r3 { color: #d97706; }
        .body { flex: 1; }
        .prompt-text { font-size: 1.15rem; line-height: 1.5; margin-bottom: 0.5rem; }
        .meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.65; }
        .votes { font-size: 1.5rem; font-weight: 800; color: #f472b6; min-width: 3rem; text-align: right; align-self: center; }
        .empty { text-align: center; padding: 4rem; opacity: 0.5; font-size: 1.2rem; }
    </style>
</head>
<body>
    <h1>🏆 Top Prompts</h1>
    <div class="subtitle">${event.name}${orgFilter ? ' · ' + orgFilter : ''}</div>
    <div class="leaderboard" id="board">
        ${topPrompts.length ? topPrompts.map((p, i) => `
            <div class="entry ${i===0?'top1':i===1?'top2':i===2?'top3':''}" data-id="${p.id}">
                <div class="rank ${i===0?'r1':i===1?'r2':i===2?'r3':''}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1)}</div>
                <div class="body">
                    <div class="prompt-text">${p.text}</div>
                    <div class="meta">
                        ${p.org_name ? `<span>🏢 ${p.org_name}</span>` : ''}
                        ${p.app ? `<span>${p.app}</span>` : ''}
                    </div>
                </div>
                <div class="votes" id="v${p.id}">❤️ ${p.votes||0}</div>
            </div>
        `).join('') : '<div class="empty">No prompts yet</div>'}
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});
        const voteCounts = {${topPrompts.map(p => `${p.id}:${p.votes||0}`).join(',')}};
        socket.on('vote-update', ({ promptId, votes }) => {
            voteCounts[promptId] = votes;
            const el = document.getElementById('v' + promptId);
            if (el) el.textContent = '❤️ ' + votes;
        });
    </script>
</body>
</html>`;
    }

    // Default wall mode
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Wall - ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color: white; min-height: 100vh; overflow: hidden; }
        .header { background: rgba(0,0,0,0.3); padding: 1.5rem 2rem; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 2rem; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .header-right { display: flex; gap: 2rem; align-items: center; }
        .stats { display: flex; gap: 2rem; }
        .stat { text-align: center; }
        .stat-value { font-size: 2.5rem; font-weight: bold; }
        .stat-label { font-size: 0.9rem; opacity: 0.7; }
        .filter-tag { background: rgba(124,58,237,0.4); border: 1px solid rgba(124,58,237,0.6); border-radius: 20px; padding: 0.3rem 0.9rem; font-size: 0.85rem; }
        .main { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; padding: 2rem; height: calc(100vh - 100px); }
        .feed { overflow: hidden; }
        .feed h2 { margin-bottom: 1rem; font-size: 1.25rem; opacity: 0.8; }
        .feed-scroll { height: calc(100% - 40px); overflow: hidden; }
        .prompt-item { background: rgba(255,255,255,0.1); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; animation: slideIn 0.5s ease; backdrop-filter: blur(10px); }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        .prompt-item.hot { border: 2px solid #f59e0b; }
        .prompt-text { font-size: 1.1rem; line-height: 1.5; margin-bottom: 0.75rem; }
        .prompt-meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.7; }
        .prompt-org { color: #a78bfa; }
        .prompt-votes { color: #f472b6; }
        .leaderboard h2 { margin-bottom: 1rem; font-size: 1.25rem; opacity: 0.8; }
        .top-prompt { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; display: flex; gap: 1rem; align-items: flex-start; }
        .rank { font-size: 1.5rem; font-weight: bold; width: 40px; }
        .rank.gold { color: #fbbf24; }
        .rank.silver { color: #94a3b8; }
        .rank.bronze { color: #d97706; }
        .top-prompt-text { flex: 1; font-size: 0.95rem; line-height: 1.4; }
        .top-votes { color: #f472b6; font-weight: bold; white-space: nowrap; }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>🎯 ${event.name}</h1>
            ${subtitle ? `<div class="filter-tag">${subtitle}</div>` : ''}
        </div>
        <div class="header-right">
            <div class="stats">
                <div class="stat">
                    <div class="stat-value" id="promptCount">${prompts.length}</div>
                    <div class="stat-label">Prompts</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="voteCount">${prompts.reduce((s, p) => s + (p.votes || 0), 0)}</div>
                    <div class="stat-label">Votes</div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="main">
        <div class="feed">
            <h2>📢 Live Feed</h2>
            <div class="feed-scroll" id="feedScroll">
                ${prompts.map(p => `
                    <div class="prompt-item ${p.votes >= 3 ? 'hot' : ''}">
                        <div class="prompt-text">${p.text}</div>
                        <div class="prompt-meta">
                            ${p.submitter_name ? `<span>👤 ${p.submitter_name}</span>` : ''}
                            <span class="prompt-org">🏢 ${p.org_name || p.submitter_org || 'General'}</span>
                            <span class="prompt-votes">❤️ ${p.votes || 0}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="leaderboard">
            <h2>🏆 Top Prompts</h2>
            <div id="topList">
                ${topPrompts.map((p, i) => `
                    <div class="top-prompt" data-id="${p.id}">
                        <div class="rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">#${i + 1}</div>
                        <div class="top-prompt-text">${p.text.substring(0, 80)}${p.text.length > 80 ? '...' : ''}</div>
                        <div class="top-votes" id="tv${p.id}">❤️ ${p.votes || 0}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>
    
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});

        // Track per-prompt votes to compute accurate total (fixes counter drift)
        const promptVotes = {${prompts.map(p => `${p.id}:${p.votes||0}`).join(',')}};

        socket.on('new-prompt', (prompt) => {
            promptVotes[prompt.id] = 0;
            const feed = document.getElementById('feedScroll');
            const item = document.createElement('div');
            item.className = 'prompt-item';
            item.innerHTML = \`
                <div class="prompt-text">\${prompt.text}</div>
                <div class="prompt-meta">
                    \${prompt.submitter_name ? \`<span>👤 \${prompt.submitter_name}</span>\` : ''}
                    <span class="prompt-org">🏢 \${prompt.org_name || prompt.submitter_org || 'General'}</span>
                    <span class="prompt-votes">❤️ 0</span>
                </div>
            \`;
            feed.insertBefore(item, feed.firstChild);
            document.getElementById('promptCount').textContent = parseInt(document.getElementById('promptCount').textContent) + 1;
        });

        socket.on('vote-update', ({ promptId, votes }) => {
            const prev = promptVotes[promptId] || 0;
            promptVotes[promptId] = votes;
            const delta = votes - prev;
            const totalEl = document.getElementById('voteCount');
            totalEl.textContent = parseInt(totalEl.textContent) + delta;
            // Update leaderboard entry if visible
            const tvEl = document.getElementById('tv' + promptId);
            if (tvEl) tvEl.textContent = '❤️ ' + votes;
        });
    </script>
</body>
</html>`;
}

module.exports = getLiveWallPage;
