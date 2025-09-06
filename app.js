const SIGNAL_URL = "wss://antibanmedia.onrender.com"; // your Render server

let ws;
let myId;
let room;
let peers = {};
let localStream;

const setupDiv = document.getElementById("setup");
const appDiv = document.getElementById("app");
const roomLabel = document.getElementById("roomLabel");
const myIdLabel = document.getElementById("myId");
const leaveBtn = document.getElementById("leaveBtn");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const nameInput = document.getElementById("name");
const roomInput = document.getElementById("room");
const errorDiv = document.getElementById("error");

const msgBox = document.getElementById("msgBox");
const sendBtn = document.getElementById("sendBtn");
const messagesDiv = document.getElementById("messages");
const peerList = document.getElementById("peerList");
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");

// Initialize media
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error("Failed to get local media", err);
  }
}

// WebSocket setup
function connectWS() {
  ws = new WebSocket(SIGNAL_URL);

  ws.onopen = () => console.log("Connected to signaling server");

  ws.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);

    switch(data.type) {
      case "joined":
        myId = data.id;
        myIdLabel.textContent = myId;
        peers = {};
        data.peers.forEach(p => addPeer(p.id, p.name));
        break;

      case "new-peer":
        addPeer(data.id, data.name);
        break;

      case "peer-left":
        removePeer(data.id);
        break;

      case "signal":
        await handleSignal(data.from, data.signal);
        break;

      case "message":
        addMessage(data.from, data.text);
        break;

      case "room-error":
        showError(data.message);
        break;
    }
  };

  ws.onclose = () => console.log("Disconnected from signaling server");
}

// Peer management
function addPeer(id, name) {
  if (peers[id]) return;
  const pc = new RTCPeerConnection();
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = e => {
    let vid = document.getElementById("vid-" + id);
    if (!vid) {
      vid = document.createElement("video");
      vid.id = "vid-" + id;
      vid.autoplay = true;
      vid.playsInline = true;
      remoteVideos.appendChild(vid);
    }
    vid.srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "signal", to: id, signal: { candidate: e.candidate } }));
    }
  };

  peers[id] = { pc, name };
  updatePeerList();
}

function removePeer(id) {
  if (peers[id]) {
    peers[id].pc.close();
    delete peers[id];
    const vid = document.getElementById("vid-" + id);
    if (vid) remoteVideos.removeChild(vid);
    updatePeerList();
  }
}

function updatePeerList() {
  peerList.innerHTML = "";
  Object.entries(peers).forEach(([id, p]) => {
    const li = document.createElement("li");
    li.textContent = `${p.name} (${id})`;
    peerList.appendChild(li);
  });
}

// Messaging
sendBtn.onclick = () => {
  const text = msgBox.value.trim();
  if (!text) return;
  addMessage("Me", text);
  ws.send(JSON.stringify({ type: "message", text }));
  msgBox.value = "";
};

function addMessage(sender, text) {
  const div = document.createElement("div");
  div.textContent = `${sender}: ${text}`;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Create / Join Room
createBtn.onclick = () => joinOrCreateRoom("create");
joinBtn.onclick = () => joinOrCreateRoom("join");

function joinOrCreateRoom(action) {
  const name = nameInput.value.trim() || "anon";
  const r = roomInput.value.trim();
  if (!r) return showError("Room name required");

  room = r;
  roomLabel.textContent = room;
  setupDiv.style.display = "none";
  appDiv.style.display = "block";

  connectWS();
  initMedia();

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: action + "-room", roomId: room, payload: { name } }));
  };
}

// Leave Room
leaveBtn.onclick = () => {
  ws.close();
  Object.keys(peers).forEach(id => removePeer(id));
  peers = {};
  room = null;
  setupDiv.style.display = "block";
  appDiv.style.display = "none";
  remoteVideos.innerHTML = "";
  messagesDiv.innerHTML = "";
  myIdLabel.textContent = "";
  errorDiv.textContent = "";
};

// Error display
function showError(msg) {
  errorDiv.textContent = msg;
}

// Signaling for WebRTC
async function handleSignal(from, signal) {
  const pc = peers[from].pc;

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "signal", to: from, signal: { sdp: pc.localDescription } }));
    }
  } else if (signal.candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }
}


