// public/app.js - more robust client (create/join, safer signaling, lazy media, cleanup)

// configuration
const wsProtocol = (location.protocol === 'https:') ? 'wss:' : 'ws:';
const SIGNAL_URL = wsProtocol + '//' + location.host;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// state
let ws = null;
let wsOpenPromise = null;
let myId = null;
let roomId = null;
let displayName = null;

let localStream = null; // set when the user allows mic/camera
const peers = {}; // peerId -> { id, name, added, inCall, pc, dc }

// helpers for DOM
const $ = id => document.getElementById(id);

// ---------------- WebSocket helpers ----------------
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return wsOpenPromise;
  }

  ws = new WebSocket(SIGNAL_URL);

  wsOpenPromise = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      console.log('ws open');
      resolve();
    });

    ws.addEventListener('message', ev => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(data);
    });

    ws.addEventListener('close', () => {
      console.log('ws closed');
      // clean UI if room was open
    });

    ws.addEventListener('error', (e) => {
      console.warn('ws error', e);
    });
  });

  return wsOpenPromise;
}

async function wsSend(obj) {
  await connectWS();
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { console.warn('ws send failed', e); }
  } else {
    throw new Error('WebSocket not open');
  }
}

// ----------------- Media helpers ------------------
function isValidRoomName(name) {
  if (!name) return false;
  return /^[\w\- ]{1,64}$/.test(name.trim());
}

async function ensureLocalStream(preferVideo = true) {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: preferVideo });
    return localStream;
  } catch (err) {
    if (preferVideo) {
      // try audio only fallback
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return localStream;
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}

function stopLocalStream() {
  if (!localStream) return;
  try {
    localStream.getTracks().forEach(t => t.stop());
  } catch (e) {}
  localStream = null;
  const preview = document.getElementById('local-media-me');
  if (preview && preview.parentNode) preview.parentNode.removeChild(preview);
}

// ------------------ Peer connection lifecycle ------------------
function makePeerEntry(id, name) {
  if (!peers[id]) {
    peers[id] = { id, name: name || 'anon', added: false, inCall: false, pc: null, dc: null };
  } else {
    peers[id].name = name || peers[id].name;
  }
}

function ensurePeerConnection(id) {
  makePeerEntry(id);
  if (peers[id].pc && peers[id].pc.connectionState !== 'closed') return peers[id].pc;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[id].pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({ type: 'signal', roomId, payload: { to: id, data: { cand: e.candidate } } }).catch(()=>{});
    }
  };

  pc.ontrack = (e) => {
    // show incoming media
    attachRemoteStream(id, e.streams[0]);
    peers[id].inCall = true;
    updatePeersUI();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      // free remote media
      removeRemoteMediaForPeer(id);
      peers[id].inCall = false;
      // keep peers[id] so we can reinit connection later
      updatePeersUI();
    }
  };

  pc.ondatachannel = (ev) => {
    setupDataChannel(id, ev.channel);
  };

  return pc;
}

function setupDataChannel(id, dc) {
  makePeerEntry(id);
  if (peers[id].dc && peers[id].dc.readyState !== 'closed') return; // already set
  peers[id].dc = dc;
  dc.onopen = () => console.log('dc open', id);
  dc.onmessage = (e) => appendChat(`${peers[id].name}: ${e.data}`);
  dc.onclose = () => console.log('dc closed', id);
}

// attach / remove remote media
function attachRemoteStream(peerId, stream) {
  removeRemoteMediaForPeer(peerId); // ensure single element
  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().length > 0;
  const container = $('remoteAudioContainer') || createRemoteContainer();
  if (hasVideo) {
    const v = document.createElement('video');
    v.id = `remote-media-${peerId}`;
    v.autoplay = true;
    v.playsInline = true;
    v.srcObject = stream;
    v.style.maxWidth = '240px';
    v.style.margin = '6px';
    container.appendChild(v);
  } else {
    const a = document.createElement('audio');
    a.id = `remote-media-${peerId}`;
    a.autoplay = true;
    a.srcObject = stream;
    container.appendChild(a);
  }
}

