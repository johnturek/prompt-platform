function getEventDetailPage(event, attendees, orgs, prompts, qrDataUrl) {
    const orgList = [...new Set(attendees.map(a => a.org))];
    
    const attendeeRows = attendees.map(a => `
        <tr>
            <td>${a.name}</td>
            <td>${a.org}</td>
            <td>${a.role || '-'}</td>
            <td><code>${a.join_code}</code></td>
            <td>${a.joined_at ? '✅' : '⏳'}</td>
        </tr>
    `).join('');
    
    const orgCards = orgList.map(orgName => {
        const org = orgs.find(o => o.name === orgName);
        const promptCount = prompts.filter(p => p.org_name === orgName).length;
        const isResearched = org?.researched_at;
        
        return `
            <div class="org-card">
                <div class="org-name">${orgName}</div>
                <div class="org-stats">${promptCount} prompts</div>
                ${isResearched 
                    ? '<span class="researched">✅ Researched</span>' 
                    : `<button class="research-btn" onclick="researchOrg('${encodeURIComponent(orgName)}')">🔬 Research & Generate</button>`
                }
            </div>
        `;
    }).join('');

    const statusColors = { draft: '#fef3c7|#92400e', active: '#d1fae5|#065f46', closed: '#fee2e2|#991b1b' };
    const [statusBg, statusFg] = (statusColors[event.status] || statusColors.draft).split('|');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${event.name} - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }
        .qr-section { text-align: center; }
        .qr-section img { max-width: 200px; border: 4px solid #f0f0f0; border-radius: 12px; }
        .qr-section .code { font-size: 2rem; font-weight: bold; letter-spacing: 0.2em; color: var(--primary); margin: 1rem 0; }
        .qr-section .url { color: #666; font-size: 0.9rem; word-break: break-all; }
        .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
        .actions a, .actions button { padding: 0.5rem 1rem; background: var(--primary); color: white; text-decoration: none; border-radius: 6px; border: none; cursor: pointer; font-size: 0.9rem; }
        .actions a.secondary, .actions button.secondary { background: #6b7280; }
        .actions a.purple, .actions button.purple { background: #7c3aed; }
        .actions a.green, .actions button.green { background: #059669; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #e0e0e0; font-size: 0.9rem; }
        th { font-weight: 600; color: #666; }
        code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }
        .form-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .form-row input { flex: 1; min-width: 120px; padding: 0.5rem; border: 2px solid #e0e0e0; border-radius: 6px; }
        .form-row button { padding: 0.5rem 1rem; background: var(--primary); color: white; border: none; border-radius: 6px; cursor: pointer; }
        .org-card { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; background: #f9fafb; border-radius: 8px; margin-bottom: 0.5rem; }
        .org-name { font-weight: 600; }
        .org-stats { color: #666; font-size: 0.85rem; }
        .research-btn { padding: 0.4rem 0.8rem; background: #7c3aed; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
        .research-btn:disabled { background: #9ca3af; cursor: wait; }
        .researched { color: #059669; font-size: 0.85rem; }
        .full-width { grid-column: 1 / -1; }
        .del-btn { background: none; border: none; cursor: pointer; font-size: 1rem; opacity: 0.5; }
        .del-btn:hover { opacity: 1; }
        .status-badge { display: inline-block; padding: 0.3rem 0.8rem; border-radius: 12px; font-size: 0.85rem; font-weight: 700; }
        .controls-row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.75rem; }
        .stat-pill { background: #f0f4ff; border-radius: 8px; padding: 0.4rem 0.9rem; font-size: 0.9rem; font-weight: 600; color: #1e40af; }
        @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 ${event.name}</h1>
        <a href="/admin">← Back to Events</a>
    </div>
    <div class="container">
        <div class="grid">

            <!-- Event Controls (full width) -->
            <div class="card full-width">
                <h2>⚙️ Event Controls</h2>
                <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
                    <span class="status-badge" style="background:${statusBg};color:${statusFg}">
                        ${event.status === 'active' ? '🟢' : event.status === 'closed' ? '🔴' : '🟡'} ${event.status.toUpperCase()}
                    </span>
                    <span class="stat-pill" id="statJoined">👥 -- / ${attendees.length} joined</span>
                    <span class="stat-pill" id="statPrompts">💬 ${prompts.length} prompts</span>
                    <span class="stat-pill" id="statVotes">❤️ -- votes</span>
                </div>
                <div class="controls-row" style="margin-top:1rem">
                    ${event.status !== 'active'  ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="active"><button class="actions green" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer">🟢 Open Event</button></form>` : ''}
                    ${event.status !== 'closed'  ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="closed"><button class="actions secondary" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer">🔴 Close Event</button></form>` : ''}
                    ${event.status !== 'draft'   ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="draft"><button class="actions secondary" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer;background:#d97706">🟡 Back to Draft</button></form>` : ''}
                </div>
                <div class="controls-row">
                    <strong style="font-size:0.85rem;color:#666">🖥️ Project:</strong>
                    <a href="/wall/${event.code}" target="_blank" class="actions" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📺 Live Wall</a>
                    <a href="/wall/${event.code}?mode=leaderboard" target="_blank" class="actions purple" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🏆 Leaderboard</a>
                    ${orgList.map(o => `<a href="/wall/${event.code}?org=${encodeURIComponent(o)}" target="_blank" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🏢 ${o}</a>`).join('')}
                </div>
                <div class="controls-row">
                    <strong style="font-size:0.85rem;color:#666">📤 Export:</strong>
                    <a href="/admin/events/${event.code}/export" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📥 JSON</a>
                    <a href="/admin/events/${event.code}/export?format=csv" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📊 CSV</a>
                    <button onclick="copyTopPrompts()" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem">📋 Copy Top Prompts</button>
                    <a href="/admin/events/${event.code}/print-cards" target="_blank" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🖨️ Print Cards</a>
                </div>
            </div>

            <div class="card qr-section">
                <h2>📱 Join QR Code</h2>
                <img src="${qrDataUrl}" alt="QR Code">
                <div class="code">${event.code}</div>
                <div class="url">prompt.turek.in/join/${event.code}</div>
            </div>
            
            <div class="card">
                <h2>🏢 Organizations (${orgList.length})</h2>
                ${orgCards || '<p style="color:#666">Add attendees to see organizations</p>'}
            </div>
            
            <div class="card full-width">
                <h2>👥 Attendees (${attendees.length})</h2>
                <form method="POST" action="/admin/events/${event.code}/attendees">
                    <div class="form-row">
                        <input type="text" name="name" placeholder="Name" required>
                        <input type="text" name="org" placeholder="Organization" required>
                        <input type="text" name="role" placeholder="Role">
                        <input type="email" name="email" placeholder="Email">
                        <button type="submit">Add</button>
                    </div>
                </form>
                <form id="importForm" enctype="multipart/form-data" style="margin-bottom:1rem">
                    <div class="form-row" style="align-items:center">
                        <label style="font-size:0.85rem;color:#666">Bulk import CSV (name,org,role,email):</label>
                        <input type="file" name="csvfile" accept=".csv" required style="flex:1;border:none;padding:0">
                        <button type="button" onclick="importCSV()">📥 Import</button>
                    </div>
                </form>
                ${attendees.length ? `
                    <table>
                        <thead><tr><th>Name</th><th>Organization</th><th>Role</th><th>Join Code</th><th>Joined</th></tr></thead>
                        <tbody>${attendeeRows}</tbody>
                    </table>
                ` : ''}
            </div>
            
            <div class="card full-width">
                <h2>💬 Prompts (${prompts.length})</h2>
                ${prompts.length ? `
                    <table>
                        <thead><tr><th>Prompt</th><th>Org</th><th>App</th><th>Source</th><th>Votes</th><th></th></tr></thead>
                        <tbody>
                            ${prompts.slice(0, 50).map(p => `
                                <tr>
                                    <td style="max-width:400px">${p.text.substring(0, 100)}${p.text.length > 100 ? '...' : ''}</td>
                                    <td>${p.org_name || '-'}</td>
                                    <td>${p.app || '-'}</td>
                                    <td>${p.source}</td>
                                    <td>${p.votes}</td>
                                    <td><button class="del-btn" onclick="deletePrompt(${p.id}, this)">🗑️</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : '<p style="color:#666">No prompts yet</p>'}
            </div>
        </div>
    </div>
    <script>
        // Live stats polling
        async function refreshStats() {
            try {
                const data = await fetch('/api/events/${event.code}/stats').then(r => r.json());
                document.getElementById('statJoined').textContent = '👥 ' + data.joined + ' / ' + data.total + ' joined';
                document.getElementById('statPrompts').textContent = '💬 ' + data.prompts + ' prompts';
                document.getElementById('statVotes').textContent = '❤️ ' + data.votes + ' votes';
            } catch(e) {}
        }
        refreshStats();
        setInterval(refreshStats, 10000);

        async function copyTopPrompts() {
            try {
                const data = await fetch('/admin/events/${event.code}/export').then(r => r.json());
                const top = data.slice(0, 10);
                const text = top.map((p, i) => \`\${i+1}. [\${p.app || 'General'}] \${p.text}\`).join('\\n\\n');
                await navigator.clipboard.writeText(text);
                alert('Top ' + top.length + ' prompts copied to clipboard!');
            } catch(e) { alert('Copy failed'); }
        }

        async function researchOrg(orgName) {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Researching...';
            try {
                const res = await fetch('/admin/events/${event.code}/research/' + orgName, { method: 'POST' });
                const data = await res.json();
                if (res.ok) { alert('Generated ' + data.promptCount + ' prompts!'); location.reload(); }
                else { alert('Error: ' + data.error); btn.disabled = false; btn.textContent = '🔬 Research & Generate'; }
            } catch (e) { alert('Network error'); btn.disabled = false; btn.textContent = '🔬 Research & Generate'; }
        }

        async function deletePrompt(id, btn) {
            if (!confirm('Delete this prompt? This cannot be undone.')) return;
            const res = await fetch('/admin/prompts/' + id, { method: 'DELETE' });
            if (res.ok) btn.closest('tr').remove();
            else alert('Failed to delete');
        }

        async function importCSV() {
            const form = document.getElementById('importForm');
            const fd = new FormData(form);
            const res = await fetch('/admin/events/${event.code}/import', { method: 'POST', body: fd });
            const data = await res.json();
            if (res.ok) { alert('Imported ' + data.added + ' attendees, skipped ' + data.skipped); location.reload(); }
            else alert('Import error: ' + data.error);
        }
    </script>
</body>
</html>`;
}

module.exports = getEventDetailPage;
