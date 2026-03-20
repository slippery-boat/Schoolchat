const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database('chat.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    id TEXT NOT NULL UNIQUE,
    username TEXT,
    nickname TEXT,
    avatar_data TEXT,
    bio TEXT
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    PRIMARY KEY (room_id, phone)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    from_phone TEXT NOT NULL,
    from_name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reactions (
    msg_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (msg_id, phone)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    blocker TEXT NOT NULL,
    blocked TEXT NOT NULL,
    PRIMARY KEY (blocker, blocked)
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

`);

// Migrations
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(r => r.name);
if (!msgCols.includes('deleted')) db.exec("ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0");
if (!msgCols.includes('img_data')) db.exec("ALTER TABLE messages ADD COLUMN img_data TEXT");
if (!msgCols.includes('reply_to')) db.exec("ALTER TABLE messages ADD COLUMN reply_to TEXT");
if (!msgCols.includes('reply_preview')) db.exec("ALTER TABLE messages ADD COLUMN reply_preview TEXT");
const userCols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
const roomCols = db.prepare("PRAGMA table_info(rooms)").all().map(r => r.name);
if (!roomCols.includes('avatar_data')) db.exec("ALTER TABLE rooms ADD COLUMN avatar_data TEXT");
if (!userCols.includes('username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT");
if (!userCols.includes('nickname')) db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
if (!userCols.includes('avatar_data')) db.exec("ALTER TABLE users ADD COLUMN avatar_data TEXT");
if (!userCols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT");
if (!userCols.includes('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT");
if (!userCols.includes('mood')) db.exec("ALTER TABLE users ADD COLUMN mood TEXT");
if (!userCols.includes('rules_accepted')) db.exec("ALTER TABLE users ADD COLUMN rules_accepted INTEGER DEFAULT 0");

const REQUIRED_VERSION = '2.5';

// In-memory kick/ban tracker: phone -> unban timestamp
const kicks = {};



function checkVersion(d, ws) {
  if(!d.version || d.version !== REQUIRED_VERSION) {
    // Send the new index.html directly over WebSocket instead of HTTP
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      ws.send(JSON.stringify({ type: 'version_outdated', html }));
    } catch(e) {
      ws.send(JSON.stringify({ type: 'version_outdated' }));
    }
    return false;
  }
  return true;
}

function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function mkToken() { return crypto.randomBytes(24).toString('hex'); }
function getRoomId(a, b) { return [a, b].sort().join('__'); }

function generatePhone() {
  for (let i = 0; i < 1000; i++) {
    const a = String(Math.floor(Math.random() * 90) + 10);
    const b = String(Math.floor(Math.random() * 900) + 100);
    const phone = a + '-' + b;
    if (!stmts.getUser.get(phone)) return phone;
  }
  return null;
}

function fmtUser(u) {
  return {
    phone: u.phone, fullName: u.full_name, username: u.username || null,
    nickname: u.nickname || null, avatarData: u.avatar_data || null,
    bio: u.bio || null, status: u.status || null, mood: u.mood || null,
    rulesAccepted: u.rules_accepted ? true : false, id: u.id
  };
}

const stmts = {
  getUser:           db.prepare('SELECT * FROM users WHERE phone = ?'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getAllUsers:       db.prepare('SELECT * FROM users'),
  insertUser:        db.prepare('INSERT INTO users (phone, full_name, password_hash, id) VALUES (?, ?, ?, ?)'),
  updateProfile:     db.prepare('UPDATE users SET nickname=?, username=?, bio=?, avatar_data=?, status=?, mood=? WHERE phone=?'),
  getRoom:           db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertRoom:        db.prepare('INSERT OR IGNORE INTO rooms (id, name, type) VALUES (?, ?, ?)'),
  getRoomsForUser:   db.prepare(`
    SELECT r.*, GROUP_CONCAT(rm2.phone) as members
    FROM rooms r
    JOIN room_members rm ON rm.room_id = r.id AND rm.phone = ?
    JOIN room_members rm2 ON rm2.room_id = r.id
    GROUP BY r.id
  `),
  insertMember:      db.prepare('INSERT OR IGNORE INTO room_members (room_id, phone) VALUES (?, ?)'),
  removeMember:      db.prepare('DELETE FROM room_members WHERE room_id = ? AND phone = ?'),
  getMembers:        db.prepare('SELECT phone FROM room_members WHERE room_id = ?'),
  insertMessage:     db.prepare('INSERT INTO messages (id, room_id, from_phone, from_name, text, ts, img_data, reply_to, reply_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getMessages:       db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY ts ASC'),
  getLastMessage:    db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT 1'),
  getMessage:        db.prepare('SELECT * FROM messages WHERE id = ?'),
  deleteMessage:     {run:(a,b)=>{db.prepare('UPDATE messages SET deleted=1,text="",img_data=NULL WHERE id=? AND from_phone=?').run(a,b)}},
  getReactions:      db.prepare('SELECT * FROM reactions WHERE msg_id = ?'),
  upsertReaction:    db.prepare('INSERT OR REPLACE INTO reactions (msg_id, phone, emoji) VALUES (?, ?, ?)'),
  removeReaction:    db.prepare('DELETE FROM reactions WHERE msg_id = ? AND phone = ?'),
  blockUser:         db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)'),
  unblockUser:       db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?'),
  getBlocks:         db.prepare('SELECT blocked FROM blocks WHERE blocker = ?'),
  isBlocked:         db.prepare('SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?'),
  // Channels
  getChannels:       db.prepare('SELECT * FROM channels WHERE group_id = ? ORDER BY position ASC'),
  getChannel:        db.prepare('SELECT * FROM channels WHERE id = ?'),
  insertChannel:     db.prepare('INSERT INTO channels (id, group_id, name, position) VALUES (?, ?, ?, ?)'),
  deleteChannel:     db.prepare('DELETE FROM channels WHERE id = ? AND group_id = ?'),
  renameChannel:     db.prepare('UPDATE channels SET name=? WHERE id=?'),
  maxChannelPos:     db.prepare('SELECT MAX(position) as mp FROM channels WHERE group_id = ?'),
};

function fmtMsg(row) {
  return {
    id: row.id, from: row.from_phone, fromName: row.from_name,
    text: row.deleted ? '' : row.text, ts: row.ts, roomId: row.room_id,
    deleted: !!row.deleted, imgData: row.deleted ? null : (row.img_data || null),
    replyTo: row.reply_to || null, replyPreview: row.reply_preview || null
  };
}

function formatRoom(row) {
  const members = row.members ? row.members.split(',') : stmts.getMembers.all(row.id).map(r => r.phone);
  const lm = stmts.getLastMessage.get(row.id);
  const lastMsg = lm ? fmtMsg(lm) : null;
  const channels = row.type === 'group' ? stmts.getChannels.all(row.id) : [];
  return { id: row.id, name: row.name, type: row.type, members, lastMsg, avatarData: row.avatar_data || null, channels };
}

function getReactionsForMsg(msgId) {
  const rows = stmts.getReactions.all(msgId);
  const result = {};
  rows.forEach(r => { if (!result[r.emoji]) result[r.emoji] = []; result[r.emoji].push(r.phone); });
  return result;
}

// Auto-create #general channel for groups that don't have one
function ensureGeneralChannel(groupId) {
  const existing = stmts.getChannels.all(groupId);
  if (existing.length === 0) {
    stmts.insertChannel.run('ch_' + crypto.randomUUID(), groupId, 'general', 0);
  }
}

const server = http.createServer((req, res) => {
  // Always serve index.html at root and /update with no-cache headers
  const serveIndex = req.url === '/' || req.url === '/update';
  let fp = serveIndex ? '/index.html' : req.url;
  fp = path.join(__dirname, fp);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': mime[path.extname(fp)] || 'text/plain' };
    if (serveIndex) {
      // No cache so auto-update always gets fresh file
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const clients = {};
const sessions = {};

function broadcast(roomId, msg) {
  stmts.getMembers.all(roomId).forEach(({ phone }) => {
    if (clients[phone]) clients[phone].forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
  });
}
function sendTo(phone, msg) {
  if (clients[phone]) clients[phone].forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  });
}
function broadcastAll(msg) {
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); });
}
function broadcastOnlineList() {
  const online = Object.keys(clients).filter(p => clients[p] && clients[p].size > 0);
  broadcastAll({ type: 'online_users', users: online });
}

wss.on('connection', (ws) => {
  let myPhone = null;

  function loginSuccess(phone, token) {
    myPhone = phone;
    if (!clients[phone]) clients[phone] = new Set();
    clients[phone].add(ws);
    const user = stmts.getUser.get(phone);
    const rooms = stmts.getRoomsForUser.all(phone).map(formatRoom);
    // Ensure all groups have a #general channel
    rooms.forEach(r => { if (r.type === 'group') ensureGeneralChannel(r.id); });
    const users = stmts.getAllUsers.all().map(fmtUser);
    const blockedList = stmts.getBlocks.all(phone).map(r => r.blocked);
    ws.send(JSON.stringify({ type: 'login_ok', token, user: fmtUser(user), rooms, users, blockedList }));
    broadcastOnlineList();
  }

  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const err = (msg) => ws.send(JSON.stringify({ type: 'error', msg }));

    if (d.type === 'register') {
      if (!checkVersion(d, ws)) return;
      if (!d.fullName || !d.password) return err('Missing fields');
      const phone = generatePhone();
      if (!phone) return err('Server is full');
      stmts.insertUser.run(phone, d.fullName, hash(d.password), crypto.randomUUID());
      ws.send(JSON.stringify({ type: 'register_ok', phone }));
    }
    else if (d.type === 'login') {
      if (!checkVersion(d, ws)) return;
      let phone = d.phone;
      // Resolve username first for kick check
      if (!/^\d{2}-\d{3}$/.test(phone)) {
        const byU = db.prepare('SELECT phone FROM users WHERE LOWER(username) = LOWER(?)').get(phone);
        if (byU) phone = byU.phone;
      }
      if (kicks[phone] && kicks[phone] > Date.now()) {
        const minsLeft = Math.ceil((kicks[phone] - Date.now()) / 60000);
        return ws.send(JSON.stringify({ type: 'error', msg: `You are kicked. Try again in ${minsLeft} minute(s).` }));
      }
      if (!/^\d{2}-\d{3}$/.test(phone)) {
        const byUsername = db.prepare('SELECT phone FROM users WHERE LOWER(username) = LOWER(?)').get(phone);
        if (byUsername) phone = byUsername.phone;
      }
      const user = stmts.getUser.get(phone);
      if (!user || user.password_hash !== hash(d.password)) return err('Invalid phone/username or password');
      const t = mkToken(); sessions[t] = phone;
      loginSuccess(phone, t);
    }
    else if (d.type === 'resume') {
      if (!checkVersion(d, ws)) return;
      const phone = sessions[d.token];
      if (!phone || !stmts.getUser.get(phone)) return ws.send(JSON.stringify({ type: 'session_invalid' }));
      loginSuccess(phone, d.token);
    }
    else if (d.type === 'update_profile') {
      if (!myPhone) return;
      const user = stmts.getUser.get(myPhone);
      if (d.username && d.username !== user.username) {
        const existing = stmts.getUserByUsername.get(d.username);
        if (existing && existing.phone !== myPhone) return err('Username already taken');
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(d.username)) return err('Username must be 3-20 chars, letters/numbers/underscore only');
      }
      const nickname = (d.nickname || '').trim().slice(0, 32) || null;
      const username = (d.username || '').trim().slice(0, 20) || null;
      const bio = (d.bio || '').trim().slice(0, 150) || null;
      const status = (d.status || '').trim().slice(0, 60) || null;
      const mood = (d.mood || '').trim().slice(0, 4) || null;
      const avatarData = d.avatarData || user.avatar_data || null;
      stmts.updateProfile.run(nickname, username, bio, avatarData, status, mood, myPhone);
      const updated = fmtUser(stmts.getUser.get(myPhone));
      ws.send(JSON.stringify({ type: 'profile_updated', user: updated }));
      broadcastAll({ type: 'user_updated', user: updated });
    }
    else if (d.type === 'get_profile') {
      const user = stmts.getUser.get(d.phone);
      if (!user) return err('User not found');
      ws.send(JSON.stringify({ type: 'profile_data', user: fmtUser(user) }));
    }
    else if (d.type === 'accept_rules') {
      if (!myPhone) return;
      db.prepare('UPDATE users SET rules_accepted=1 WHERE phone=?').run(myPhone);
    }
    else if (d.type === 'open_dm') {
      if (!myPhone) return;
      if (!stmts.getUser.get(d.targetPhone)) return err('User not found');
      if (stmts.isBlocked.get(myPhone, d.targetPhone)) return err('You have blocked this user');
      if (stmts.isBlocked.get(d.targetPhone, myPhone)) return err('You cannot message this user');
      const roomId = getRoomId(myPhone, d.targetPhone);
      stmts.insertRoom.run(roomId, null, 'dm');
      stmts.insertMember.run(roomId, myPhone);
      stmts.insertMember.run(roomId, d.targetPhone);
      const room = formatRoom(stmts.getRoom.get(roomId));
      const history = stmts.getMessages.all(roomId).map(fmtMsg);
      ws.send(JSON.stringify({ type: 'room_opened', room, history }));
    }
    else if (d.type === 'create_group') {
      if (!myPhone) return;
      if (!d.name || !d.members || d.members.length < 1) return err('Need a name and at least 1 member');
      const allMembers = [...new Set([myPhone, ...d.members])];
      const roomId = 'grp_' + crypto.randomUUID();
      stmts.insertRoom.run(roomId, d.name, 'group');
      allMembers.forEach(p => stmts.insertMember.run(roomId, p));
      // Auto-create #general channel
      stmts.insertChannel.run('ch_' + crypto.randomUUID(), roomId, 'general', 0);
      const room = formatRoom(stmts.getRoom.get(roomId));
      allMembers.forEach(phone => sendTo(phone, { type: 'group_created', room }));
    }
    else if (d.type === 'load_history') {
      if (!myPhone) return;
      // d.roomId is a channel id for groups, or a dm room id
      const channel = stmts.getChannel.get(d.roomId);
      const roomId = channel ? channel.group_id : d.roomId;
      const members = stmts.getMembers.all(roomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      ws.send(JSON.stringify({ type: 'history', roomId: d.roomId, messages: stmts.getMessages.all(d.roomId).map(fmtMsg) }));
    }
    else if (d.type === 'message') {
      if (!myPhone) return;
      if (!stmts.getUser.get(myPhone)) return;
      // d.roomId can be a channel id or a dm room id
      const channel = stmts.getChannel.get(d.roomId);
      const groupId = channel ? channel.group_id : null;
      const actualRoomId = groupId || d.roomId;
      const members = stmts.getMembers.all(actualRoomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      if (!d.text && !d.imgData) return;
      // Validate image size (2MB max as base64 ~2.7MB)
      if (d.imgData && d.imgData.length > 2900000) return err('Image too large (max 2MB)');
      const room = stmts.getRoom.get(actualRoomId);
      if (room.type === 'dm') {
        const other = members.find(p => p !== myPhone);
        if (stmts.isBlocked.get(myPhone, other) || stmts.isBlocked.get(other, myPhone)) return;
      }
      const user = stmts.getUser.get(myPhone);
      const displayName = user.nickname || user.full_name;
      const text = (d.text || '').trim();
      const replyTo = d.replyTo || null;
      const replyPreview = d.replyPreview || null;
      const msg = { id: crypto.randomUUID(), room_id: d.roomId, from_phone: myPhone, from_name: displayName, text: text || (d.imgData ? '__img__' : ''), ts: Date.now(), img_data: d.imgData || null, reply_to: replyTo, reply_preview: replyPreview };
      stmts.insertMessage.run(msg.id, msg.room_id, msg.from_phone, msg.from_name, msg.text, msg.ts, msg.img_data, msg.reply_to, msg.reply_preview);
      // Broadcast to group members using actualRoomId for member lookup
      members.forEach(phone => sendTo(phone, { type: 'message', message: fmtMsg(msg) }));
    }
    else if (d.type === 'delete_message') {
      if (!myPhone) return;
      const msg = stmts.getMessage.get(d.msgId);
      if (!msg || msg.from_phone !== myPhone) return;
      stmts.deleteMessage.run(d.msgId, myPhone);
      // Find group members for broadcast
      const channel = stmts.getChannel.get(msg.room_id);
      const broadcastRoomId = channel ? channel.group_id : msg.room_id;
      broadcast(broadcastRoomId, { type: 'message_deleted', msgId: d.msgId });
    }
    else if (d.type === 'react') {
      if (!myPhone) return;
      const msg = stmts.getMessage.get(d.msgId);
      if (!msg) return;
      const channel = stmts.getChannel.get(msg.room_id);
      const broadcastRoomId = channel ? channel.group_id : msg.room_id;
      const members = stmts.getMembers.all(broadcastRoomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      const existing = stmts.getReactions.all(d.msgId).find(r => r.phone === myPhone);
      if (existing && existing.emoji === d.emoji) stmts.removeReaction.run(d.msgId, myPhone);
      else stmts.upsertReaction.run(d.msgId, myPhone, d.emoji);
      members.forEach(phone => sendTo(phone, { type: 'reaction_update', msgId: d.msgId, reactions: getReactionsForMsg(d.msgId) }));
    }
    else if (d.type === 'typing') {
      if (!myPhone) return;
      const user = stmts.getUser.get(myPhone);
      if (!user) return;
      const channel = stmts.getChannel.get(d.roomId);
      const actualRoomId = channel ? channel.group_id : d.roomId;
      const members = stmts.getMembers.all(actualRoomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      members.forEach(phone => {
        if (phone === myPhone) return;
        sendTo(phone, { type: 'typing', phone: myPhone, name: user.nickname || user.full_name, roomId: d.roomId });
      });
    }
    else if (d.type === 'block_user') {
      if (!myPhone) return;
      stmts.blockUser.run(myPhone, d.targetPhone);
      ws.send(JSON.stringify({ type: 'block_ok', phone: d.targetPhone }));
    }
    else if (d.type === 'unblock_user') {
      if (!myPhone) return;
      stmts.unblockUser.run(myPhone, d.targetPhone);
      ws.send(JSON.stringify({ type: 'unblock_ok', phone: d.targetPhone }));
    }
    else if (d.type === 'update_group') {
      if (!myPhone) return;
      const room = stmts.getRoom.get(d.roomId);
      if (!room || room.type !== 'group') return;
      const members = stmts.getMembers.all(d.roomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      const name = (d.name || '').trim().slice(0, 40);
      if (!name) return err('Name cannot be empty');
      db.prepare('UPDATE rooms SET name = ?, avatar_data = ? WHERE id = ?').run(name, d.avatarData || null, d.roomId);
      members.forEach(phone => sendTo(phone, { type: 'group_updated', roomId: d.roomId, name, avatarData: d.avatarData || null }));
    }
    else if (d.type === 'leave_group') {
      if (!myPhone) return;
      const user = stmts.getUser.get(myPhone);
      if (!user) return;
      const displayName = user.nickname || user.full_name;
      const msgId = crypto.randomUUID();
      // Post system msg in first channel
      const channels = stmts.getChannels.all(d.roomId);
      const postChannelId = channels.length > 0 ? channels[0].id : d.roomId;
      stmts.insertMessage.run(msgId, postChannelId, myPhone, displayName, `__left__${displayName} left the group`, Date.now(), null, null, null);
      const remaining = stmts.getMembers.all(d.roomId).map(r => r.phone).filter(p => p !== myPhone);
      db.prepare('DELETE FROM room_members WHERE room_id=? AND phone=?').run(d.roomId, myPhone);
      remaining.forEach(phone => sendTo(phone, { type: 'member_left', roomId: d.roomId, phone: myPhone, name: displayName }));
      sendTo(myPhone, { type: 'you_left', roomId: d.roomId });
    }
    else if (d.type === 'add_to_group') {
      if (!myPhone) return;
      const room = stmts.getRoom.get(d.roomId);
      if (!room || room.type !== 'group') return;
      const members = stmts.getMembers.all(d.roomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      if (!stmts.getUser.get(d.targetPhone)) return err('User not found');
      stmts.insertMember.run(d.roomId, d.targetPhone);
      const adder = stmts.getUser.get(myPhone);
      const added = stmts.getUser.get(d.targetPhone);
      const adderName = adder.nickname || adder.full_name;
      const addedName = added.nickname || added.full_name;
      const msgId = crypto.randomUUID();
      const channels = stmts.getChannels.all(d.roomId);
      const postChannelId = channels.length > 0 ? channels[0].id : d.roomId;
      stmts.insertMessage.run(msgId, postChannelId, myPhone, adderName, `__added__${adderName} added ${addedName}`, Date.now(), null, null, null);
      const allMembers = stmts.getMembers.all(d.roomId).map(r => r.phone);
      const roomData = formatRoom(stmts.getRoom.get(d.roomId));
      allMembers.forEach(phone => sendTo(phone, { type: 'member_added', roomId: d.roomId, room: roomData, adder: adderName, added: addedName }));
    }
    // ===== CHANNEL HANDLERS =====
    else if (d.type === 'create_channel') {
      if (!myPhone) return;
      const room = stmts.getRoom.get(d.groupId);
      if (!room || room.type !== 'group') return;
      const members = stmts.getMembers.all(d.groupId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      const name = (d.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      if (!name) return err('Invalid channel name');
      const existing = stmts.getChannels.all(d.groupId);
      if (existing.length >= 20) return err('Max 20 channels per group');
      const pos = (stmts.maxChannelPos.get(d.groupId).mp || 0) + 1;
      const channelId = 'ch_' + crypto.randomUUID();
      stmts.insertChannel.run(channelId, d.groupId, name, pos);
      const channel = stmts.getChannel.get(channelId);
      members.forEach(phone => sendTo(phone, { type: 'channel_created', groupId: d.groupId, channel }));
    }
    else if (d.type === 'delete_channel') {
      if (!myPhone) return;
      const channel = stmts.getChannel.get(d.channelId);
      if (!channel) return;
      const members = stmts.getMembers.all(channel.group_id).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      const allChannels = stmts.getChannels.all(channel.group_id);
      if (allChannels.length <= 1) return err('Cannot delete the last channel');
      stmts.deleteChannel.run(d.channelId, channel.group_id);
      db.prepare('DELETE FROM messages WHERE room_id=?').run(d.channelId);
      members.forEach(phone => sendTo(phone, { type: 'channel_deleted', groupId: channel.group_id, channelId: d.channelId }));
    }
    else if (d.type === 'rename_channel') {
      if (!myPhone) return;
      const channel = stmts.getChannel.get(d.channelId);
      if (!channel) return;
      const members = stmts.getMembers.all(channel.group_id).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      const name = (d.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      if (!name) return err('Invalid channel name');
      stmts.renameChannel.run(name, d.channelId);
      members.forEach(phone => sendTo(phone, { type: 'channel_renamed', groupId: channel.group_id, channelId: d.channelId, name }));
    }
    // ===== WEBRTC VOICE SIGNALING =====
    else if (d.type === 'call_offer') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'call_offer', from: myPhone, offer: d.offer });
    }
    else if (d.type === 'call_answer') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'call_answer', from: myPhone, answer: d.answer });
    }
    else if (d.type === 'call_ice') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'call_ice', from: myPhone, candidate: d.candidate });
    }
    else if (d.type === 'call_end') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'call_end', from: myPhone });
    }
    else if (d.type === 'call_reject') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'call_reject', from: myPhone });
    }
    // ===== VOICE CHANNELS =====
    else if (d.type === 'join_voice') {
      if (!myPhone) return;
      const room = stmts.getRoom.get(d.roomId);
      if (!room) return;
      const members = stmts.getMembers.all(d.roomId).map(r => r.phone);
      if (!members.includes(myPhone)) return;
      // Notify everyone in the room someone joined voice
      members.forEach(phone => sendTo(phone, { type: 'voice_joined', roomId: d.roomId, phone: myPhone }));
    }
    else if (d.type === 'leave_voice') {
      if (!myPhone) return;
      const room = stmts.getRoom.get(d.roomId);
      if (!room) return;
      const members = stmts.getMembers.all(d.roomId).map(r => r.phone);
      members.forEach(phone => sendTo(phone, { type: 'voice_left', roomId: d.roomId, phone: myPhone }));
    }
    else if (d.type === 'voice_offer') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'voice_offer', from: myPhone, roomId: d.roomId, offer: d.offer });
    }
    else if (d.type === 'voice_answer') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'voice_answer', from: myPhone, roomId: d.roomId, answer: d.answer });
    }
    else if (d.type === 'voice_ice') {
      if (!myPhone) return;
      sendTo(d.targetPhone, { type: 'voice_ice', from: myPhone, roomId: d.roomId, candidate: d.candidate });
    }
    else if (d.type === 'admin_kick_user') {
      if (!myPhone || myPhone !== 'YOUR_ADMIN_PHONE_HERE') return err('Not authorized');
      const target = d.phone;
      const minutes = parseInt(d.minutes) || 60;
      if (!target || target === myPhone) return err('Invalid target');
      // Set kick expiry
      kicks[target] = Date.now() + minutes * 60 * 1000;
      // Disconnect their session
      if (clients[target]) {
        clients[target].forEach(ws => {
          ws.send(JSON.stringify({ type: 'kicked', minutes, reason: d.reason || 'Kicked by admin' }));
          setTimeout(() => ws.close(), 500);
        });
      }
      ws.send(JSON.stringify({ type: 'admin_kick_ok', phone: target, minutes }));
    }
    else if (d.type === 'get_users') {
      ws.send(JSON.stringify({ type: 'users_list', users: stmts.getAllUsers.all().map(fmtUser) }));
    }
    else if (d.type === 'admin_delete_user') {
      if (!myPhone) return;
      const target = d.phone;
      if (!target || target === myPhone) return;
      db.prepare('DELETE FROM messages WHERE from_phone=?').run(target);
      const theirRooms = db.prepare('SELECT room_id FROM room_members WHERE phone=?').all(target);
      theirRooms.forEach(({room_id}) => {
        const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(room_id);
        if (room && room.type === 'dm') {
          db.prepare('DELETE FROM messages WHERE room_id=?').run(room_id);
          db.prepare('DELETE FROM room_members WHERE room_id=?').run(room_id);
          db.prepare('DELETE FROM rooms WHERE id=?').run(room_id);
        }
      });
      db.prepare('DELETE FROM room_members WHERE phone=?').run(target);
      db.prepare('DELETE FROM reactions WHERE phone=?').run(target);
      db.prepare('DELETE FROM blocks WHERE blocker=? OR blocked=?').run(target, target);
      db.prepare('DELETE FROM users WHERE phone=?').run(target);
      if (clients[target]) {
        try { clients[target].forEach(ws => ws.close()); } catch(e) {}
        delete clients[target];
      }
      broadcastAll({ type: 'user_deleted', phone: target });
      ws.send(JSON.stringify({ type: 'admin_delete_ok', phone: target }));
    }
  });

  ws.on('close', () => {
    if (myPhone && clients[myPhone]) {
      clients[myPhone].delete(ws);
      if (clients[myPhone].size === 0) delete clients[myPhone];
      broadcastOnlineList();
    }
  });
});

server.listen(3000, () => {
  console.log('✅ Chat server running at http://localhost:3000');
  console.log('💾 Database: chat.db');
});


