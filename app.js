// ─────────────────────────────────────────────
//  ScreenHub — app.js
//  P2P screen sharing via PeerJS
// ─────────────────────────────────────────────

let peer = null;
let myId = null;
let myName = '';
let roomName = '';
let roomHostId = null;
let isHost = false;

// Connected peers: Map<peerId, { conn, call, name, color }>
const peers = new Map();

// Active streams we're sending
let screenStream = null;
let camStream = null;

// Calls we've made to others: Map<peerId, { screenCall, camCall }>
const outgoingCalls = new Map();

// DOM
const statusDot  = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// ── Avatar colors ──────────────────────────────
const COLORS = [
  ['#7c6af7','#2a2050'], ['#f76a8c','#502030'],
  ['#4af79a','#103a28'], ['#f7c44a','#3a2c10'],
  ['#4ac8f7','#0f2f40'], ['#f77c4a','#3a1c10'],
];
let colorIndex = 0;
function nextColor() { return COLORS[colorIndex++ % COLORS.length]; }

// ── Peer ID helpers ────────────────────────────
function makeRoomId(name) {
  // Sanitize so PeerJS accepts it; prefix with "screenhub-"
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'room';
  const rand = Math.random().toString(36).slice(2,6);
  return `screenhub-${safe}-${rand}`;
}


// ── Init PeerJS ────────────────────────────────
function initPeer(customId) {
  return new Promise((resolve, reject) => {
    const p = new Peer(customId, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      path: '/',
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      }
    });

    p.on('open', id => {
      myId = id;
      setStatus(true, 'connected');
      resolve(p);
    });

    p.on('error', err => {
      console.error('PeerJS error:', err);
      // If ID taken, try a random one
      if (err.type === 'unavailable-id') {
        const fallback = customId + '-' + Math.random().toString(36).slice(2,4);
        resolve(initPeer(fallback));
      } else {
        setStatus(false, 'error');
        reject(err);
      }
    });

    p.on('disconnected', () => setStatus(false, 'reconnecting...'));
    p.on('close', () => setStatus(false, 'offline'));

    // ── Incoming data connections ──
    p.on('connection', conn => {
      setupConn(conn, false);
    });

    // ── Incoming media calls ──
    p.on('call', call => {
      // Answer with no stream (we'll send our own separately)
      call.answer();
      call.on('stream', stream => {
        const meta = call.metadata || {};
        addVideoTile(call.peer, stream, meta.label || 'Peer', false);
      });
      call.on('close', () => removeVideoTile(call.peer + '-' + (call.metadata?.type || 'screen')));
    });
  });
}

// ── Status UI ─────────────────────────────────
function setStatus(online, text) {
  statusDot.className = 'status-dot' + (online ? ' online' : '');
  statusText.textContent = text;
}

// ── CREATE ROOM ────────────────────────────────
async function createRoom() {
  const name = document.getElementById('createName').value.trim();
  const room = document.getElementById('createRoom').value.trim();
  if (!name) return toast('Enter your name');
  if (!room) return toast('Enter a room name');

  myName = name;
  roomName = room;
  isHost = true;

  const hostId = makeRoomId(room);
  setStatus(false, 'creating...');

  try {
    peer = await initPeer(hostId);
    roomHostId = myId;
    enterRoom();
  } catch (e) {
    toast('Failed to create room: ' + e.message);
  }
}

// ── JOIN ROOM ──────────────────────────────────
async function joinRoom() {
  const name = document.getElementById('joinName').value.trim();
  const code = document.getElementById('joinCode').value.trim();
  if (!name) return toast('Enter your name');
  if (!code) return toast('Enter a room code');

  myName = name;
  roomHostId = code;
  isHost = false;

  // My guest ID
  const guestId = `screenhub-guest-${name.replace(/[^a-zA-Z0-9]/g,'').toLowerCase()}-${Math.random().toString(36).slice(2,6)}`;
  setStatus(false, 'connecting...');

  try {
    peer = await initPeer(guestId);

    // Connect to host
    const conn = peer.connect(roomHostId, {
      metadata: { name: myName, type: 'join' }
    });

    let enteredRoom = false;

    // Register data handler BEFORE open so no messages are missed
    conn.on('data', data => {
      if (data.type === 'room-info' && !enteredRoom) {
        enteredRoom = true;
        roomName = data.roomName;
        enterRoom();
      }
      // Delegate everything else to handleData once we're in
      if (enteredRoom) handleData(conn.peer, data);
    });

    conn.on('open', () => {
      conn.send({ type: 'join', name: myName, id: myId });
      // Add host to peers map
      const [fg, bg] = nextColor();
      peers.set(conn.peer, { conn, name: 'Host', color: fg, bg });
    });

    conn.on('close', () => {
      if (peers.has(conn.peer)) {
        peers.delete(conn.peer);
        removeMember(conn.peer);
        addChatSystem('Host disconnected');
      }
    });

    conn.on('error', e => toast('Could not connect: ' + e.message));

    setTimeout(() => {
      if (!enteredRoom) toast('Room not found — check the code');
    }, 8000);

  } catch (e) {
    toast('Failed to join: ' + e.message);
  }
}