function removeRemoteMediaForPeer(peerId) {
  const el = document.getElementById(`remote-media-${peerId}`);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function createRemoteContainer() {
  const c = document.createElement('div');
  c.id = 'remoteAudioContainer';
  document.body.appendChild(c);
  return c;
}

// cleanup and reset helpers
function cleanupPeerResources(peerId) {
  if (!peers[peerId]) return;
  try { peers[peerId].pc && peers[peerId].pc.close(); } catch (e) {}
  removeRemoteMediaForPeer(peerId);
  peers[peerId].pc = null;
  peers[peerId].dc = null;
  peers[peerId].inCall = false;
}

function removePeerCompletely(peerId) {
  cleanupPeerResources(peerId);
  delete peers[peerId];
  updatePeersUI();
}

function cleanupAllPeers() {
  for (const id of Object.keys(peers)) {
    cleanupPeerResources(id);
  }
}

// ------------------ Signaling message handling from server ------------------
function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'room-error') {
    $('error').textContent = msg.message || 'Room error';
    $('setup').style.display = 'block';
    $('app').style.display = 'none';
    return;
  }

  if (msg.type === 'joined') {
    // join successful
    myId = msg.id;
    $('myId').textContent = myId;
    // create peer entries for existing peers; deterministic initiator: myId < peerId
    for (const p of msg.peers || []) {
      makePeerEntry(p.id, p.name);
      // don't auto-offer; we'll negotiate when user starts call. But to enable text chat we must decide offerer.
      // We'll decide: if myId < p.id => we become initiator for data channel now (create offer).
      if (myId < p.id) {
        // online-initiated small negotiation to get datachannel ready for chat
        (async () => {
          const pc = ensurePeerConnection(p.id);
          // create datachannel if not present
          if (!peers[p.id].dc) {
            const dc = pc.createDataChannel('chat');
            setupDataChannel(p.id, dc);
          }
          // don't add local media until user starts call; but some browsers require track transceivers for audio-only senders; we'll not add tracks here.
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            wsSend({ type: 'signal', roomId, payload: { to: p.id, data: { sdp: pc.localDescription } } }).catch(()=>{});
          } catch (e) { console.warn('offer failed', e); }
        })();
      }
    }
    updatePeersUI();
    return;
  }

  if (msg.type === 'new-peer') {
    makePeerEntry(msg.id, msg.name);
    // new-peer: deterministic initiator rule
    if (myId && myId < msg.id) {
      (async () => {
        const pc = ensurePeerConnection(msg.id);
        if (!peers[msg.id].dc) {
          const dc = pc.createDataChannel('chat');
          setupDataChannel(msg.id, dc);
        }
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          wsSend({ type: 'signal', roomId, payload: { to: msg.id, data: { sdp: pc.localDescription } } }).catch(()=>{});
        } catch (e) { console.warn('new-peer offer failed', e); }
      })();
    }
    updatePeersUI();
    return;
  }

  if (msg.type === 'peer-left') {
    // tidy up
    removePeerCompletely(msg.id);
    return;
  }

  if (msg.type === 'signal') {
    const from = msg.from;
    const data = msg.data || {};
    // handle call-left notification
    if (data.callLeft) {
      // remote left call: cleanup their remote media and mark them not inCall
      removeRemoteMediaForPeer(from);
      if (peers[from]) peers[from].inCall = false;
      updatePeersUI();
      return;
    }
    // ensure we have pc
    const pc = ensurePeerConnection(from);
    if (data.sdp) {
      const sdp = data.sdp;
      (async () => {
        try {
          // If offer: ensure local tracks are added only if user is starting call or if we want to answer with our mic
          if (sdp.type === 'offer') {
            // attach local audio/video before creating answer - prompt user if needed
            const stream = await ensureLocalStream(true).catch(()=>null);
            if (stream) {
              // add tracks only once
              const existingKinds = pc.getSenders().map(s => s.track && s.track.kind).filter(Boolean);
              stream.getTracks().forEach(track => {
                if (!existingKinds.includes(track.kind)) pc.addTrack(track, stream);
              });
            }
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            wsSend({ type: 'signal', roomId, payload: { to: from, data: { sdp: pc.localDescription } } }).catch(()=>{});
          } else if (sdp.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          } else {
            // other SDP types
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          }
        } catch (e) {
          console.warn('sdp handling failed', e);
        }
      })();
    } else if (data.cand) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.cand));
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
    }
    return;
  }

  if (msg.type === 'signal-error') {
    console.warn('signal error from server:', msg.message);
    return;
  }

  if (msg.type === 'rooms') {
    // optional admin list
    console.log('open rooms', msg.list);
    return;
  }

  // unknown message types are ignored
}

// ------------------ UI & user actions ------------------
function updatePeersUI() {
  const list = $('peersList');
  if (!list) return;
  list.innerHTML = '';
  for (const id of Object.keys(peers)) {
    const p = peers[id];
    const li = document.createElement('li');
    li.textContent = `${p.name} (${id})`;
    const addBtn = document.createElement('button');
    addBtn.textContent = p.added ? 'Added' : 'Add';
    addBtn.disabled = p.added;
    addBtn.onclick = () => {
      p.added = true;
      updatePeersUI();
    };
    li.appendChild(addBtn);

    const status = document.createElement('span');
    status.style.marginLeft = '8px';
    status.textContent = p.inCall ? ' (in call)' : '';
    li.appendChild(status);

    list.appendChild(li);
  }
}

