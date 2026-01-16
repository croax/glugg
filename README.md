# Glugg

Glugg is a tiny search UI that queries multiple Emby servers and shows where a title is available.
The Node server proxies Emby servers stored in SQLite (with `.env` as a fallback).

## Quick start

1. Copy `.env.example` to `.env` and add your Emby server list.
2. Run the server:

```sh
npm run dev
```

3. Open `http://localhost:8787`.

## Configuration

### SQLite (preferred)

Servers are stored in `data/glugg.db` by default. Use the config API:

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
- Admins can access the Settings tab and manage servers.
- Standard users can search but cannot access Settings.
 - Admins can manage users in the Settings tab.

## Onboarding

1. Start the app and open the UI.
2. Create the first admin account when prompted.
3. Log in and add servers in Settings.

## Notes

- Requires Node 20+ for `--env-file`.
- Uses `node:sqlite` (currently experimental in Node 23), so you may see a startup warning.
