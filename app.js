// public/app.js - WebSocket signaling + WebRTC (video + datachannel) client
const wsProtocol = (location.protocol === 'https:') ? 'wss:' : 'ws:';
const SIGNAL_URL = wsProtocol + '//' + location.host; // same host

let ws;
let myId = null;
let roomId = null;
let displayName = null;

// peers: peerId -> { pc, dc, name, added, inCall }
const peers = {};
const addedNames = new Set();

// Try to get audio+video; if user denies video it will still resolve with audio only if allowed
const localStreamPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  .catch(async (err) => {
    // Try audio-only fallback
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return null;
    }
  });

function $(id) { return document.getElementById(id); }

function connectWS() {
  ws = new WebSocket(SIGNAL_URL);
  ws.addEventListener('open', () => console.log('ws open'));
  ws.addEventListener('message', ev => {
    const data = JSON.parse(ev.data);
    handleSignal(data);
  });
  ws.addEventListener('close', () => console.log('ws closed'));
}

function handleSignal(msg) {
  const { type } = msg;
  if (type === 'joined') {
    myId = msg.id;
    $('myId').textContent = myId;
    for (const p of msg.peers) createPeer(p.id, p.name, false);
    updatePeersUI();
  } else if (type === 'new-peer') {
    createPeer(msg.id, msg.name, true);
    updatePeersUI();
  } else if (type === 'signal') {
    const from = msg.from;
    if (!peers[from]) createPeer(from, msg.name || 'anon', false);
    const pc = peers[from].pc;
    const data = msg.data;

    // signalling for call-left notifications forwarded as 'callLeft' boolean
    if (data && data.callLeft) {
      // remote ended the call — remove their media element and mark not in-call
      removeRemoteMediaForPeer(from);
      peers[from].inCall = false;
      return;
    }

    if (data.sdp) {
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(async () => {
        if (data.sdp.type === 'offer') {
          // attach local stream tracks (if available) before answering
          const stream = await localStreamPromise;
          if (stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: 'signal', roomId, payload: { to: from, data: { sdp: pc.localDescription } } }));
        }
      }).catch(console.error);
    } else if (data.cand) {
      pc.addIceCandidate(new RTCIceCandidate(data.cand)).catch(()=>{});
    }
  } else if (type === 'peer-left') {
    if (peers[msg.id]) {
      // someone disconnected completely
      cleanupPeer(msg.id);
      updatePeersUI();
    }
  } else if (type === 'rename') {
    if (peers[msg.id]) { peers[msg.id].name = msg.name; updatePeersUI(); }
  }
}

function createPeer(id, name, shouldOffer) {
  if (peers[id]) return;
  const pc = new RTCPeerConnection();
  const obj = { pc, dc: null, name: name || 'anon', id, added: false, inCall: false };
  peers[id] = obj;

  pc.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'signal', roomId, payload: { to: id, data: { cand: e.candidate } } }));
    }
  };

  pc.ontrack = e => {
    // remote stream -> show as video if it has video tracks, otherwise audio element
    attachRemoteStream(id, e.streams[0]);
    peers[id].inCall = true;
  };

  // data channel for chat
  if (shouldOffer) {
    const dc = pc.createDataChannel('chat');
    setupDataChannel(id, dc);
  } else {
    pc.ondatachannel = e => setupDataChannel(id, e.channel);
  }

  // add local tracks (if available) for future negotiations
  localStreamPromise.then(stream => {
    if (stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));
  }).catch(()=>{});

  async function doOffer() {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'signal', roomId, payload: { to: id, data: { sdp: pc.localDescription } } }));
    } catch (e) {
      console.error('offer failed', e);
    }
  }

  if (shouldOffer) doOffer();
}

function setupDataChannel(id, dc) {
  peers[id].dc = dc;
  dc.onopen = () => console.log('dc open', id);
  dc.onmessage = e => appendChat(peers[id].name + ': ' + e.data);
}

function appendChat(text) {
  const el = document.createElement('div'); el.textContent = text; $('chat').appendChild(el); $('chat').scrollTop = $('chat').scrollHeight;
}

function updatePeersUI() {
  const list = $('peersList'); list.innerHTML = '';
  for (const id in peers) {
    const li = document.createElement('li');
    li.textContent = `${peers[id].name} (${id}) `;
    const addBtn = document.createElement('button'); addBtn.textContent = peers[id].added ? 'Added' : 'Add';
    addBtn.disabled = peers[id].added;
    addBtn.onclick = () => { peers[id].added = true; addedNames.add(peers[id].name); updatePeersUI(); };
    li.appendChild(addBtn);

    // show quick call status
    const status = document.createElement('span');
    status.style.marginLeft = '8px';
    status.textContent = peers[id].inCall ? ' (in call)' : '';
    li.appendChild(status);

    list.appendChild(li);
  }
}

