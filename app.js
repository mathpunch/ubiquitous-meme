// ═══════════════════════════════════════════════
//  ScreenHub — app.js  v2.0
//  Discord-style: mic, admin, voice, bg-audio
// ═══════════════════════════════════════════════

// ── State ─────────────────────────────────────
let peer = null, myId = null, myName = '', roomName = '', roomHostId = null;
let isHost = false, isAdmin = false;
let micStream = null, screenStream = null, camStream = null;
let micMuted = false, deafened = false;
let audioCtx = null, analyser = null, micSource = null;
let currentView = 'video';

// peers Map: peerId → { conn, name, color, bg, micCall, screenCall, camCall, muted, speaking }
const peers = new Map();
// outgoing calls Map: peerId → { micCall, screenCall, camCall }
const outCalls = new Map();
// server-muted peers (admin action): Set<peerId>
const serverMuted = new Set();

// ── Colors ────────────────────────────────────
const COLORS = [
  ['#7c6af7','#2a2050'],['#f76a8c','#502030'],['#4af79a','#103a28'],
  ['#f7c44a','#3a2c10'],['#4ac8f7','#0f2f40'],['#f77c4a','#3a1c10'],
  ['#c46af7','#3a1050'],['#6af7d0','#0f3a30'],
];
let _ci = 0;
function nextColor() { return COLORS[_ci++ % COLORS.length]; }

// ── DOM helpers ───────────────────────────────
const $ = id => document.getElementById(id);
const statusDot  = () => $('statusDot');
const statusText = () => $('statusText');

function setStatus(online, text) {
  const d = statusDot();
  if (d) d.className = 'status-dot' + (online ? ' on' : '');
  const t = statusText();
  if (t) t.textContent = text;
}

// ── Toast ─────────────────────────────────────
let _tt;
function toast(msg, duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Peer ID ───────────────────────────────────
function makeRoomId(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g,'').toLowerCase() || 'room';
  return `screenhub-${safe}-${Math.random().toString(36).slice(2,6)}`;
}

// ── Init PeerJS ───────────────────────────────
function initPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id, {
      host: '0.peerjs.com', port: 443, secure: true, path: '/',
      config: { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]}
    });

    p.on('open', pid => { myId = pid; setStatus(true,'connected'); resolve(p); });

    p.on('error', err => {
      console.error('PeerJS:', err);
      if (err.type === 'unavailable-id') resolve(initPeer(id + '-' + Math.random().toString(36).slice(2,4)));
      else { setStatus(false,'error'); reject(err); }
    });

    p.on('disconnected', () => {
      setStatus(false,'reconnecting...');
      // Auto-reconnect
      setTimeout(() => { if (p && !p.destroyed) p.reconnect(); }, 2000);
    });

    p.on('close', () => setStatus(false,'offline'));

    // ── Incoming data connections (host receives)
    p.on('connection', conn => setupConn(conn));

    // ── Incoming media calls
    p.on('call', handleIncomingCall);
  });
}

// ── Incoming call handler ─────────────────────
function handleIncomingCall(call) {
  const meta = call.metadata || {};
  const peerId = call.peer;

  // Answer with our mic if we have one and aren't muted
  const answerStream = (meta.type === 'mic' && micStream && !micMuted) ? micStream : null;
  call.answer(answerStream || undefined);

  call.on('stream', stream => {
    if (meta.type === 'mic') {
      receiveMicStream(peerId, stream, meta.name || 'Peer');
    } else if (meta.type === 'screen') {
      addVideoTile(peerId, stream, meta.name || 'Peer', false, 'screen');
    } else if (meta.type === 'cam') {
      addVideoTile(peerId, stream, meta.name || 'Peer', false, 'cam');
    }
  });

  call.on('close', () => {
    if (meta.type === 'screen') removeVideoTile(peerId + '-screen');
    if (meta.type === 'cam') removeVideoTile(peerId + '-cam');
    if (meta.type === 'mic') removeMicAudio(peerId);
  });

  call.on('error', e => console.warn('call error', e));

  // Store incoming call ref
  const p = peers.get(peerId);
  if (p) {
    if (meta.type === 'mic') p.micCall = call;
  }
}

