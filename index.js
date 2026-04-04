require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET || 'numgame_secret_2024';

// ─── Models ────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  uid: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  passwordHash: String,
  friends: [{ type: String }],
  friendRequests: [{ type: String }],
  socketId: String,
  online: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const gameSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },
  gameName: { type: String, default: 'DIGIT DUEL' },
  nameSet: { type: Boolean, default: false }
});
const GameSettings = mongoose.model('GameSettings', gameSettingsSchema);

// ─── In-Memory Room Store ──────────────────────────────────────────────────

const rooms = {};

// ─── Helper Functions ─────────────────────────────────────────────────────

function generateFeedback(secret, guess) {
  let correctDigits = 0;
  let correctPositions = 0;
  const secretArr = secret.split('');
  const guessArr = guess.split('');

  for (let i = 0; i < secretArr.length; i++) {
    if (guessArr[i] === secretArr[i]) correctPositions++;
    if (secretArr.includes(guessArr[i])) correctDigits++;
  }

  return { correctDigits, correctPositions };
}

function validateSecret(secret, digits, allowRepeat) {
  if (!/^\d+$/.test(secret)) {
    return { valid: false, msg: 'Secret number must contain digits only.' };
  }

  if (secret.length !== digits) {
    return { valid: false, msg: `Secret number must be exactly ${digits} digits.` };
  }

  if (secret[0] === '0') {
    return { valid: false, msg: 'Secret number must not start with 0.' };
  }

  const freq = {};
  for (const d of secret) freq[d] = (freq[d] || 0) + 1;
  const repeats = Object.values(freq).filter(v => v > 1);

  if (digits === 6 && allowRepeat) {
    if (repeats.length > 1) {
      return { valid: false, msg: 'Only one digit may repeat. Multiple repeated digits are not allowed.' };
    }
    if (repeats.some(v => v > 2)) {
      return { valid: false, msg: 'A digit may appear at most twice. Repeating more than twice is not allowed.' };
    }
  } else {
    if (repeats.length > 0) {
      return { valid: false, msg: 'Secret number must not contain repeated digits.' };
    }
  }

  return { valid: true };
}

function validateGuess(guess, digits, allowRepeat) {
  return validateSecret(guess, digits, allowRepeat);
}

function getTotalSeconds(digits) {
  const map = { 2: 180, 3: 300, 4: 420, 5: 540, 6: 660 };
  return map[digits] || 420;
}

function clearRoomTimers(room) {
  if (room.totalTimer) clearInterval(room.totalTimer);
  if (room.turnTimer) clearInterval(room.turnTimer);
  room.totalTimer = null;
  room.turnTimer = null;
}

function broadcastRoom(room) {
  const safeRoom = {
    id: room.id,
    digits: room.digits,
    allowRepeat: room.allowRepeat,
    state: room.state,
    currentTurn: room.currentTurn,
    hostUsername: room.hostUsername,
    opponentUsername: room.opponentUsername,
    hostUid: room.hostUid,
    opponentUid: room.opponentUid,
    hostGuesses: room.hostGuesses,
    opponentGuesses: room.opponentGuesses,
    totalRemaining: room.totalRemaining,
    turnRemaining: room.turnRemaining,
    winner: room.winner,
    winReason: room.winReason,
    hostReady: !!room.hostSecret,
    opponentReady: !!room.opponentSecret,
    hostReveal: room.hostReveal || null,
    opponentReveal: room.opponentReveal || null
  };

  io.to(room.id).emit('room:update', safeRoom);
}

function endGame(room, winner, winReason) {
  clearRoomTimers(room);
  room.state = 'ended';
  room.winner = winner;
  room.winReason = winReason;
  room.hostReveal = room.hostSecret || '???';
  room.opponentReveal = room.opponentSecret || '???';
  broadcastRoom(room);
}