function appendChat(text) {
  const el = document.createElement('div'); el.textContent = text;
  const chat = $('chat');
  if (!chat) return;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

// create/join handlers
async function joinRoom(mode) {
  $('error').textContent = '';
  const nameInput = $('name').value.trim();
  const roomInput = $('room').value.trim();
  if (!roomInput) { $('error').textContent = 'Enter a room name'; return; }
  if (!isValidRoomName(roomInput)) { $('error').textContent = 'Invalid room name'; return; }

  displayName = nameInput || ('anon' + Math.random().toString(36).slice(2, 6));
  roomId = roomInput;
  $('roomLabel').textContent = roomId;

  // show UI
  $('setup').style.display = 'none';
  $('app').style.display = 'block';

  try {
    await connectWS();
    await wsSend({ type: mode, roomId, payload: { name: displayName } });
    // now wait for server to respond with joined or room-error (handlers will update UI)
  } catch (e) {
    $('error').textContent = 'Could not connect to server';
    $('setup').style.display = 'block';
    $('app').style.display = 'none';
    console.warn(e);
  }
}

// buttons
$('createBtn') && $('createBtn').addEventListener('click', () => joinRoom('create-room'));
$('joinBtn') && $('joinBtn').addEventListener('click', () => joinRoom('join-room'));

$('leaveBtn') && $('leaveBtn').addEventListener('click', async () => {
  try { await wsSend({ type: 'leave' }); } catch (e) {}
  // cleanup UI and state
  stopLocalStream();
  cleanupAllPeers();
  if (ws) try { ws.close(); } catch (e) {}
  ws = null;
  wsOpenPromise = null;
  myId = null;
  roomId = null;
  $('setup').style.display = 'block';
  $('app').style.display = 'none';
  $('myId').textContent = '';
  $('roomLabel').textContent = '';
  $('error').textContent = '';
});

$('sendMsgBtn') && $('sendMsgBtn').addEventListener('click', () => {
  const text = $('msg').value.trim();
  if (!text) return;
  appendChat('Me: ' + text);
  $('msg').value = '';
  for (const id of Object.keys(peers)) {
    const p = peers[id];
    if (!p.added) continue;
    if (p.dc && p.dc.readyState === 'open') {
      try { p.dc.send(text); } catch (e) {}
    }
  }
});

$('addBtn') && $('addBtn').addEventListener('click', () => {
  const name = $('addName').value.trim();
  if (!name) return;
  $('addName').value = '';
  // add first matching peer by name
  for (const id of Object.keys(peers)) {
    if (peers[id].name === name) {
      peers[id].added = true;
      updatePeersUI();
      return;
    }
  }
  $('error').textContent = 'No peer with that name found in room';
});

// Start call: negotiate with each added peer, request mic/cam lazily
$('startCallBtn') && $('startCallBtn').addEventListener('click', async () => {
  const stream = await ensureLocalStream(true);
  if (!stream) {
    alert('Microphone access required for call (camera optional)');
    return;
  }

  // show local preview
  const localContainer = $('localAudioContainer') || createLocalContainer();
  const existing = document.getElementById('local-media-me');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().length > 0;
  if (hasVideo) {
    const v = document.createElement('video');
    v.id = 'local-media-me'; v.autoplay = true; v.playsInline = true; v.muted = true; v.srcObject = stream;
    v.style.maxWidth = '240px'; v.style.margin = '6px';
    localContainer.appendChild(v);
  } else {
    const a = document.createElement('audio');
    a.id = 'local-media-me'; a.autoplay = true; a.muted = true; a.srcObject = stream;
    localContainer.appendChild(a);
  }

  // negotiate with each added peer
  for (const id of Object.keys(peers)) {
    const p = peers[id];
    if (!p.added) continue;
    const pc = ensurePeerConnection(id);
    // create datachannel if missing and we are DETERMINISTIC initiator
    if (!p.dc && myId && myId < id) {
      const dc = pc.createDataChannel('chat');
      setupDataChannel(id, dc);
    }
    // ensure local tracks added to pc
    const existingKinds = pc.getSenders().map(s => s.track && s.track.kind).filter(Boolean);
    stream.getTracks().forEach(track => {
      if (!existingKinds.includes(track.kind)) pc.addTrack(track, stream);
    });
    // create and send offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await wsSend({ type: 'signal', roomId, payload: { to: id, data: { sdp: pc.localDescription } } });
      p.inCall = true;
    } catch (e) {
      console.warn('offer error', e);
    }
  }

  $('hangupBtn').disabled = false;
});

function createLocalContainer() {
  const c = document.createElement('div');
  c.id = 'localAudioContainer';
  document.body.appendChild(c);
  return c;
}

// Hang up from call (don't leave room): notify peers and close pc resources for added peers
$('hangupBtn') && $('hangupBtn').addEventListener('click', async () => {
  // tell peers we left the call
  for (const id of Object.keys(peers)) {
    if (!peers[id].added) continue;
    try {
      await wsSend({ type: 'signal', roomId, payload: { to: id, data: { callLeft: true } } });
    } catch (e) {}
    // close connection resources but keep peer entry to allow re-negotiation later
    if (peers[id].pc) {
      try { peers[id].pc.close(); } catch (e) {}
      peers[id].pc = null;
      peers[id].dc = null;
      peers[id].inCall = false;
    }
    removeRemoteMediaForPeer(id);
  }
  stopLocalStream();
  $('hangupBtn').disabled = true;
  updatePeersUI();
});

// utility to clean everything if server tells us peer disconnected fully
window.addEventListener('beforeunload', () => {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' })); } catch (e) {}
});

// ------------------ small initialization ------------------
(function init() {
  // make sure UI elements exist
  if ($('setup')) $('setup').style.display = 'block';
})();

