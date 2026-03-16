const footer = require('./_footer');

function getParticipatePage(event, attendee, orgPrompts, allPrompts, userVotes) {
    const apps = ['Word', 'Excel', 'PowerPoint', 'Outlook', 'Teams', 'General'];
    
    const renderPrompt = (p, isOrg = false) => {
        const voted = userVotes.includes(p.id);
        return `
            <div class="prompt-card ${isOrg ? 'org-prompt' : ''}">
                <div class="prompt-text">${p.text}</div>
                <div class="prompt-meta">
                    <span class="app-badge">${p.app || 'General'}</span>
                    ${p.org_name && !isOrg ? `<span class="org-badge">${p.org_name}</span>` : ''}
                    ${p.source === 'generated' ? '<span class="gen-badge">🤖 AI</span>' : ''}
                </div>
                <div class="prompt-actions">
                    <button class="vote-btn ${voted ? 'voted' : ''}" onclick="toggleVote(${p.id}, this)">
                        ${voted ? '❤️' : '🤍'} <span class="vote-count">${p.vote_count || p.votes || 0}</span>
                    </button>
                    <button class="copy-btn" onclick="copyPrompt(this, \`${p.text.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`)">📋 Copy</button>
                </div>
            </div>
        `;
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${event.name} - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; --accent: #7c3aed; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.5rem; text-align: center; }
        .header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
        .welcome { font-size: 1rem; opacity: 0.9; }
        .tabs { display: flex; background: var(--card); border-bottom: 2px solid #e0e0e0; position: sticky; top: 0; z-index: 10; }
        .tab { flex: 1; padding: 1rem; text-align: center; cursor: pointer; font-weight: 600; border-bottom: 3px solid transparent; transition: all 0.2s; }
        .tab:hover { background: #f9fafb; }
        .tab.active { border-bottom-color: var(--primary); color: var(--primary); }
        .tab-count { background: #e0e0e0; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.8rem; margin-left: 0.5rem; }
        .tab.active .tab-count { background: var(--primary); color: white; }
        .container { max-width: 600px; margin: 0 auto; padding: 1rem; }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .prompt-card { background: var(--card); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .prompt-card.org-prompt { border-left: 4px solid var(--accent); }
        .prompt-text { font-size: 1rem; line-height: 1.5; margin-bottom: 0.75rem; }
        .prompt-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
        .app-badge { background: #e0f2fe; color: #0369a1; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
        .org-badge { background: #f3e8ff; color: #7c3aed; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; }
        .gen-badge { background: #fef3c7; color: #92400e; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; }
        .prompt-actions { display: flex; gap: 0.5rem; }
        .vote-btn, .copy-btn { padding: 0.5rem 1rem; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; }
        .vote-btn { background: #f3f4f6; }
        .vote-btn.voted { background: #fef2f2; color: #dc2626; }
        .vote-btn:hover { transform: scale(1.05); }
        .copy-btn { background: #f3f4f6; }
        .copy-btn.copied { background: #d1fae5; color: #065f46; }
        .submit-card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .submit-card h3 { margin-bottom: 1rem; font-size: 1rem; }
        .submit-card textarea { width: 100%; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 1rem; resize: vertical; min-height: 80px; font-family: inherit; }
        .submit-card textarea:focus { outline: none; border-color: var(--primary); }
        .submit-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
        .submit-row select { flex: 1; padding: 0.5rem; border: 2px solid #e0e0e0; border-radius: 8px; }
        .submit-row button { padding: 0.5rem 1.5rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .empty { text-align: center; padding: 2rem; color: #666; }
        .app-filter { display: flex; gap: 0.5rem; flex-wrap: wrap; padding: 0.75rem 0 0.25rem; }
        .filter-chip { padding: 0.35rem 0.9rem; border: 2px solid #e0e0e0; background: white; border-radius: 20px; cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: all 0.15s; }
        .filter-chip.active { background: var(--primary); color: white; border-color: var(--primary); }
        .filter-chip:hover:not(.active) { border-color: var(--primary); color: var(--primary); }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 ${event.name}</h1>
        <div class="welcome">Welcome, <strong>${attendee.name}</strong> from <strong>${attendee.org}</strong></div>
    </div>
    
    <div class="tabs">
        <div class="tab active" onclick="switchTab('org')">⭐ For ${attendee.org}<span class="tab-count">${orgPrompts.length}</span></div>
        <div class="tab" onclick="switchTab('all')">📋 All Prompts<span class="tab-count">${allPrompts.length}</span></div>
    </div>

    <div class="container">
        <!-- App filter chips -->
        <div class="app-filter">
            <button class="filter-chip active" onclick="filterApp('all', this)">All</button>
            <button class="filter-chip" onclick="filterApp('Word', this)">📝 Word</button>
            <button class="filter-chip" onclick="filterApp('Excel', this)">📊 Excel</button>
            <button class="filter-chip" onclick="filterApp('PowerPoint', this)">📑 PowerPoint</button>
            <button class="filter-chip" onclick="filterApp('Outlook', this)">📧 Outlook</button>
            <button class="filter-chip" onclick="filterApp('Teams', this)">💬 Teams</button>
            <button class="filter-chip" onclick="filterApp('General', this)">✨ General</button>
        </div>
        <!-- Submit new prompt -->
        <div class="submit-card">
            <h3>💡 Share Your Prompt</h3>
            <textarea id="promptText" placeholder="Type a Copilot prompt that helps you or your colleagues..."></textarea>
            <div class="submit-row">
                <select id="promptApp">
                    ${apps.map(a => `<option value="${a}">${a}</option>`).join('')}
                </select>
                <button onclick="submitPrompt()">Submit</button>
            </div>
        </div>
        
        <!-- Org prompts -->
        <div class="tab-panel active" id="panel-org">
            ${orgPrompts.length ? orgPrompts.map(p => renderPrompt(p, true)).join('') : '<div class="empty">No prompts for your organization yet.<br>Check back soon!</div>'}
        </div>
        
        <!-- All prompts -->
        <div class="tab-panel" id="panel-all">
            ${allPrompts.length ? allPrompts.map(p => renderPrompt(p)).join('') : '<div class="empty">No prompts yet. Be the first!</div>'}
        </div>
    </div>
    
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});
        
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            document.querySelector(\`.tab[onclick="switchTab('\${tab}')"]\`).classList.add('active');
            document.getElementById('panel-' + tab).classList.add('active');
        }

        function filterApp(app, chip) {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            document.querySelectorAll('.prompt-card').forEach(card => {
                const badge = card.querySelector('.app-badge');
                card.style.display = (app === 'all' || (badge && badge.textContent.trim() === app)) ? '' : 'none';
            });
        }
        
        async function toggleVote(promptId, btn) {
            const isVoted = btn.classList.contains('voted');
            const method = isVoted ? 'DELETE' : 'POST';
            
            try {
                const res = await fetch('/api/vote/' + promptId, { method, credentials: 'include' });
                if (res.ok) {
                    btn.classList.toggle('voted');
                    const countEl = btn.querySelector('.vote-count');
                    countEl.textContent = parseInt(countEl.textContent) + (isVoted ? -1 : 1);
                    btn.querySelector(':first-child').textContent = isVoted ? '🤍' : '❤️';
                }
            } catch (e) {
                console.error(e);
            }
        }
        
        function copyPrompt(btn, text) {
            navigator.clipboard.writeText(text);
            btn.classList.add('copied');
            btn.textContent = '✓ Copied';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '📋 Copy';
            }, 2000);
        }
        
        async function submitPrompt() {
            const text = document.getElementById('promptText').value.trim();
            const app = document.getElementById('promptApp').value;
            
            if (text.length < 10) {
                alert('Please enter a longer prompt (at least 10 characters)');
                return;
            }
            
            try {
                const res = await fetch('/api/prompts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ text, app, eventId: ${event.id} })
                });
                
                if (res.ok) {
                    document.getElementById('promptText').value = '';
                    alert('Prompt submitted! 🎉');
                    location.reload();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to submit');
                }
            } catch (e) {
                alert('Network error');
            }
        }
        
        // Real-time updates
        socket.on('new-prompt', (prompt) => {
            console.log('New prompt:', prompt);
            // Could add dynamic UI update here
        });
        
        socket.on('vote-update', ({ promptId, votes }) => {
            document.querySelectorAll(\`.vote-btn\`).forEach(btn => {
                if (btn.onclick.toString().includes(promptId)) {
                    btn.querySelector('.vote-count').textContent = votes;
                }
            });
        });
    </script>    ${footer()}
</body>
</html>`;
}

module.exports = getParticipatePage;