function startTurnTimer(room) {
  if (room.turnTimer) clearInterval(room.turnTimer);

  room.turnRemaining = 25;
  broadcastRoom(room);

  room.turnTimer = setInterval(() => {
    room.turnRemaining--;

    if (room.turnRemaining <= 0) {
      clearInterval(room.turnTimer);
      room.turnTimer = null;

      const skippedRole = room.currentTurn;
      room.currentTurn = room.currentTurn === 'host' ? 'opponent' : 'host';

      io.to(room.id).emit('room:turnSkipped', { skipped: skippedRole });
      startTurnTimer(room);
    } else {
      io.to(room.id).emit('room:tick', {
        totalRemaining: room.totalRemaining,
        turnRemaining: room.turnRemaining
      });
    }
  }, 1000);
}

function startGameTimers(room) {
  room.totalRemaining = getTotalSeconds(room.digits);

  room.totalTimer = setInterval(() => {
    room.totalRemaining--;

    if (room.totalRemaining <= 0) {
      endGame(room, 'draw', 'Time ran out!');
    }
  }, 1000);

  startTurnTimer(room);
}

// ─── REST Routes ──────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: 'Username already taken.' });
    }

    const uid = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({ uid, username, passwordHash });
    await user.save();

    const token = jwt.sign({ uid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, uid, username });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { uid: user.uid, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, uid: user.uid, username: user.username });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/game-name', async (req, res) => {
  const settings = await GameSettings.findOne({ key: 'global' });
  res.json({
    gameName: settings ? settings.gameName : 'DIGIT DUEL',
    nameSet: settings ? settings.nameSet : false
  });
});

app.post('/api/game-name', async (req, res) => {
  const { name, adminKey } = req.body;

  if (adminKey !== (process.env.ADMIN_KEY || 'admin2024')) {
    return res.status(403).json({ error: 'po da sunni' });
  }

  const settings = await GameSettings.findOneAndUpdate(
    { key: 'global' },
    { gameName: name, nameSet: true },
    { upsert: true, new: true }
  );

  io.emit('gameName:updated', { gameName: settings.gameName });
  res.json({ gameName: settings.gameName });
});

app.get('/api/friends/:uid', async (req, res) => {
  const user = await User.findOne({ uid: req.params.uid });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const friends = await User.find(
    { uid: { $in: user.friends } },
    'uid username online'
  );

  const requests = await User.find(
    { uid: { $in: user.friendRequests } },
    'uid username'
  );

  res.json({ friends, requests });
});

app.get('/api/search/:username', async (req, res) => {
  const users = await User.find(
    { username: { $regex: req.params.username, $options: 'i' } },
    'uid username online'
  ).limit(10);

  res.json(users);
});

// Serve frontend
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Socket.IO ───────────────────────────────────────────────────────────

