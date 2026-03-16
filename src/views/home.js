function getHomePage(error = null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; --text: #323130; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
        .container { background: var(--card); border-radius: 16px; padding: 3rem; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.25); }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { color: #666; margin-bottom: 2rem; }
        .join-form input { width: 100%; padding: 1rem; font-size: 1.5rem; text-align: center; border: 2px solid #e0e0e0; border-radius: 12px; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.3em; }
        .join-form input:focus { outline: none; border-color: var(--primary); }
        .join-form button { width: 100%; padding: 1rem; font-size: 1.1rem; background: var(--primary); color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; }
        .join-form button:hover { background: #106ebe; }
        .error { background: #fef2f2; color: #dc2626; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
        .admin-link { margin-top: 2rem; font-size: 0.85rem; }
        .admin-link a { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Prompt-a-thon</h1>
        <p>Enter your join code to participate</p>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form class="join-form" method="POST" action="/join">
            <input type="text" name="joinCode" placeholder="JOIN CODE" maxlength="8" required autofocus>
            <button type="submit">Join Event</button>
        </form>
        <div class="admin-link"><a href="/login">Admin Login</a></div>
    </div>
</body>
</html>`;
}

module.exports = getHomePage;
