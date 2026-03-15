function getLoginPage(error = null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; border-radius: 16px; padding: 2rem; max-width: 380px; width: 90%; }
        h1 { font-size: 1.5rem; margin-bottom: 1.5rem; text-align: center; }
        .error { background: #fef2f2; color: #dc2626; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
        input { width: 100%; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; margin-bottom: 1rem; font-size: 1rem; }
        button { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 Admin Login</h1>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="Username" required>
            <input type="password" name="password" placeholder="Password" required>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>`;
}

module.exports = getLoginPage;
