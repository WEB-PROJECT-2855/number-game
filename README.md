# 🎮 DIGIT DUEL — Online 2-Player Number Guessing Game

> **Note:** "DIGIT DUEL" is a placeholder name. You can set the permanent game name at any time via the Admin panel (see below).

---

## 📐 Project Architecture

```
numgame/
├── server/
│   ├── index.js          ← Express + Socket.IO server (all backend logic)
│   ├── package.json
│   └── .env              ← Environment variables
└── client/
    └── public/
        └── index.html    ← Complete SPA frontend (all screens)
```

### Architecture Overview

```
[Player Device A]           [Player Device B]
      │                           │
      ▼                           ▼
  Browser (SPA)            Browser (SPA)
      │                           │
      │    WebSocket (Socket.IO)  │
      └──────────┬────────────────┘
                 ▼
         Node.js / Express
                 │
         ┌───────┴───────┐
         │               │
     Socket.IO        REST API
    (real-time)    (auth, friends)
         │               │
         └───────┬───────┘
                 ▼
             MongoDB
         (users, settings)
```

---

## 🗄️ Database Schema

### User
```js
{
  uid: String (UUID, unique),
  username: String (unique),
  passwordHash: String,
  friends: [uid],
  friendRequests: [uid],    // incoming pending
  socketId: String,
  online: Boolean,
  createdAt: Date
}
```

### GameSettings
```js
{
  key: "global",
  gameName: String,   // the permanent game name
  nameSet: Boolean    // true once admin has set it
}
```

### Rooms (in-memory, not persisted)
```js
{
  id, password,
  hostUid, hostUsername, hostSocketId,
  opponentUid, opponentUsername, opponentSocketId,
  digits (2-6), allowRepeat (bool, 6-digit only),
  hostSecret, opponentSecret,
  state: 'waiting' | 'secret' | 'playing' | 'ended',
  currentTurn: 'host' | 'opponent',
  hostGuesses: [{guess, correctDigits, correctPositions}],
  opponentGuesses: [...],
  totalRemaining (seconds), turnRemaining (seconds),
  winner, winReason
}
```

---

## 🔌 REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | Register new user |
| POST | `/api/login` | Login, get JWT |
| GET | `/api/game-name` | Get current game name |
| POST | `/api/game-name` | **Admin:** Set permanent game name |
| GET | `/api/friends/:uid` | Get friends + pending requests |
| GET | `/api/search/:username` | Search users by username |

---

## 🔌 Socket.IO Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `room:create` | `{roomId, password, digits, allowRepeat}` | Host creates room |
| `room:join` | `{roomId, password}` | Opponent joins room |
| `room:invite` | `{toUid, roomId}` | Host invites friend |
| `room:inviteAccept` | `{roomId}` | Friend accepts invite |
| `room:inviteDecline` | `{roomId, fromUid}` | Friend declines invite |
| `room:leave` | — | Leave/disconnect from room |
| `game:setSecret` | `{secret}` | Submit secret number |
| `game:guess` | `{guess}` | Submit a guess |
| `friend:request` | `{toUid}` | Send friend request |
| `friend:accept` | `{fromUid}` | Accept friend request |
| `friend:reject` | `{fromUid}` | Reject friend request |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `room:created` | `{roomId, digits, allowRepeat}` | Room created successfully |
| `room:joined` | `{roomId, digits, ...}` | Both players in room |
| `room:update` | Full room object | Any state change |
| `room:tick` | `{totalRemaining, turnRemaining}` | Timer tick |
| `room:turnSkipped` | `{skipped}` | Turn timed out, skipped |
| `room:error` | `{msg}` | Error message |
| `room:inviteReceived` | `{fromUid, fromUsername, roomId}` | Invitation received |
| `room:inviteDeclined` | `{byUsername}` | Invitation declined |
| `room:proceedToJoin` | `{roomId}` | After accepting invite, go enter password |
| `game:secretAccepted` | — | Secret number validated and stored |
| `game:secretError` | `{msg}` | Secret number validation failed |
| `game:guessError` | `{msg}` | Guess validation failed |
| `friend:online/offline` | `{uid, username}` | Friend status change |
| `friend:requestReceived` | `{uid, username}` | Friend request arrived |
| `friend:requestSent` | `{toUid, toUsername}` | Request sent confirmed |
| `friend:accepted` | `{uid, username, online}` | Friend request accepted |
| `gameName:updated` | `{gameName}` | Admin changed game name |

---

## 🎮 Game Flow

```
1. Register / Login (JWT auth)
2. Connect Socket.IO
3. Host: Create Room (set ID, password, digits, repeat option)
4. Opponent: Join Room (enter ID + password)
   OR: Host invites via Friends → Opponent accepts → must still enter password
5. Both in lobby → state changes to 'secret'
6. Both enter their secret numbers privately (validated)
7. Both secrets submitted → game starts
8. Timer begins (based on digit count)
9. Turn-based guessing (15s per turn)
   - System auto-compares guess vs opponent's secret
   - Shows: correct digits count + correct positions count
   - Turn passes automatically on timeout
10. First player to guess exact secret wins
    OR game ends on time → draw
```

