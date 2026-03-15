function getEventJoinPage(event, attendees) {
    const attendeesByOrg = {};
    attendees.forEach(a => {
        if (!attendeesByOrg[a.org]) attendeesByOrg[a.org] = [];
        attendeesByOrg[a.org].push(a);
    });
    
    const orgSections = Object.entries(attendeesByOrg).map(([org, members]) => `
        <div class="org-section">
            <h3>🏢 ${org}</h3>
            <div class="attendee-list">
                ${members.map(m => `
                    <button type="submit" name="attendeeId" value="${m.id}" class="attendee-btn">
                        👤 ${m.name}
                    </button>
                `).join('')}
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Join ${event.name}</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 1rem; }
        .container { max-width: 500px; margin: 0 auto; }
        .header { text-align: center; color: white; padding: 2rem 0; }
        .header h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
        .header p { opacity: 0.9; }
        .card { background: var(--card); border-radius: 16px; padding: 1.5rem; margin-bottom: 1rem; }
        .card h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #333; }
        .org-section { margin-bottom: 1.5rem; }
        .org-section h3 { font-size: 0.9rem; color: #666; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e0e0e0; }
        .attendee-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .attendee-btn { width: 100%; padding: 1rem; background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-size: 1rem; text-align: left; transition: all 0.2s; }
        .attendee-btn:hover { border-color: var(--primary); background: #eff6ff; }
        .empty { text-align: center; padding: 2rem; color: #666; }
        .alt-join { text-align: center; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e0e0e0; }
        .alt-join a { color: var(--primary); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 ${event.name}</h1>
            <p>Select your name to join</p>
        </div>
        
        <form method="POST" class="card">
            <h2>👋 Who are you?</h2>
            ${attendees.length ? orgSections : '<div class="empty">No attendees registered yet.<br>Contact the event organizer.</div>'}
        </form>
        
        <div class="card">
            <div class="alt-join">
                Have a personal join code? <a href="/">Enter it here</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

module.exports = getEventJoinPage;
