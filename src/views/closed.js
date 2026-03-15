function getEventClosedPage(event) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workshop Ended - ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: white; border-radius: 20px; padding: 3rem; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 30px 60px rgba(0,0,0,0.25); }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { font-size: 1.75rem; margin-bottom: 0.75rem; color: #1e293b; }
        p { color: #64748b; line-height: 1.6; margin-bottom: 1.5rem; }
        .event-name { font-weight: 700; color: #7c3aed; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🎉</div>
        <h1>Thanks for participating!</h1>
        <p>The <span class="event-name">${event.name}</span> workshop has ended. Your prompts and votes have been recorded.</p>
        <p style="font-size:0.9rem;color:#94a3b8">Ask your facilitator to share the results!</p>
    </div>
</body>
</html>`;
}

module.exports = getEventClosedPage;