---

## ✅ Validation Rules

### Secret Numbers
- Digits only, no leading zero
- Must match selected digit length exactly
- **Default (all modes):** No repeated digits
- **6-digit + "Allow repeat" ON:**
  - Exactly one digit may repeat (appear twice)
  - No digit may appear 3+ times
  - Not more than one distinct repeated digit

### Guesses
- Same rules as secret number validation
- Must match room's selected digit length

### Feedback Algorithm
```
correctDigits   = count of guess digits that appear anywhere in secret
correctPositions = count of guess digits in exact correct position
```

---

## ⏱️ Timer System

| Digits | Total Game Time | Per-Turn Time |
|--------|----------------|---------------|
| 2 | 3 minutes | 15 seconds |
| 3 | 5 minutes | 15 seconds |
| 4 | 7 minutes | 15 seconds |
| 5 | 9 minutes | 15 seconds |
| 6 | 11 minutes | 15 seconds |

- If turn timer expires → turn automatically skips to opponent
- If total timer expires → game ends as draw

---

## 🔐 Security

- Passwords hashed with bcrypt (10 rounds)
- JWT authentication for REST + Socket.IO
- Room password required even for invited friends
- Each player has unique UUID (different even in same room)
- Secret numbers never sent to opponent's client

---

## 🏷️ Setting the Permanent Game Name

The game ships with the placeholder name **"DIGIT DUEL"**.

To set your permanent game name:

### Via the Admin Panel (UI)
1. Go to the login screen
2. Click **"⚙ Admin: Set Game Name"** at the bottom
3. Enter your chosen game name
4. Enter the admin key (default: `admin2024`, change in `.env`)
5. Click **Update Name**

The name is immediately saved to MongoDB and broadcast to all connected clients. Once set, it persists permanently unless you change it again via the admin panel.

### Via API (curl)
```bash
curl -X POST http://localhost:3000/api/game-name \
  -H "Content-Type: application/json" \
  -d '{"name":"YOUR GAME NAME","adminKey":"admin2024"}'
```

---

## 🚀 Setup & Running

### Prerequisites
- Node.js v18+
- MongoDB running locally (or MongoDB Atlas URI)

### Install & Start
```bash
cd server
npm install
npm start        # production
npm run dev      # development with nodemon
```

Open `http://localhost:3000` in two different browsers/devices.

### Deploy to Production
For internet play from different phones:
1. Deploy to a VPS (DigitalOcean, Linode) or Heroku/Railway
2. Set `MONGO_URI` to your MongoDB Atlas connection string
3. Set a strong `JWT_SECRET` and `ADMIN_KEY`
4. Use HTTPS (required for secure websockets in production)

### Environment Variables (.env)
```
PORT=3000
MONGO_URI=mongodb://localhost:27017/numgame
JWT_SECRET=your_long_random_secret_here
ADMIN_KEY=your_admin_password_here
```

---

## 📱 Screens

1. **Login / Register** — JWT auth, admin game name setter
2. **Home** — Menu: Create Room, Join Room, Friends, Logout
3. **Create Room** — Set room ID, password, digit count, repeat option
4. **Join Room** — Enter room ID and password
5. **Friends** — Search users, send/accept requests, see online status
6. **Lobby** — Wait for opponent, invite friends, see room settings
7. **Secret Entry** — Privately set your secret number
8. **Game Screen** — Turn indicator, timers, guess input, guess history
9. **Result Screen** — Winner, reason, secret number reveal

---

## 🎨 Design

- **Theme:** Dark cyberpunk / military tactical
- **Fonts:** Orbitron (display), Rajdhani (body), Share Tech Mono (numbers)
- **Color palette:** Deep navy background, cyan accent, gold highlights
- **Fully mobile-responsive**
- **Animated:** Grid background, pulse effects, turn indicator glow

---

## 📋 All Requirements Checklist

- [x] Exactly 2 players per room
- [x] Host creates room, Opponent joins
- [x] Room ID + password system
- [x] Digit selection: 2, 3, 4, 5, 6
- [x] 6-digit optional "allow one repeat" mode
- [x] Secret number validation (all rules)
- [x] Turn-based gameplay
- [x] Automatic feedback (correct digits + positions)
- [x] 15-second per-turn timer with auto-skip
- [x] Total game timer (scales with digit count)
- [x] Win condition: exact guess
- [x] Friends system (add, accept, online/offline)
- [x] Friend invitation to room (still requires password)
- [x] Unique UID per player
- [x] Game name placeholder → permanent name setting
- [x] Real-time via Socket.IO
- [x] Mobile-friendly UI
- [x] Gaming aesthetic
- [x] All 10 screens implemented