// ── SETUP DATA CONNECTION ──────────────────────
// Used by: host receiving any connection, guests connecting to other guests
function setupConn(conn, isToHost) {
  const peerId = conn.peer;
  const meta = conn.metadata || {};

  const onOpen = () => {
    if (isHost) {
      conn.send({ type: 'room-info', roomName, hostId: myId });
      broadcastExcept(peerId, { type: 'peer-joined', id: peerId, name: meta.name });
      const memberData = [];
      peers.forEach((p, id) => memberData.push({ id, name: p.name }));
      conn.send({ type: 'members', members: memberData });
      if (screenStream) callPeer(peerId, screenStream, 'screen');
      if (camStream) callPeer(peerId, camStream, 'cam');
    }

    if (!peers.has(peerId)) {
      const [fg, bg] = nextColor();
      peers.set(peerId, { conn, name: meta.name || 'Peer', color: fg, bg });
      addMember(peerId, meta.name || 'Peer', fg, bg);
      addChatSystem(`${meta.name || 'Peer'} joined`);
    } else {
      peers.get(peerId).conn = conn;
    }
  };

  // PeerJS quirk: connection may already be open
  if (conn.open) onOpen();
  else conn.on('open', onOpen);

  conn.on('data', data => handleData(peerId, data));

  conn.on('close', () => {
    const p = peers.get(peerId);
    const name = p?.name || 'Peer';
    peers.delete(peerId);
    outgoingCalls.delete(peerId);
    removeMember(peerId);
    removeVideoTile(peerId + '-screen');
    removeVideoTile(peerId + '-cam');
    addChatSystem(`${name} left`);
    updateEmptyState();
  });

  conn.on('error', e => console.warn('conn error', peerId, e));
}

// ── HANDLE INCOMING DATA ───────────────────────
function handleData(fromId, data) {
  switch (data.type) {
    case 'chat': {
      const p = peers.get(fromId);
      addChatMsg(p?.name || 'Peer', data.text, p?.color || '#aaa');
      break;
    }
    case 'peer-joined': {
      // Host told us someone joined; connect to them
      if (!isHost && data.id !== myId && !peers.has(data.id)) {
        const conn = peer.connect(data.id, { metadata: { name: myName, type: 'guest' } });
        setupConn(conn, false);
      }
      break;
    }
    case 'members': {
      // Initial members list from host
      data.members.forEach(m => {
        if (m.id !== myId && !peers.has(m.id)) {
          const conn = peer.connect(m.id, { metadata: { name: myName, type: 'guest' } });
          setupConn(conn, false);
        }
      });
      break;
    }
    case 'room-info':
      // Handled upstream in joinRoom
      break;
  }
}

// ── BROADCAST ─────────────────────────────────
function broadcast(data) {
  peers.forEach(({ conn }) => { try { conn.send(data); } catch(e){} });
}

function broadcastExcept(excludeId, data) {
  peers.forEach(({ conn }, id) => {
    if (id !== excludeId) try { conn.send(data); } catch(e){}
  });
}

// ── ENTER ROOM UI ──────────────────────────────
function enterRoom() {
  showScreen('room');

  document.getElementById('roomTitle').textContent = roomName;
  document.getElementById('roomCodeDisplay').textContent = roomHostId || myId;

  // Add ourselves to members
  const [fg, bg] = nextColor();
  addMember(myId, myName, fg, bg, true);
  addChatSystem('You joined the room');
  updateEmptyState();

  // Check URL params for auto-join
  const url = new URL(window.location);
  url.searchParams.set('room', roomHostId || myId);
  url.searchParams.set('name', roomName);
  window.history.replaceState({}, '', url.toString());
}

// ── LEAVE ROOM ─────────────────────────────────
function leaveRoom() {
  stopScreenShare();
  stopCamShare();
  peers.forEach(({ conn }) => { try { conn.close(); } catch(e){} });
  peers.clear();
  if (peer) { peer.destroy(); peer = null; }
  document.getElementById('memberList').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('videoGrid').innerHTML = `
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">🖥</div>
      <p>No screens shared yet</p>
      <p style="font-size:0.75rem;opacity:0.6">Start sharing from the panel →</p>
    </div>`;
  showScreen('landing');
  window.history.replaceState({}, '', window.location.pathname);
  setStatus(false, 'disconnected');
}

