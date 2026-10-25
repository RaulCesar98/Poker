const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/health', (_req, res) => res.send('ok'));

const tables = new Map();

const cleanName = n => String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16) || 'Jogador';
const cleanRoom = r => String(r || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'principal';
const cleanToken = t => String(t || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);

function listRooms() {
  return [...tables.values()].map(t => ({
    id: t.id, players: t.playerCount(), smallBlind: t.smallBlind, bigBlind: t.bigBlind,
    startStack: t.startStack, playing: t.stage !== 'waiting'
  })).sort((a, b) => b.players - a.players);
}

// remove mesas vazias e paradas
setInterval(() => {
  for (const [id, t] of tables) {
    const nobody = t.viewers.size === 0 && !t.seats.some(p => p && p.connected);
    if (nobody && Date.now() - t.lastActivity > 10 * 60 * 1000) { t.destroy(); tables.delete(id); }
  }
}, 60 * 1000);

io.on('connection', socket => {
  const table = () => tables.get(socket.data.room);

  socket.on('rooms', cb => { if (typeof cb === 'function') cb(listRooms()); });

  socket.on('join', (data = {}, cb) => {
    const room = cleanRoom(data.room);
    const name = cleanName(data.name);
    const token = cleanToken(data.token) || socket.id;
    const prev = table();
    if (prev && prev.id !== room) prev.leave(socket);

    let t = tables.get(room);
    if (!t) {
      t = new Table(room, data.opts || {});
      tables.set(room, t);
    }
    socket.data.room = room;
    socket.data.name = name;
    socket.data.token = token;
    socket.join(room);
    const seat = t.join(socket, name, token);
    if (typeof cb === 'function') {
      cb({ ok: true, room, seat, smallBlind: t.smallBlind, bigBlind: t.bigBlind, startStack: t.startStack });
    }
  });

  socket.on('sit', (data = {}) => {
    const t = table(); if (!t) return;
    const err = t.sit(socket, data.seat, socket.data.name, socket.data.token);
    if (err) socket.emit('toast', err);
  });

  socket.on('action', (data = {}) => {
    const t = table(); if (!t) return;
    const err = t.actBySocket(socket.id, String(data.action || ''), data.amount);
    if (err) socket.emit('toast', err);
  });

  socket.on('rebuy', () => {
    const t = table(); if (!t) return;
    const err = t.rebuy(socket);
    if (err) socket.emit('toast', err);
  });

  socket.on('sitout', () => { const t = table(); if (t) t.toggleSitOut(socket); });

  socket.on('chat', (msg) => {
    const t = table(); if (!t) return;
    const text = String(msg || '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    if (socket.data.lastChat && now - socket.data.lastChat < 600) return;
    socket.data.lastChat = now;
    const seat = t.seatOf(socket.id);
    io.to(t.id).emit('chat', { name: socket.data.name, color: seat >= 0 ? t.seats[seat].color : '#aaa', text });
  });

  socket.on('leave', () => {
    const t = table(); if (!t) return;
    t.leave(socket);
    socket.leave(t.id);
    socket.data.room = null;
  });

  socket.on('disconnect', () => {
    const t = table();
    if (t) t.disconnect(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Poker rodando na porta ${PORT}`));
