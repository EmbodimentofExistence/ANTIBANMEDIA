const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // roomName -> Set of sockets

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

wss.on("connection", ws => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "anon";
  ws.roomId = null;

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "create-room") {
      const room = data.roomId;
      ws.name = (data.payload && data.payload.name) || "anon";

      if (rooms[room] && rooms[room].size > 0) {
        // Room already exists
        send(ws, { type: "room-error", message: "Room already exists" });
        return;
      }

      // Create new room
      rooms[room] = new Set([ws]);
      ws.roomId = room;
      send(ws, { type: "joined", id: ws.id, peers: [] });
    }

    if (data.type === "join-room") {
      const room = data.roomId;
      ws.name = (data.payload && data.payload.name) || "anon";

      if (!rooms[room] || rooms[room].size === 0) {
        send(ws, { type: "room-error", message: "Room does not exist" });
        return;
      }

      ws.roomId = room;
      rooms[room].add(ws);

      const peers = [...rooms[room]].filter(c => c !== ws).map(c => ({ id: c.id, name: c.name }));
      send(ws, { type: "joined", id: ws.id, peers });
      rooms[room].forEach(c => {
        if (c !== ws) send(c, { type: "new-peer", id: ws.id, name: ws.name });
      });
    }

    if (data.type === "leave") {
      leaveRoom(ws);
      ws.close();
    }

    if (data.type === "signal") {
      const { to, data: payload } = data.payload;
      for (const client of rooms[ws.roomId] || []) {
        if (client.id === to) {
          send(client, { type: "signal", from: ws.id, name: ws.name, data: payload });
        }
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms[ws.roomId];
  if (!room) return;

  room.delete(ws);
  room.forEach(c => send(c, { type: "peer-left", id: ws.id }));
  if (room.size === 0) delete rooms[ws.roomId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));