// ── Mic audio receiving ───────────────────────
const micAudioEls = new Map(); // peerId → <audio>

function receiveMicStream(peerId, stream, name) {
  // Remove existing
  removeMicAudio(peerId);

  const audio = document.createElement('audio');
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.playsInline = true;
  // Keep playing even in background — key for "switch apps" behavior
  document.body.appendChild(audio);
  micAudioEls.set(peerId, audio);

  if (deafened) audio.volume = 0;

  // Speaking detection for this peer
  setupRemoteSpeakingDetection(peerId, stream);
}

function removeMicAudio(peerId) {
  const el = micAudioEls.get(peerId);
  if (el) { el.srcObject = null; el.remove(); micAudioEls.delete(peerId); }
}

// ── Speaking detection ────────────────────────
function setupLocalSpeakingDetection(stream) {
  if (!stream) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (micSource) { try { micSource.disconnect(); } catch(e){} }
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    micSource = audioCtx.createMediaStreamSource(stream);
    micSource.connect(analyser);
    monitorSpeaking();
  } catch(e) { console.warn('AudioCtx failed:', e); }
}

function monitorSpeaking() {
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  let wasSpeaking = false;

  function tick() {
    if (!analyser) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a,b) => a+b,0) / data.length;
    const isSpeaking = avg > 15 && !micMuted;

    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      broadcast({ type: 'speaking', speaking: isSpeaking });
      setLocalSpeaking(isSpeaking);
    }
    requestAnimationFrame(tick);
  }
  tick();
}

function setupRemoteSpeakingDetection(peerId, stream) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 256;
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(analyserR);
    const data = new Uint8Array(analyserR.frequencyBinCount);
    let wasSpeaking = false;

    function tick() {
      if (!peers.has(peerId)) return;
      analyserR.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0)/data.length;
      const isSpeaking = avg > 12;
      if (isSpeaking !== wasSpeaking) {
        wasSpeaking = isSpeaking;
        setPeerSpeaking(peerId, isSpeaking);
      }
      requestAnimationFrame(tick);
    }
    tick();
  } catch(e) {}
}

function setLocalSpeaking(speaking) {
  // Highlight my voice card
  const el = document.querySelector(`[data-voiceid="${myId}"]`);
  if (el) el.classList.toggle('speaking', speaking);
  // Also set tile
  const tile = $('tile-' + myId + '-mic');
  if (tile) tile.classList.toggle('speaking', speaking);
}

function setPeerSpeaking(peerId, speaking) {
  const p = peers.get(peerId);
  if (p) p.speaking = speaking;
  const el = document.querySelector(`[data-voiceid="${peerId}"]`);
  if (el) el.classList.toggle('speaking', speaking);
  const tile = $('tile-' + peerId + '-screen') || $('tile-' + peerId + '-cam');
  if (tile) tile.classList.toggle('speaking', speaking);
  // Speaking from broadcast
}

// ── CREATE ROOM ───────────────────────────────
async function createRoom() {
  const name = $('createName').value.trim();
  const room = $('createRoom').value.trim();
  if (!name) return toast('Enter your name');
  if (!room) return toast('Enter a room name');

  myName = name; roomName = room; isHost = true; isAdmin = true;
  setStatus(false,'creating...');

  try {
    peer = await initPeer(makeRoomId(room));
    roomHostId = myId;
    enterRoom();
    // Auto-start mic
    await startMic();
  } catch(e) { toast('Failed to create: ' + e.message); }
}

