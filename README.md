# Watchd Backend

Node.js/Express + Socket.io Backend für Watchd — eine Tinder-style Movie-Matching-App, bei der zwei User in einem gemeinsamen "Room" auf Filme swipen und bei beidseitigem Like einen Match inkl. Streaming-Info bekommen.

> **Deep Dive**: Architektur, Routen, Services, Flows und Test-Setup stehen in [CLAUDE.md](./CLAUDE.md). Diese README deckt nur Installation und den typischen Dev-Workflow ab.

---

## Voraussetzungen

- **Node.js 22+** (`.nvmrc` ist auf `22` gepinnt; Projekt nutzt `@types/node: ^22`)
- **MySQL 8+** oder **MariaDB 10.5+** (utf8mb4_unicode_ci)
- **TMDB API Key** — v3 Key oder v4 Read Access Token ([themoviedb.org/settings/api](https://www.themoviedb.org/settings/api))

Optional für Push / Mail:

- **APNs .p8 Key** — aus Apple Developer Portal (nur wenn Push getestet wird)
- **SMTP-Zugang** — sonst werden Mails auf Console geloggt

---

## First-Time Setup

```bash
# 1. Dependencies
npm install

# 2. Env-Datei anlegen
cp .env.example .env
# → .env öffnen und zumindest JWT_SECRET, JWT_REFRESH_SECRET,
#   TMDB_API_KEY und DB_* Werte eintragen

# 3. Datenbank anlegen
mysql -u root -p <<'SQL'
CREATE DATABASE watchd CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'watchd'@'localhost' IDENTIFIED BY 'DEIN_PASSWORT';
GRANT ALL PRIVILEGES ON watchd.* TO 'watchd'@'localhost';
FLUSH PRIVILEGES;
SQL

# 4. Schema anwenden
mysql -u watchd -p watchd < src/db/schema.sql
# ALTERNATIV: WATCHD_APPLY_SCHEMA=1 in .env setzen → auto-apply beim Dev-Start
```

### Test-Datenbank (einmalig, für `npm test`)

```bash
sudo mariadb <<'SQL'
CREATE DATABASE IF NOT EXISTS watchd_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'dev_test'@'localhost' IDENTIFIED BY 'dev_test_pw';
GRANT ALL PRIVILEGES ON watchd_test.* TO 'dev_test'@'localhost';
FLUSH PRIVILEGES;
SQL
```

Die Test-DB wird bei jedem `npm test`-Lauf via `src/tests/global-setup.ts` komplett neu aufgesetzt (DROP + CREATE TABLE aller 9 Tabellen aus `schema.sql`).

---

## Dev-Workflow

```bash
npm run dev          # Hot-reload (ts-node-dev) auf Port 3000
npm run typecheck    # TypeScript prüfen (nach jeder Änderung!)
npm test             # Vitest gegen watchd_test-DB
npm run test:watch   # Watch-Mode
npm run build        # Compile → dist/
npm start            # Production-Build starten
```

**Nach Backend-Änderungen immer:** `npm run typecheck` + `npm test` (2× laufen lassen, Ergebnis muss identisch sein — Tests sind deterministisch konfiguriert, abweichende Pass-Counts sind ein Bug).

---

## Deployment (Railway)

- Produktiv-URL: `https://watchd.up.railway.app`
- Build-Command: `npm run build`
- Start-Command: `npm start`
- Kein Dockerfile — Railway nutzt Nixpacks-Autodetection

**Env-Vars auf Railway setzen** (alle Required-Werte aus `.env.example` + `APP_URL=https://watchd.up.railway.app`). APNs-Key base64-encoded ohne Zeilenumbrüche:

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n' | pbcopy
```

Anschließend in Railway → Variables → `APNS_PRIVATE_KEY` einfügen.

---

## Health Check

```bash
curl http://localhost:3000/health
# → {"status":"ok","db":"ok","tmdb":"ok","uptime":123.4}
```

Nützlich nach Deploys, um DB- und TMDB-Konnektivität zu prüfen.

---

## Weitere Docs

- [CLAUDE.md](./CLAUDE.md) — Architektur, Routen, Services, Test-Setup, Code-Standards, bekannte Fallen
- [docs/troubleshooting.md](./docs/troubleshooting.md) — Incident-Playbook für Laufzeitfehler und Runtime-Debugging
- [`.env.example`](./.env.example) — alle unterstützten Env-Vars mit Defaults und Kommentaren
- [`src/db/schema.sql`](./src/db/schema.sql) — komplettes DB-Schema (9 Tabellen)