// Helpers to attach/remove remote media
function attachRemoteStream(peerId, stream) {
  // prefer a video element if stream has video tracks
  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().length > 0;
  let container = $('remoteAudioContainer');
  if (!container) {
    // create container if user changed HTML structure
    container = document.createElement('div'); container.id = 'remoteAudioContainer'; document.body.appendChild(container);
  }

  // remove existing element if any
  removeRemoteMediaForPeer(peerId);

  if (hasVideo) {
    const video = document.createElement('video');
    video.id = `remote-media-${peerId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    video.srcObject = stream;
    video.style.maxWidth = '240px';
    video.style.margin = '6px';
    container.appendChild(video);
  } else {
    const audio = document.createElement('audio');
    audio.id = `remote-media-${peerId}`;
    audio.autoplay = true;
    audio.srcObject = stream;
    container.appendChild(audio);
  }
}

function removeRemoteMediaForPeer(peerId) {
  const el = document.getElementById(`remote-media-${peerId}`);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function cleanupPeer(id) {
  try { peers[id].pc && peers[id].pc.close(); } catch(e){}
  removeRemoteMediaForPeer(id);
  delete peers[id];
}

// UI bindings

$('joinBtn').addEventListener('click', () => {
  displayName = $('name').value.trim() || ('anon' + Math.random().toString(36).slice(2, 6));
  roomId = $('room').value.trim() || 'default';
  $('roomLabel').textContent = roomId;
  $('setup').style.display = 'none';
  $('app').style.display = 'block';
  if (!ws) connectWS();
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', roomId, payload: { name: displayName } })));
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'join', roomId, payload: { name: displayName } }));
});

$('leaveBtn').addEventListener('click', () => { ws.send(JSON.stringify({ type: 'leave' })); window.location.reload(); });

$('sendMsgBtn').addEventListener('click', () => {
  const text = $('msg').value.trim(); if (!text) return; $('msg').value = '';
  appendChat('Me: ' + text);
  for (const id in peers) if (peers[id].added && peers[id].dc && peers[id].dc.readyState === 'open') peers[id].dc.send(text);
});

$('addBtn').addEventListener('click', () => {
  const name = $('addName').value.trim(); if (!name) return; $('addName').value = '';
  for (const id in peers) if (peers[id].name === name) { peers[id].added = true; addedNames.add(name); }
  updatePeersUI();
});

// Start Call -> negotiates with each "added" peer
$('startCallBtn').addEventListener('click', async () => {
  const stream = await localStreamPromise;
  if (!stream) {
    alert('Microphone (and optionally camera) access required for call');
    return;
  }

  // Show local preview in localAudioContainer (reuse existing container)
  let localContainer = $('localAudioContainer');
  if (!localContainer) {
    localContainer = document.createElement('div'); localContainer.id = 'localAudioContainer'; document.body.appendChild(localContainer);
  }
  // remove previous local preview
  const existing = document.getElementById('local-media-me');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().length > 0;
  if (hasVideo) {
    const v = document.createElement('video');
    v.id = 'local-media-me';
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true; // mute local preview
    v.srcObject = stream;
    v.style.maxWidth = '240px';
    v.style.margin = '6px';
    localContainer.appendChild(v);
  } else {
    const a = document.createElement('audio');
    a.id = 'local-media-me';
    a.autoplay = true;
    a.muted = true;
    a.srcObject = stream;
    localContainer.appendChild(a);
  }

  // Ensure every added peer has a peer connection; create offer to each
  for (const id in peers) if (peers[id].added) {
    // If pc exists, restart negotiation by creating an offer
    const pc = peers[id].pc;
    try {
      // ensure local tracks are present on the RTCPeerConnection (for browsers that require transceivers)
      try {
        const existingSenders = pc.getSenders();
        const tracks = stream.getTracks();
        tracks.forEach(track => {
          // if no sender for this track kind, addTrack
          if (!existingSenders.some(s => s.track && s.track.kind === track.kind)) {
            pc.addTrack(track, stream);
          }
        });
      } catch (e) { /* ignore sender issues */ }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'signal', roomId, payload: { to: id, data: { sdp: pc.localDescription } } }));
      peers[id].inCall = true;
    } catch (e) { console.error(e); }
  }

  $('hangupBtn').disabled = false;
});

// Hang up / Leave Call (stops local tracks, closes pc for called peers, not entire session)
$('hangupBtn').addEventListener('click', async () => {
  const stream = await localStreamPromise.catch(()=>null);
  // Stop local tracks & remove preview
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  const localPreview = document.getElementById('local-media-me');
  if (localPreview && localPreview.parentNode) localPreview.parentNode.removeChild(localPreview);

  // Notify each added peer that we left the call (send a signal payload with callLeft=true)
  for (const id in peers) {
    if (!peers[id].added) continue;
    try {
      // inform them (the server will forward)
      ws.send(JSON.stringify({ type: 'signal', roomId, payload: { to: id, data: { callLeft: true } } }));
    } catch (e) { console.warn('notify fail', e); }
    // close their RTCPeerConnection to free resources
    try { peers[id].pc && peers[id].pc.close(); } catch (e) {}
    peers[id].inCall = false;
    // remove their remote media element
    removeRemoteMediaForPeer(id);
  }
  // disable hangup until next call
  $('hangupBtn').disabled = true;
  updatePeersUI();
});

// Tidy up peer on full disconnect
window.addEventListener('beforeunload', () => {
  try { ws && ws.close(); } catch (e) {}
});

// Utility to remove peer resource (called when someone leaves)
function removePeerById(peerId) {
  if (peers[peerId]) {
    try { peers[peerId].pc && peers[peerId].pc.close(); } catch (e) {}
    removeRemoteMediaForPeer(peerId);
    delete peers[peerId];
    updatePeersUI();
  }
}