function authSocket(socket) {
  const token = socket.handshake.auth.token;
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

io.on('connection', async (socket) => {
  const user = authSocket(socket);
  if (!user) {
    socket.disconnect();
    return;
  }

  const { uid, username } = user;
  await User.findOneAndUpdate({ uid }, { socketId: socket.id, online: true });

  socket.uid = uid;
  socket.username = username;

  const me = await User.findOne({ uid });
  if (me) {
    const onlineFriends = await User.find({ uid: { $in: me.friends }, online: true });
    onlineFriends.forEach(f => {
      if (f.socketId) io.to(f.socketId).emit('friend:online', { uid, username });
    });
  }

  console.log(`[+] ${username} (${uid}) connected`);

  socket.on('friend:request', async ({ toUid }) => {
    const target = await User.findOne({ uid: toUid });
    if (!target) return socket.emit('error', { msg: 'User not found.' });
    if (target.friends.includes(uid)) return socket.emit('error', { msg: 'Already friends.' });

    if (!target.friendRequests.includes(uid)) {
      target.friendRequests.push(uid);
      await target.save();
    }

    if (target.socketId) {
      io.to(target.socketId).emit('friend:requestReceived', { uid, username });
    }

    socket.emit('friend:requestSent', { toUid, toUsername: target.username });
  });

  socket.on('friend:accept', async ({ fromUid }) => {
    const meUser = await User.findOne({ uid });
    const from = await User.findOne({ uid: fromUid });
    if (!meUser || !from) return;

    meUser.friendRequests = meUser.friendRequests.filter(u => u !== fromUid);

    if (!meUser.friends.includes(fromUid)) meUser.friends.push(fromUid);
    if (!from.friends.includes(uid)) from.friends.push(uid);

    await meUser.save();
    await from.save();

    socket.emit('friend:accepted', {
      uid: fromUid,
      username: from.username,
      online: from.online
    });

    if (from.socketId) {
      io.to(from.socketId).emit('friend:accepted', {
        uid,
        username,
        online: true
      });
    }
  });

  socket.on('friend:reject', async ({ fromUid }) => {
    await User.findOneAndUpdate({ uid }, { $pull: { friendRequests: fromUid } });
  });

  socket.on('room:create', async ({ roomId, password, digits, allowRepeat }) => {
    if (rooms[roomId]) {
      return socket.emit('room:error', { msg: 'Room ID already exists. Choose another.' });
    }

    if (!/^\d+$/.test(String(digits)) || ![2, 3, 4, 5, 6].includes(Number(digits))) {
      return socket.emit('room:error', { msg: 'Invalid digit selection.' });
    }

    rooms[roomId] = {
      id: roomId,
      password,
      hostUid: uid,
      hostUsername: username,
      hostSocketId: socket.id,
      opponentUid: null,
      opponentUsername: null,
      opponentSocketId: null,
      digits: Number(digits),
      allowRepeat: Number(digits) === 6 ? !!allowRepeat : false,
      hostSecret: null,
      opponentSecret: null,
      state: 'waiting',
      currentTurn: 'host',
      hostGuesses: [],
      opponentGuesses: [],
      totalSeconds: getTotalSeconds(Number(digits)),
      turnSeconds: 15,
      totalRemaining: 0,
      turnRemaining: 15,
      totalTimer: null,
      turnTimer: null,
      winner: null,
      winReason: null,
      pendingInvites: []
    };

    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('room:created', {
      roomId,
      digits: Number(digits),
      allowRepeat: rooms[roomId].allowRepeat
    });

    console.log(`[Room] ${username} created room ${roomId} (${digits}d)`);
  });

  socket.on('room:join', async ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('room:error', { msg: 'Room not found.' });
    if (room.password !== password) return socket.emit('room:error', { msg: 'Incorrect password.' });
    if (room.opponentUid && room.opponentUid !== uid) return socket.emit('room:error', { msg: 'Room is full.' });
    if (room.hostUid === uid) return socket.emit('room:error', { msg: 'You are the host of this room.' });
    if (room.state !== 'waiting') return socket.emit('room:error', { msg: 'Game already in progress.' });

    room.opponentUid = uid;
    room.opponentUsername = username;
    room.opponentSocketId = socket.id;
    room.state = 'secret';

    socket.join(roomId);
    socket.roomId = roomId;

    io.to(roomId).emit('room:joined', {
      roomId,
      digits: room.digits,
      allowRepeat: room.allowRepeat,
      hostUsername: room.hostUsername,
      opponentUsername: room.opponentUsername,
      hostUid: room.hostUid,
      opponentUid: room.opponentUid
    });

    broadcastRoom(room);
    console.log(`[Room] ${username} joined room ${roomId}`);
  });

  socket.on('room:invite', async ({ toUid, roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostUid !== uid) return;

    const target = await User.findOne({ uid: toUid });
    if (!target || !target.online) {
      return socket.emit('room:error', { msg: 'Friend is not online.' });
    }

    if (target.socketId) {
      io.to(target.socketId).emit('room:inviteReceived', {
        fromUid: uid,
        fromUsername: username,
        roomId
      });
    }
  });

  socket.on('room:inviteAccept', ({ roomId }) => {
    socket.emit('room:proceedToJoin', { roomId });
  });

  socket.on('room:inviteDecline', ({ roomId }) => {
    const room = rooms[roomId];
    if (room && room.hostSocketId) {
      io.to(room.hostSocketId).emit('room:inviteDeclined', { byUsername: username });
    }
  });

  socket.on('game:setSecret', ({ secret }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'secret') {
      return socket.emit('room:error', { msg: 'Not in secret phase.' });
    }

    const isHost = room.hostUid === uid;
    const validation = validateSecret(secret, room.digits, room.allowRepeat);
    if (!validation.valid) {
      return socket.emit('game:secretError', { msg: validation.msg });
    }

    if (isHost) room.hostSecret = secret;
    else room.opponentSecret = secret;

    socket.emit('game:secretAccepted');
    broadcastRoom(room);

    if (room.hostSecret && room.opponentSecret) {
      room.state = 'playing';
      room.currentTurn = 'host';
      broadcastRoom(room);
      startGameTimers(room);
    }
  });

  socket.on('game:guess', ({ guess }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') {
      return socket.emit('room:error', { msg: 'Game not in progress.' });
    }

    const isHost = room.hostUid === uid;
    const myRole = isHost ? 'host' : 'opponent';

    if (room.currentTurn !== myRole) {
      return socket.emit('room:error', { msg: 'Not your turn.' });
    }

    const validation = validateGuess(guess, room.digits, room.allowRepeat);
    if (!validation.valid) {
      return socket.emit('game:guessError', { msg: validation.msg });
    }

    const opponentSecret = isHost ? room.opponentSecret : room.hostSecret;
    const feedback = generateFeedback(opponentSecret, guess);

    const entry = {
      guess,
      ...feedback,
      turn: room.hostGuesses.length + room.opponentGuesses.length + 1
    };

    if (isHost) room.hostGuesses.push(entry);
    else room.opponentGuesses.push(entry);

    if (feedback.correctPositions === room.digits) {
      endGame(
        room,
        myRole === 'host' ? room.hostUsername : room.opponentUsername,
        'Guessed the secret number!'
      );
      return;
    }

    room.currentTurn = room.currentTurn === 'host' ? 'opponent' : 'host';

    if (room.turnTimer) clearInterval(room.turnTimer);
    startTurnTimer(room);
    broadcastRoom(room);
  });

  socket.on('room:leave', () => handleDisconnect());
  socket.on('disconnect', () => handleDisconnect());

  async function handleDisconnect() {
    const disconnectedUid = socket.uid;
    const disconnectedUsername = socket.username;

    await User.findOneAndUpdate(
      { uid: disconnectedUid },
      { online: false, socketId: null }
    );

    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];

      if (room.state !== 'ended') {
        const winner =
          room.hostUid === disconnectedUid ? room.opponentUsername : room.hostUsername;
        endGame(room, winner, `${disconnectedUsername} disconnected.`);
      }

      setTimeout(() => {
        delete rooms[roomId];
      }, 30000);
    }

    const meUser = await User.findOne({ uid: disconnectedUid });
    if (meUser) {
      const onlineFriends = await User.find({
        uid: { $in: meUser.friends },
        online: true
      });

      onlineFriends.forEach(f => {
        if (f.socketId) {
          io.to(f.socketId).emit('friend:offline', {
            uid: disconnectedUid,
            username: disconnectedUsername
          });
        }
      });
    }

    console.log(`[-] ${disconnectedUsername} disconnected`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/numgame';
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGO_URI)
  .then(async () => {
    await GameSettings.findOneAndUpdate(
      { key: 'global' },
      { $setOnInsert: { gameName: 'DIGIT DUEL', nameSet: false } },
      { upsert: true }
    );

    server.listen(PORT, () => {
      console.log(`MongoDB connected`);
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT} (no DB)`);
    });
  });
