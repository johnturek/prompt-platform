const footer = require('../_footer');

function getUsersPage(users, currentUser) {
    const userRows = users.map(u => `
        <tr>
            <td>${u.username}</td>
            <td><span class="status status-${u.role}">${u.role}</span></td>
            <td>${u.created_at}</td>
            <td>${u.id !== currentUser.id ? `<button onclick="deleteUser(${u.id}, this)">🗑️</button>` : '<span style="color:#999">you</span>'}</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Management - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; }
        .form-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
        .form-row input, .form-row select { flex: 1; min-width: 120px; padding: 0.6rem; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 0.95rem; }
        .form-row button { padding: 0.6rem 1.25rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
        th { font-weight: 600; color: #666; font-size: 0.85rem; }
        .status { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
        .status-admin { background: #dbeafe; color: #1e40af; }
        .status-viewer { background: #f3f4f6; color: #374151; }
        .alert { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.95rem; }
        .alert-error { background: #fef2f2; color: #dc2626; }
        .alert-success { background: #d1fae5; color: #065f46; }
        .back { font-size: 0.9rem; color: #666; text-decoration: none; }
    </style>
</head>
<body>
    <div class="header">
        <h1>👥 User Management</h1>
        <div><a href="/admin" class="back">← Back to Admin</a> | <a href="/logout">Logout</a></div>
    </div>
    <div class="container">
        ${new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('error') ? '' : ''}
        <div class="card">
            <h2>➕ Add Admin User</h2>
            <form method="POST" action="/admin/users">
                <div class="form-row">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password (min 8 chars)" required minlength="8">
                    <select name="role"><option value="admin">Admin</option><option value="viewer">Viewer</option></select>
                    <button type="submit">Add User</button>
                </div>
            </form>
        </div>

        <div class="card">
            <h2>🔑 Change Your Password</h2>
            <form method="POST" action="/admin/users/password">
                <div class="form-row">
                    <input type="password" name="current_password" placeholder="Current password" required>
                    <input type="password" name="new_password" placeholder="New password (min 8 chars)" required minlength="8">
                    <input type="password" name="confirm_password" placeholder="Confirm new password" required>
                    <button type="submit">Update</button>
                </div>
            </form>
        </div>

        <div class="card">
            <h2>👤 Users (${users.length})</h2>
            <table>
                <thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
                <tbody>${userRows}</tbody>
            </table>
        </div>
    </div>
    <script>
        // Show flash messages from query string
        const params = new URLSearchParams(location.search);
        if (params.get('error')) {
            const div = document.createElement('div');
            div.className = 'alert alert-error';
            div.textContent = decodeURIComponent(params.get('error'));
            document.querySelector('.container').prepend(div);
        }
        if (params.get('success')) {
            const div = document.createElement('div');
            div.className = 'alert alert-success';
            div.textContent = decodeURIComponent(params.get('success'));
            document.querySelector('.container').prepend(div);
        }
        async function deleteUser(id, btn) {
            if (!confirm('Delete this user?')) return;
            const res = await fetch('/admin/users/' + id, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) btn.closest('tr').remove();
            else alert(data.error);
        }
    </script>    ${footer()}
</body>
</html>`;
}

module.exports = getUsersPage;