// ── JOIN ROOM ─────────────────────────────────
async function joinRoom() {
  const name = $('joinName').value.trim();
  const code = $('joinCode').value.trim();
  if (!name) return toast('Enter your name');
  if (!code) return toast('Enter a room code');

  myName = name; roomHostId = code; isHost = false; isAdmin = false;
  setStatus(false,'connecting...');

  try {
    const guestId = `screenhub-g-${name.replace(/[^a-zA-Z0-9]/g,'').toLowerCase()}-${Math.random().toString(36).slice(2,6)}`;
    peer = await initPeer(guestId);

    const conn = peer.connect(roomHostId, { metadata: { name: myName, type: 'join' } });

    let entered = false;

    conn.on('data', data => {
      if (data.type === 'room-info' && !entered) {
        entered = true;
        roomName = data.roomName;
        if (data.adminKicked) return toast('You were kicked by admin');
        enterRoom();
        startMic();
      }
      if (entered) handleData(conn.peer, data);
    });

    conn.on('open', () => {
      conn.send({ type: 'join', name: myName, id: myId });
      if (!peers.has(conn.peer)) {
        const [fg,bg] = nextColor();
        peers.set(conn.peer, { conn, name: 'Host', color: fg, bg });
      }
    });

    conn.on('close', () => {
      peers.delete(conn.peer);
      removeMember(conn.peer);
      addChatSystem('Host left the room');
    });

    conn.on('error', e => toast('Connection error: ' + e.message));

    setTimeout(() => { if (!entered) toast('Room not found — check the code'); }, 9000);

  } catch(e) { toast('Failed to join: ' + e.message); }
}

// ── SETUP CONN (host receives, or guest↔guest) ─
function setupConn(conn) {
  const peerId = conn.peer;
  const meta = conn.metadata || {};

  const onOpen = () => {
    if (isAdmin) {
      // Check if this peer is banned
      if (serverMuted.has(peerId)) {
        conn.send({ type: 'admin-mute', muted: true });
      }
    }

    if (isHost) {
      conn.send({ type: 'room-info', roomName, hostId: myId });
      broadcastExcept(peerId, { type: 'peer-joined', id: peerId, name: meta.name });
      const existing = [];
      peers.forEach((p, id) => existing.push({ id, name: p.name }));
      conn.send({ type: 'members', members: existing });
      // Call new peer with our mic
      if (micStream) callPeer(peerId, micStream, 'mic');
      if (screenStream) callPeer(peerId, screenStream, 'screen');
      if (camStream) callPeer(peerId, camStream, 'cam');
    }

    if (!peers.has(peerId)) {
      const [fg,bg] = nextColor();
      peers.set(peerId, { conn, name: meta.name || 'Peer', color: fg, bg, muted: false, speaking: false });
      addMemberUI(peerId, meta.name || 'Peer', fg, bg);
      addVoiceCard(peerId, meta.name || 'Peer', fg, bg);
      addChatSystem(`${meta.name || 'Peer'} joined`);
      updateMemberCount();
    } else {
      peers.get(peerId).conn = conn;
    }
  };

  if (conn.open) onOpen(); else conn.on('open', onOpen);

  conn.on('data', data => handleData(peerId, data));
  conn.on('close', () => peerLeft(peerId));
  conn.on('error', e => console.warn('conn err', peerId, e));
}

// ── DATA HANDLER ─────────────────────────────
function handleData(fromId, data) {
  switch(data.type) {
    case 'chat': {
      const p = peers.get(fromId);
      addChatMsg(p?.name || 'Peer', data.text, p?.color, p?.bg, data.time);
      break;
    }
    case 'speaking': {
      setPeerSpeaking(fromId, data.speaking);
      updateMicIcon(fromId, data.speaking);
      break;
    }
    case 'mic-muted': {
      const p = peers.get(fromId);
      if (p) p.muted = data.muted;
      updateMemberUI(fromId);
      break;
    }
    case 'peer-joined': {
      if (!isHost && data.id !== myId && !peers.has(data.id)) {
        const c = peer.connect(data.id, { metadata: { name: myName, type: 'guest' } });
        setupConn(c);
      }
      break;
    }
    case 'members': {
      data.members.forEach(m => {
        if (m.id !== myId && !peers.has(m.id)) {
          const c = peer.connect(m.id, { metadata: { name: myName, type: 'guest' } });
          setupConn(c);
        }
      });
      break;
    }
    case 'admin-kick': {
      toast('You were kicked by the admin', 5000);
      setTimeout(() => leaveRoom(), 1500);
      break;
    }
    case 'admin-mute': {
      if (data.muted && !micMuted) {
        forceMuteSelf();
        toast('Admin muted your microphone');
      }
      break;
    }
    case 'room-info':
      break; // handled upstream
  }
}

