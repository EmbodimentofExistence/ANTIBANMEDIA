const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // { roomName: Set<ws> }

// Helper: send JSON to a client
function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

// Broadcast to all clients in a room except sender
function broadcast(roomName, sender, obj) {
  if (!rooms[roomName]) return;
  rooms[roomName].forEach(client => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      send(client, obj);
    }
  });
}

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "anon";
  ws.roomId = null;

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    // CREATE ROOM
    if (data.type === "create-room") {
      const room = data.roomId;
      ws.name = (data.payload && data.payload.name) || "anon";

      if (rooms[room] && rooms[room].size > 0) {
        return send(ws, { type: "room-error", message: "Room already exists" });
      }

      rooms[room] = new Set([ws]);
      ws.roomId = room;
      send(ws, { type: "joined", id: ws.id, peers: [] });
    }

    // JOIN ROOM
    else if (data.type === "join-room") {
      const room = data.roomId;
      ws.name = (data.payload && data.payload.name) || "anon";

      if (!rooms[room] || rooms[room].size === 0) {
        return send(ws, { type: "room-error", message: "Room does not exist" });
      }

      ws.roomId = room;
      rooms[room].add(ws);

      const peers = [...rooms[room]].filter(c => c !== ws).map(c => ({ id: c.id, name: c.name }));
      send(ws, { type: "joined", id: ws.id, peers });

      broadcast(room, ws, { type: "new-peer", id: ws.id, name: ws.name });
    }

    // SIGNALING (WebRTC)
    else if (data.type === "signal" && ws.roomId) {
      const targetId = data.to;
      const target = [...rooms[ws.roomId]].find(c => c.id === targetId);
      if (target) send(target, { type: "signal", from: ws.id, signal: data.signal });
    }

    // CHAT MESSAGE
    else if (data.type === "message" && ws.roomId) {
      broadcast(ws.roomId, ws, { type: "message", from: ws.name, text: data.text });
    }
  });

  ws.on("close", () => {
    if (ws.roomId && rooms[ws.roomId]) {
      rooms[ws.roomId].delete(ws);
      broadcast(ws.roomId, ws, { type: "peer-left", id: ws.id });

      // delete room if empty
      if (rooms[ws.roomId].size === 0) delete rooms[ws.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


