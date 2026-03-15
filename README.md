# Prompt-a-thon Platform

An event management platform for running Microsoft Copilot prompt workshops. Attendees join events, submit prompts, vote on favorites, and see results on a live wall.

## Features

- **Event Management** — Create events with unique codes and QR codes for easy joining
- **Organization-based Groups** — Attendees grouped by org with tailored AI-generated prompts
- **Real-time Updates** — Socket.io powered live wall and voting
- **AI Prompt Generation** — Azure OpenAI integration to research orgs and generate relevant prompts
- **Mock AI Mode** — Set `MOCK_AI=true` to run offline without Azure OpenAI
- **User Management** — Add/remove admin users, change passwords at `/admin/users`
- **Prompt Moderation** — Delete prompts from the admin event detail page
- **Bulk Import** — Upload a CSV (name,org,role,email) to add many attendees at once
- **Export** — Download all prompts as JSON or CSV
- **Security** — Helmet headers, rate limiting, brute-force protection, non-root Docker container
- **Structured Logging** — Winston (JSON in production, colourised in dev)

## URLs

| Route | Purpose |
|---|---|
| `/` | Attendee join page |
| `/join/:eventCode` | QR code destination |
| `/participate/:code` | Submit & vote on prompts |
| `/wall/:code` | Live projection wall |
| `/admin` | Admin dashboard |
| `/admin/users` | User management |
| `/health` | Container health check |

## Production: https://prompt.turek.in

## Stack

- Node.js 20 + Express
- Socket.io (real-time)
- SQLite (better-sqlite3)
- Azure OpenAI (prompt generation)
- Helmet + express-rate-limit (security)
- Winston (logging)

## Quick Start (local)

```bash
cp .env.example .env   # fill in your values
npm install
npm start
# → http://localhost:3000  (admin: admin / CSADemo2026!)
```

Dev mode (auto-restart on file change):
```bash
npm run dev
```

## Quick Start (Docker)

```bash
cp .env.example .env   # fill in your values
mkdir -p data
docker compose up --build
# → http://localhost:3000
```

Offline / mock AI:
```bash
MOCK_AI=true docker compose up
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_SECRET` | yes | `dev-secret-change-me` | Express session secret |
| `AZURE_OPENAI_ENDPOINT` | for AI | — | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_KEY` | for AI | — | Azure API key |
| `AZURE_OPENAI_DEPLOYMENT` | for AI | — | Deployment name (e.g. gpt-4o) |
| `AZURE_OPENAI_API_VERSION` | no | `2024-12-01-preview` | API version |
| `MOCK_AI` | no | `false` | Return sample prompts without calling Azure |
| `LOG_LEVEL` | no | `info` | Winston log level |
| `PORT` | no | `3000` | HTTP port |
| `NODE_ENV` | no | `development` | Set `production` in prod |

## CI/CD — GitHub Actions → Dokploy

On push to `main` the pipeline:
1. Runs `node --check server.js` (syntax check)
2. Builds and pushes the Docker image to **ghcr.io/jturek/prompt-platform:latest**
3. Triggers the Dokploy webhook at `https://deploy.turek.in/deploy/prompt-platform`

### Required GitHub Secrets

| Secret | Value |
|---|---|
| `WEBHOOK_SECRET` | HMAC secret shared with Dokploy webhook server |

The image is public on `ghcr.io` so Dokploy only needs to `docker pull` it.

## Bulk Attendee Import

Upload a CSV with the header row `name,org,role,email` from the event detail page → Attendees section → "📥 Import".

## License

Private — JT Turek