// ── PEER LEFT ─────────────────────────────────
function peerLeft(peerId) {
  const p = peers.get(peerId);
  const name = p?.name || 'Peer';
  peers.delete(peerId);
  outCalls.delete(peerId);
  removeMember(peerId);
  removeVideoTile(peerId + '-screen');
  removeVideoTile(peerId + '-cam');
  removeMicAudio(peerId);
  removeVoiceCard(peerId);
  addChatSystem(`${name} left`);
  updateMemberCount();
  updateEmptyState();
}

// ── ENTER ROOM UI ─────────────────────────────
function enterRoom() {
  $('landing').style.display = 'none';
  $('app').classList.add('active');
  $('tb-room').textContent = roomName;
  $('myNameDisplay').textContent = myName;
  $('myRoleDisplay').textContent = isAdmin ? '👑 Admin' : '';
  if (isAdmin) { $('adminBtn').style.display = 'flex'; }

  // Mobile chat btn
  if (window.innerWidth <= 900) $('mobileChatBtn').style.display = 'flex';

  // Add self to member list & voice grid
  const [fg,bg] = nextColor();
  addMemberUI(myId, myName, fg, bg, true);
  addVoiceCard(myId, myName, fg, bg, true);
  addChatSystem('You joined the room');
  updateMemberCount();
  updateEmptyState();

  // Update URL
  const url = new URL(window.location);
  url.searchParams.set('room', roomHostId || myId);
  url.searchParams.set('name', roomName);
  window.history.replaceState({}, '', url.toString());

  // Wake lock to keep screen/audio alive on mobile
  requestWakeLock();
}

// ── WAKE LOCK (mobile background audio) ───────
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        // Re-request on visibility change
        document.addEventListener('visibilitychange', reacquireWakeLock, { once: true });
      });
    }
  } catch(e) { /* not critical */ }
}

async function reacquireWakeLock() {
  if (document.visibilityState === 'visible' && peer && !peer.destroyed) {
    await requestWakeLock();
  }
}

// ── MIC ───────────────────────────────────────
async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }, video: false });

    setupLocalSpeakingDetection(micStream);

    // Call all connected peers with mic
    peers.forEach((_, peerId) => callPeer(peerId, micStream, 'mic'));

    updateMicBtn(false);
    return true;
  } catch(e) {
    if (e.name !== 'NotAllowedError') toast('Mic error: ' + e.message);
    updateMicBtn(false, true); // show as unavailable
    return false;
  }
}

async function toggleMic() {
  if (!micStream) {
    const ok = await startMic();
    if (!ok) return;
    return;
  }
  micMuted = !micMuted;
  micStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  updateMicBtn(micMuted);
  broadcast({ type: 'mic-muted', muted: micMuted });
  if (micMuted) setLocalSpeaking(false);
}

function forceMuteSelf() {
  micMuted = true;
  if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = false; });
  updateMicBtn(true);
  broadcast({ type: 'mic-muted', muted: true });
}

function updateMicBtn(muted, unavailable) {
  const btn = $('micBtn');
  const icon = $('micIcon');
  const label = $('micLabel');
  btn.className = 'cb' + (muted ? ' muted-act' : (unavailable ? '' : ' act'));
  icon.textContent = unavailable ? '🎙' : (muted ? '🔇' : '🎙');
  if (label) label.textContent = unavailable ? 'No Mic' : (muted ? 'Muted' : 'Mic');
}