// ── SCREEN SHARE ───────────────────────────────
async function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      screenStream.getVideoTracks()[0].onended = () => stopScreenShare();

      // Show our own preview
      addVideoTile(myId, screenStream, myName + ' (you)', true, 'screen');

      // Call all connected peers
      peers.forEach((_, peerId) => callPeer(peerId, screenStream, 'screen'));

      document.getElementById('shareScreenBtn').classList.add('active');
      document.getElementById('shareScreenLabel').textContent = 'Stop sharing screen';
      updateEmptyState();
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Could not share screen: ' + e.message);
    }
  }
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  removeVideoTile(myId + '-screen');
  document.getElementById('shareScreenBtn').classList.remove('active');
  document.getElementById('shareScreenLabel').textContent = 'Share your screen';
  // Close outgoing screen calls
  outgoingCalls.forEach(calls => { try { calls.screenCall?.close(); } catch(e){} });
  updateEmptyState();
}

// ── CAM SHARE ──────────────────────────────────
async function toggleCamShare() {
  if (camStream) {
    stopCamShare();
  } else {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      addVideoTile(myId, camStream, myName + ' (cam)', true, 'cam');
      peers.forEach((_, peerId) => callPeer(peerId, camStream, 'cam'));
      document.getElementById('shareCamBtn').classList.add('active');
      document.getElementById('shareCamLabel').textContent = 'Stop webcam';
      updateEmptyState();
    } catch(e) {
      if (e.name !== 'NotAllowedError') toast('Could not access webcam: ' + e.message);
    }
  }
}

function stopCamShare() {
  if (!camStream) return;
  camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  removeVideoTile(myId + '-cam');
  document.getElementById('shareCamBtn').classList.remove('active');
  document.getElementById('shareCamLabel').textContent = 'Share webcam';
  outgoingCalls.forEach(calls => { try { calls.camCall?.close(); } catch(e){} });
  updateEmptyState();
}

// ── CALL PEER ──────────────────────────────────
function callPeer(peerId, stream, type) {
  const label = `${myName}'s ${type}`;
  const call = peer.call(peerId, stream, { metadata: { type, label } });

  const existing = outgoingCalls.get(peerId) || {};
  if (type === 'screen') existing.screenCall = call;
  else existing.camCall = call;
  outgoingCalls.set(peerId, existing);
}

// ── VIDEO TILES ────────────────────────────────
function addVideoTile(peerId, stream, label, isYou, type = 'screen') {
  const tileId = peerId + '-' + type;
  if (document.getElementById('tile-' + tileId)) return; // already exists

  const emptyState = document.getElementById('emptyState');
  if (emptyState) emptyState.remove();

  const tile = document.createElement('div');
  tile.className = 'video-tile' + (isYou ? ' video-tile-you' : '');
  tile.id = 'tile-' + tileId;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  if (isYou) video.muted = true;

  const lbl = document.createElement('div');
  lbl.className = 'video-tile-label';
  lbl.textContent = label;

  tile.appendChild(video);
  tile.appendChild(lbl);
  document.getElementById('videoGrid').appendChild(tile);
}

function removeVideoTile(tileKey) {
  const el = document.getElementById('tile-' + tileKey);
  if (el) el.remove();
  updateEmptyState();
}

function updateEmptyState() {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;
  const tiles = grid.querySelectorAll('.video-tile');
  const empty = document.getElementById('emptyState');
  if (tiles.length === 0 && !empty) {
    grid.innerHTML = `<div class="empty-state" id="emptyState">
      <div class="empty-icon">🖥</div>
      <p>No screens shared yet</p>
      <p style="font-size:0.75rem;opacity:0.6">Start sharing from the panel →</p>
    </div>`;
  }
}

// ── MEMBERS LIST ───────────────────────────────
function addMember(id, name, fg, bg, isYou) {
  if (document.getElementById('member-' + id)) return;
  const el = document.createElement('div');
  el.className = 'member-item';
  el.id = 'member-' + id;
  el.innerHTML = `
    <div class="member-avatar" style="background:${bg};color:${fg}">${name[0]?.toUpperCase() || '?'}</div>
    <span class="member-name">${escHtml(name)}</span>
    ${isYou ? '<span class="member-you">you</span>' : ''}
  `;
  document.getElementById('memberList').appendChild(el);
}

function removeMember(id) {
  document.getElementById('member-' + id)?.remove();
}

// ── CHAT ───────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  broadcast({ type: 'chat', text });
  addChatMsg(myName, text, '#7c6af7');
}

function addChatMsg(name, text, color) {
  const container = document.getElementById('chatMessages');
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="chat-msg-name" style="color:${color}">${escHtml(name)}</span><span class="chat-msg-text">${escHtml(text)}</span>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function addChatSystem(text) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.innerHTML = `<span class="chat-msg-text">— ${escHtml(text)}</span>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// ── UTILS ──────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function copyInviteLink() {
  const url = new URL(window.location);
  url.searchParams.set('room', roomHostId || myId);
  url.searchParams.set('name', roomName);
  navigator.clipboard.writeText(url.toString())
    .then(() => toast('Invite link copied!'))
    .catch(() => toast('Copy the URL from your address bar'));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── AUTO-JOIN FROM URL ─────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  if (roomParam) {
    document.getElementById('joinCode').value = roomParam;
    toast('Room code pre-filled — enter your name and join!');
  }
});
