# Watchd Backend

A production-ready REST + WebSocket backend for **Watchd** — a movie matching app where two users swipe on movies and get notified when they both like the same one.

## Tech Stack

- **Node.js + TypeScript** — type-safe server code
- **Express.js** — HTTP routing
- **MariaDB** via `mysql2` — relational data, raw SQL
- **Socket.io** — real-time match notifications
- **JWT** — stateless authentication
- **bcrypt** — secure password hashing
- **TMDB API** — movie data
- **JustWatch GraphQL API** — streaming availability (DE), with 1 h in-memory cache

---

## Setup

### 1. Prerequisites

- Node.js ≥ 20
- MariaDB ≥ 10.6
- A [TMDB API key](https://developer.themoviedb.org/docs/getting-started)

#### Auf macOS (Homebrew)

Falls du von Linux auf Mac wechselst oder neu einrichtest:

1. **Homebrew** (falls noch nicht installiert):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Node.js** (≥ 20):
   ```bash
   brew install node
   ```
   Optional: [nvm](https://github.com/nvm-sh/nvm) für mehrere Node-Versionen.

3. **MariaDB**:
   ```bash
   brew install mariadb
   brew services start mariadb
   ```
   Standardmäßig: Host `127.0.0.1`, Port `3306`, User `root`, Passwort oft leer. Nach der ersten Installation ggf. `mariadb-secure-installation` ausführen.

4. **Datenbank anlegen** (Schema einmal ausführen):
   ```bash
   mysql -u root < src/db/schema.sql
   ```
   Wenn ein Passwort gesetzt ist: `mysql -u root -p < src/db/schema.sql`

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

| Variable       | Description                          |
| -------------- | ------------------------------------ |
| `PORT`         | HTTP port (default `3000`)           |
| `DB_HOST`      | MariaDB host                         |
| `DB_PORT`      | MariaDB port (default `3306`)        |
| `DB_USER`      | Database user                        |
| `DB_PASSWORD`  | Database password                    |
| `DB_NAME`      | Database name                        |
| `JWT_SECRET`   | Long random string for JWT signing   |
| `TMDB_API_KEY` | Your TMDB v3 API key                 |

### 4. Create the database schema

```bash
mysql -u root -p < src/db/schema.sql
```

### 5. Run in development

```bash
npm run dev
```

### 6. Build for production

```bash
npm run build
node dist/index.js
```

---

## API Reference

All protected endpoints require the header:

```
Authorization: Bearer <token>
```

### Auth

#### `POST /api/auth/register`

Register a new user.

**Body**
```json
{ "name": "Alice", "email": "alice@example.com", "password": "secret123" }
```

**Response `201`**
```json
{ "token": "<jwt>", "user": { "id": 1, "name": "Alice", "email": "alice@example.com" } }
```

---

#### `POST /api/auth/login`

**Body**
```json
{ "email": "alice@example.com", "password": "secret123" }
```

**Response `200`**
```json
{ "token": "<jwt>", "user": { "id": 1, "name": "Alice", "email": "alice@example.com" } }
```

---

### Rooms

#### `POST /api/rooms` _(auth)_

Create a new room. The creator is automatically added as the first member.

**Response `201`**
```json
{ "room": { "id": 1, "code": "AB3X7Q", "created_by": 1, "created_at": "..." } }
```

---

#### `POST /api/rooms/join` _(auth)_

Join an existing room (max 2 members).

**Body**
```json
{ "code": "AB3X7Q" }
```

**Response `200`**
```json
{ "room": { "id": 1, "code": "AB3X7Q", "created_by": 1, "created_at": "..." } }
```

---

#### `GET /api/rooms/:id` _(auth)_

Get room details and member list. Requester must be a room member.

**Response `200`**
```json
{
  "room": { "id": 1, "code": "AB3X7Q", "created_by": 1, "created_at": "..." },
  "members": [
    { "user_id": 1, "name": "Alice", "email": "alice@example.com", "joined_at": "..." },
    { "user_id": 2, "name": "Bob",   "email": "bob@example.com",   "joined_at": "..." }
  ]
}
```

---

### Movies

#### `GET /api/movies/feed?roomId=&page=` _(auth)_

Returns up to 20 unswiped TMDB movies for the authenticated user in the given room, enriched with JustWatch streaming availability (DE).

**Query params**
| Param    | Required | Description              |
| -------- | -------- | ------------------------ |
| `roomId` | yes      | Room the user belongs to |
| `page`   | no       | TMDB page offset (≥ 1)   |

**Response `200`**
```json
{
  "page": 1,
  "movies": [
    {
      "id": 550,
      "title": "Fight Club",
      "overview": "...",
      "poster_path": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
      "release_date": "1999-10-15",
      "vote_average": 8.4,
      "streamingOptions": [
        {
          "monetizationType": "FLATRATE",
          "presentationType": "HD",
          "package": { "clearName": "Netflix", "icon": "..." }
        }
      ]
    }
  ]
}
```

---

### Swipes

#### `POST /api/swipes` _(auth)_

Record a swipe. If both users in the room swiped right on the same movie a match is created and a Socket.io `match` event is emitted.

**Body**
```json
{ "movieId": 550, "roomId": 1, "direction": "right" }
```

**Response `201`**
```json
{
  "swipe": { "userId": 1, "movieId": 550, "roomId": 1, "direction": "right" },
  "match": null
}
```

When a match occurs, `match` contains:
```json
{
  "isMatch": true,
  "matchId": 7,
  "movieId": 550,
  "movieTitle": "Fight Club",
  "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
  "streamingOptions": [...]
}
```

---

### Matches

#### `GET /api/matches/:roomId` _(auth)_

List all matched movies for a room, with TMDB details and streaming info.

**Response `200`**
```json
{
  "matches": [
    {
      "id": 7,
      "roomId": 1,
      "matchedAt": "2024-06-01T20:00:00.000Z",
      "movie": {
        "id": 550,
        "title": "Fight Club",
        "overview": "...",
        "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
        "backdropPath": "...",
        "releaseDate": "1999-10-15",
        "voteAverage": 8.4
      },
      "streamingOptions": [...]
    }
  ]
}
```

---

## WebSocket (Socket.io)

Connect to the server and emit a `join` event to authenticate and subscribe to a room's match notifications.

```js
const socket = io('http://localhost:3000');

socket.emit('join', { token: '<jwt>', roomId: 1 });

socket.on('joined', ({ roomId }) => console.log('Subscribed to room', roomId));

socket.on('match', ({ movieId, movieTitle, posterPath, streamingOptions }) => {
  console.log('Match!', movieTitle);
});

socket.on('error', ({ message }) => console.error(message));
```

The server emits the `match` event to the `room:<roomId>` channel with:

```json
{
  "movieId": 550,
  "movieTitle": "Fight Club",
  "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
  "streamingOptions": [...]
}
```