// ── DEAFEN ────────────────────────────────────
function toggleDeafen() {
  deafened = !deafened;
  micAudioEls.forEach(audio => { audio.volume = deafened ? 0 : 1; });
  const btn = $('deafenBtn');
  const icon = $('deafenIcon');
  btn.className = 'cb' + (deafened ? ' muted-act' : '');
  icon.textContent = deafened ? '🔇' : '🔊';
  if (deafened) toast('Audio deafened');
  else toast('Audio restored');
}

// ── SCREEN SHARE ──────────────────────────────
async function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 30 },
        audio: false,
      });
      screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
      addVideoTile(myId, screenStream, myName, true, 'screen');
      peers.forEach((_, id) => callPeer(id, screenStream, 'screen'));
      $('screenBtn').classList.add('act');
      $('screenLabel').textContent = 'Stop';
      updateEmptyState();
    } catch(e) {
      if (e.name !== 'NotAllowedError') toast('Screen share error: ' + e.message);
    }
  }
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  removeVideoTile(myId + '-screen');
  outCalls.forEach(c => { try { c.screenCall?.close(); } catch(e){} });
  $('screenBtn').classList.remove('act');
  $('screenLabel').textContent = 'Screen';
  updateEmptyState();
}

// ── CAM ───────────────────────────────────────
async function toggleCam() {
  if (camStream) {
    stopCam();
  } else {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      addVideoTile(myId, camStream, myName, true, 'cam');
      peers.forEach((_, id) => callPeer(id, camStream, 'cam'));
      $('camBtn').classList.add('act');
      $('camLabel').textContent = 'Stop';
      updateEmptyState();
    } catch(e) {
      if (e.name !== 'NotAllowedError') toast('Camera error: ' + e.message);
    }
  }
}

function stopCam() {
  if (!camStream) return;
  camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  removeVideoTile(myId + '-cam');
  outCalls.forEach(c => { try { c.camCall?.close(); } catch(e){} });
  $('camBtn').classList.remove('act');
  $('camLabel').textContent = 'Cam';
  updateEmptyState();
}

// ── CALL PEER ─────────────────────────────────
function callPeer(peerId, stream, type) {
  if (!peer || peer.destroyed) return;
  try {
    const call = peer.call(peerId, stream, { metadata: { type, name: myName } });
    const existing = outCalls.get(peerId) || {};
    existing[type + 'Call'] = call;
    outCalls.set(peerId, existing);
    call.on('error', e => console.warn('outgoing call err', type, e));
  } catch(e) { console.warn('callPeer failed', e); }
}

// ── BROADCAST ─────────────────────────────────
function broadcast(data) {
  peers.forEach(({ conn }) => { try { conn.send(data); } catch(e){} });
}

function broadcastExcept(excludeId, data) {
  peers.forEach(({ conn }, id) => { if (id !== excludeId) try { conn.send(data); } catch(e){} });
}

// ── VIDEO TILES ───────────────────────────────
function addVideoTile(peerId, stream, name, isYou, type) {
  const tileId = peerId + '-' + type;
  if ($('tile-' + tileId)) return;
  $('emptyState').style.display = 'none';

  const tile = document.createElement('div');
  tile.className = 'vtile';
  tile.id = 'tile-' + tileId;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  if (isYou) video.muted = true;

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.innerHTML = `<span>${escHtml(name)}</span>${isYou ? '' : '<span id="mic-ind-'+peerId+'"></span>'}`;

  tile.appendChild(video);
  tile.appendChild(label);

  if (isAdmin && !isYou) {
    const crown = document.createElement('div');
    crown.className = 'tile-crown';
    crown.style.display = 'none';
    tile.appendChild(crown);
  }

  if (isYou && isAdmin) {
    const crown = document.createElement('div');
    crown.className = 'tile-crown';
    crown.textContent = '👑 Admin';
    tile.appendChild(crown);
  }

  $('videoGrid').appendChild(tile);
  updateEmptyState();
}

function removeVideoTile(tileKey) {
  const el = $('tile-' + tileKey);
  if (el) el.remove();
  updateEmptyState();
}

