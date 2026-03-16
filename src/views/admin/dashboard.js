function getAdminPage(events, user) {
    const eventRows = events.map(e => `
        <tr>
            <td><a href="/admin/events/${e.code}">${e.name}</a></td>
            <td><code>${e.code}</code></td>
            <td>${e.date || '-'}</td>
            <td>${e.attendee_count}</td>
            <td>${e.prompt_count}</td>
            <td><span class="status status-${e.status}">${e.status}</span></td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .header h1 { font-size: 1.25rem; display: flex; align-items: center; gap: 0.5rem; }
        .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; }
        .form-row { display: flex; gap: 1rem; margin-bottom: 1rem; }
        .form-row input { flex: 1; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; }
        .form-row button { padding: 0.75rem 1.5rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
        th { font-weight: 600; color: #666; font-size: 0.85rem; text-transform: uppercase; }
        td a { color: var(--primary); text-decoration: none; font-weight: 600; }
        code { background: #f0f0f0; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.9rem; }
        .status { padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
        .status-draft { background: #fef3c7; color: #92400e; }
        .status-active { background: #d1fae5; color: #065f46; }
        .empty { text-align: center; padding: 3rem; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 Prompt-a-thon Admin</h1>
        <div>👤 ${user.username} | <a href="/admin/users">Users</a> | <a href="/logout">Logout</a></div>
    </div>
    <div class="container">
        <div class="card">
            <h2>➕ Create New Event</h2>
            <form method="POST" action="/admin/events">
                <div class="form-row">
                    <input type="text" name="name" placeholder="Event Name (e.g., DOJ Prompt-a-thon)" required>
                    <input type="date" name="date">
                    <button type="submit">Create Event</button>
                </div>
            </form>
        </div>
        
        <div class="card">
            <h2>📅 Events</h2>
            ${events.length ? `
                <table>
                    <thead>
                        <tr><th>Name</th><th>Code</th><th>Date</th><th>Attendees</th><th>Prompts</th><th>Status</th></tr>
                    </thead>
                    <tbody>${eventRows}</tbody>
                </table>
            ` : '<div class="empty">No events yet. Create one above!</div>'}
        </div>
    </div>
</body>
</html>`;
}

module.exports = getAdminPage;
