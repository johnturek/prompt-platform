# Prompt-a-thon Platform

An event management platform for running Microsoft Copilot prompt workshops. Attendees join events, submit prompts, vote on favorites, and see results on a live wall.

## Features

- **Event Management** — Create events with unique codes and QR codes for easy joining
- **Organization-based Groups** — Attendees grouped by org with tailored AI-generated prompts
- **Real-time Updates** — Socket.io powered live wall and voting
- **AI Prompt Generation** — Azure OpenAI integration to research orgs and generate relevant prompts
- **Export** — Download all prompts as JSON

## URLs

- **Production:** https://prompt.turek.in
- **Join Event:** `/join/:eventCode` (QR code destination)
- **Participate:** `/participate/:code`
- **Live Wall:** `/wall/:code` (for projecting at events)
- **Admin:** `/admin`

## Stack

- Node.js + Express
- Socket.io (real-time)
- SQLite (better-sqlite3)
- Azure OpenAI (prompt generation)
- QRCode generation

## Environment Variables

```env
PORT=3000
SESSION_SECRET=your-session-secret
AZURE_OPENAI_ENDPOINT=https://your-endpoint.openai.azure.com
AZURE_OPENAI_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

## Development

```bash
npm install
npm start
```

## Deployment

This repo uses GitHub Actions to deploy to Dokploy on push to `main`.

### Required GitHub Secrets

- `DOKPLOY_HOST` — SSH host (my.turek.in)
- `DOKPLOY_SSH_KEY` — SSH private key for deployment

## License

Private — JT Turek