function updateEmptyState() {
  const grid = $('videoGrid');
  const hasVideos = grid && grid.querySelectorAll('.vtile').length > 0;
  const es = $('emptyState');
  if (es) es.style.display = hasVideos ? 'none' : 'flex';
}

// ── VOICE CARDS ───────────────────────────────
function addVoiceCard(id, name, fg, bg, isYou) {
  if (document.querySelector(`[data-voiceid="${id}"]`)) return;
  const card = document.createElement('div');
  card.className = 'voice-card';
  card.dataset.voiceid = id;
  card.innerHTML = `
    <div class="vc-avatar" style="background:${bg};color:${fg}">${name[0]?.toUpperCase()}</div>
    <div class="vc-name">${escHtml(name)}${isYou ? ' (you)' : ''}</div>
    <div class="vc-status"><span id="vc-mic-${id}">🎙 live</span></div>
  `;
  $('voiceGrid').appendChild(card);
}

function removeVoiceCard(id) {
  const el = document.querySelector(`[data-voiceid="${id}"]`);
  if (el) el.remove();
}

function updateMicIcon(peerId, speaking) {
  const el = $('mic-ind-' + peerId);
  if (el) el.textContent = speaking ? ' 🎙' : '';
}

// ── MEMBER LIST ───────────────────────────────
function addMemberUI(id, name, fg, bg, isYou) {
  if ($('member-' + id)) return;
  const el = document.createElement('div');
  el.className = 'mi';
  el.id = 'member-' + id;
  el.innerHTML = `
    <div class="mav" style="background:${bg};color:${fg}">
      ${name[0]?.toUpperCase()}
      <div class="mst mst-on" id="mst-${id}"></div>
    </div>
    <div class="minfo">
      <div class="mname">${escHtml(name)}${isYou ? ' <span style="color:var(--muted);font-size:.65rem">(you)</span>' : ''}${id === roomHostId ? ' <span style="color:var(--yellow);font-size:.65rem">👑</span>' : ''}</div>
      <div class="msub" id="msub-${id}">🎙 mic</div>
    </div>
    ${isAdmin && !isYou ? `<div class="mac"><button class="mab" title="Kick" onclick="adminKick('${id}')">🚫</button><button class="mab" title="Mute" onclick="adminMute('${id}')">🔇</button></div>` : ''}
  `;
  $('memberList').appendChild(el);
}

function removeMember(id) {
  $('member-' + id)?.remove();
}

function updateMemberUI(id) {
  const p = peers.get(id);
  if (!p) return;
  const sub = $('msub-' + id);
  if (sub) sub.textContent = p.muted ? '🔇 muted' : '🎙 mic';
}

function updateMemberCount() {
  $('memberCount').textContent = peers.size + 1;
}

// ── ADMIN ─────────────────────────────────────
function openAdmin() {
  const list = $('adminMemberList');
  list.innerHTML = '';
  peers.forEach((p, id) => {
    const div = document.createElement('div');
    div.className = 'am-item';
    div.innerHTML = `
      <div style="width:26px;height:26px;border-radius:6px;background:${p.bg};color:${p.color};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:700;font-size:.75rem">${p.name[0]?.toUpperCase()}</div>
      <div class="am-name">${escHtml(p.name)}</div>
      <div class="am-acts">
        <button class="bsm bmute" onclick="adminMute('${id}');closeAdmin()">🔇 Mute</button>
        <button class="bsm bkick" onclick="adminKick('${id}');closeAdmin()">🚫 Kick</button>
      </div>
    `;
    list.appendChild(div);
  });
  if (peers.size === 0) list.innerHTML = '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:20px">No other members</div>';
  $('adminModal').classList.add('open');
}

function closeAdmin() { $('adminModal').classList.remove('open'); }

function adminKick(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  try { p.conn.send({ type: 'admin-kick' }); } catch(e){}
  setTimeout(() => {
    try { p.conn.close(); } catch(e){}
    peerLeft(peerId);
  }, 500);
  toast(`Kicked ${p.name}`);
}

