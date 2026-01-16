# Glugg

Glugg is a search UI that queries multiple Emby servers and shows where a title is available.
The Node server proxies Emby servers stored in SQLite (with `.env` as a fallback).

## Quick start

1. Copy `.env.example` to `.env`.
2. Run the server:

```sh
npm run dev
```

3. Open `http://localhost:8787`, complete setup, and log in.

## Docker

Build and run with Docker:

```sh
docker build -t glugg .
docker run --rm -p 8787:8787 \
  -e SERVER_PORT=8787 \
  -e GLUGG_DB=/app/data/glugg.db \
  -v glugg-data:/app/data \
  glugg
```

Or use docker compose:

```sh
docker compose up --build
```

To seed servers on first run, pass `EMBY_SERVERS` as JSON in the environment (see `.env` format).

## Configuration

### SQLite (preferred)

Servers are stored in `data/glugg.db` by default. Admins can manage servers from the Settings tab.
The config API is still available:

```sh
curl -X POST http://localhost:8787/api/servers \
  -H "Content-Type: application/json" \
  -d '{"name":"Living Room","url":"http://emby.local:8096","apiKey":"REPLACE_ME","enabled":true}'
```

Once a server is saved, it appears in the in-app Servers panel for editing.

### .env fallback

`.env` expects:

```
SERVER_PORT=8787
GLUGG_DB=./data/glugg.db
EMBY_SERVERS=[{"name":"Living Room","url":"http://emby.local:8096","apiKey":"REPLACE_ME"}]
```

## Authentication

- On first launch, create the initial admin user in the in-app setup flow.
- Admins can access the Settings tab and manage servers and users.
- Standard users can search but cannot access Settings.

### User management

- Admins can create, edit, and delete users in Settings.
- Password updates are optional when editing users.

## Onboarding

1. Start the app and open the UI.
2. Create the first admin account when prompted.
3. Log in, add servers in Settings, and optionally create standard users.

## API Endpoints

Auth:
- `GET /api/me`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/setup/status`
- `POST /api/setup`

Search:
- `GET /api/search?q=...&type=all|movie|series`

Servers (admin):
- `GET /api/servers`
- `POST /api/servers`
- `PUT /api/servers/:id`
- `DELETE /api/servers/:id`
- `POST /api/servers/:id/test`
- `GET /api/servers/:id/debug?q=...&type=all|movie|series`

Users (admin):
- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`
- `DELETE /api/users/:id`

## Deployment Notes

- Run behind a reverse proxy (nginx, Caddy) for HTTPS.
- Set a fixed `SERVER_PORT` and forward to it.
- Sessions are in-memory; restart invalidates logins.
- Store `data/glugg.db` on persistent storage.

## Versioning

This project uses Semantic Versioning (SemVer). Pre-release builds follow `X.Y.Z-alpha.N`.

## Notes

- Requires Node 20+ for `--env-file`.
- Uses `node:sqlite` (currently experimental in Node 23), so you may see a startup warning.
