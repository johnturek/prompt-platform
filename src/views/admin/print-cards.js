function getPrintCardsPage(event, cards) {
    const cardHtml = cards.map(a => `
        <div class="card">
            <div class="event-name">${event.name}</div>
            <div class="attendee-name">${a.name}</div>
            <div class="attendee-org">${a.org}${a.role ? ' · ' + a.role : ''}</div>
            <img src="${a.qr}" alt="QR code" class="qr">
            <div class="join-code">${a.join_code}</div>
            <div class="instructions">Scan QR or go to prompt.turek.in and enter your code</div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Attendee Cards — ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: #f5f5f5; padding: 1rem; }
        .controls { text-align: center; padding: 1rem; margin-bottom: 1rem; }
        .controls button { padding: 0.75rem 2rem; background: #0078d4; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-right: 0.5rem; }
        .controls button.secondary { background: #6b7280; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; max-width: 1100px; margin: 0 auto; }
        .card { background: white; border-radius: 12px; padding: 1.25rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 2px solid #e0e0e0; page-break-inside: avoid; }
        .event-name { font-size: 0.7rem; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; }
        .attendee-name { font-size: 1.2rem; font-weight: 700; color: #1e293b; margin-bottom: 0.25rem; }
        .attendee-org { font-size: 0.85rem; color: #7c3aed; font-weight: 600; margin-bottom: 0.75rem; }
        .qr { width: 150px; height: 150px; border-radius: 8px; margin-bottom: 0.75rem; }
        .join-code { font-size: 1.5rem; font-weight: 900; letter-spacing: 0.2em; color: #0078d4; margin-bottom: 0.4rem; font-family: monospace; }
        .instructions { font-size: 0.7rem; color: #94a3b8; line-height: 1.4; }
        @media print {
            body { background: white; padding: 0; }
            .controls { display: none; }
            .grid { gap: 0.5rem; }
            .card { box-shadow: none; border: 1px solid #ccc; }
        }
    </style>
</head>
<body>
    <div class="controls">
        <button onclick="window.print()">🖨️ Print Cards</button>
        <button class="secondary" onclick="window.close()">✕ Close</button>
        <span style="margin-left:1rem;color:#666;font-size:0.9rem">${cards.length} cards · ${event.name}</span>
    </div>
    <div class="grid">
        ${cardHtml || '<p style="text-align:center;color:#666;padding:3rem">No attendees added yet.</p>'}
    </div>
</body>
</html>`;
}

module.exports = getPrintCardsPage;