function adminMute(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  serverMuted.add(peerId);
  try { p.conn.send({ type: 'admin-mute', muted: true }); } catch(e){}
  toast(`Muted ${p.name}`);
}

// ── CHAT ──────────────────────────────────────
function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const time = Date.now();
  broadcast({ type: 'chat', text, time });
  const [fg,bg] = [$('myNameDisplay').style.color || '#7c6af7', ''];
  addChatMsg(myName, text, '#7c6af7', null, time);
}

function addChatMsg(name, text, color, bg, time) {
  const container = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'cm';
  const t = time ? new Date(time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
  el.innerHTML = `
    <div class="cav" style="background:${bg||'rgba(124,106,247,.15)'};color:${color||'#7c6af7'}">${name[0]?.toUpperCase()}</div>
    <div class="cbody">
      <div class="cmeta"><span class="cname" style="color:${color||'#7c6af7'}">${escHtml(name)}</span><span class="ctime">${t}</span></div>
      <div class="ctext">${escHtml(text)}</div>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function addChatSystem(text) {
  const container = $('chatMessages');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'cm sys';
  el.innerHTML = `<div class="cav">ℹ</div><div class="cbody"><div class="ctext">— ${escHtml(text)}</div></div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// ── LEAVE ROOM ────────────────────────────────
function leaveRoom() {
  stopScreenShare();
  stopCam();
  if (micStream) { micStream.getTracks().forEach(t=>t.stop()); micStream = null; }
  micAudioEls.forEach(a => { a.srcObject=null; a.remove(); });
  micAudioEls.clear();
  peers.forEach(({conn}) => { try { conn.close(); } catch(e){} });
  peers.clear();
  outCalls.clear();
  if (peer) { peer.destroy(); peer = null; }
  if (wakeLock) { try { wakeLock.release(); } catch(e){} wakeLock = null; }
  if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; analyser = null; }

  // Reset UI
  $('memberList').innerHTML = '';
  $('chatMessages').innerHTML = '';
  $('videoGrid').innerHTML = '';
  $('voiceGrid').innerHTML = '';
  $('adminBtn').style.display = 'none';
  isHost = false; isAdmin = false; _ci = 0;
  serverMuted.clear();

  $('app').classList.remove('active');
  $('landing').style.display = 'flex';
  window.history.replaceState({}, '', window.location.pathname);
  setStatus(false,'disconnected');
  updateEmptyState();
}

// ── VIEWS ─────────────────────────────────────
function setView(view, btn) {
  currentView = view;
  document.querySelectorAll('.vt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const vg = $('videoGrid');
  const vcg = $('voiceGrid');
  if (view === 'video') {
    vg.style.display = 'grid';
    vcg.style.display = 'none';
  } else {
    vg.style.display = 'none';
    vcg.style.display = 'grid';
  }
}

// ── INVITE LINK ───────────────────────────────
function copyInviteLink() {
  const url = new URL(window.location);
  url.searchParams.set('room', roomHostId || myId);
  url.searchParams.set('name', roomName);
  navigator.clipboard.writeText(url.toString())
    .then(() => toast('Invite link copied! 🔗'))
    .catch(() => toast('Copy the URL from your address bar'));
}

// ── MOBILE CHAT ───────────────────────────────
function toggleMobileChat() {
  $('chatPanel').classList.toggle('mob-open');
}

// ── UTILS ─────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── AUTO-JOIN FROM URL ────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const p = new URLSearchParams(window.location.search);
  const room = p.get('room');
  if (room) {
    $('joinCode').value = room;
    toast('Room code filled — enter your name and join!');
  }
});

// ── KEEP AUDIO ALIVE ON MOBILE (visibility change) ──
document.addEventListener('visibilitychange', () => {
  // Resume AudioContext if browser suspended it
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  // Re-play any audio elements that got paused
  micAudioEls.forEach(a => {
    if (a.paused) a.play().catch(() => {});
  });
});
