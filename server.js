// Simple signaling server for anonymous rooms
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // roomId -> Set of sockets

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

wss.on("connection", ws => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "anon";
  ws.roomId = null;

  ws.on("message", msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "join") {
      ws.roomId = data.roomId;
      ws.name = (data.payload && data.payload.name) || "anon";

      if (!rooms[ws.roomId]) rooms[ws.roomId] = new Set();
      const peers = [...rooms[ws.roomId]].map(c => ({ id: c.id, name: c.name }));
      rooms[ws.roomId].add(ws);

      send(ws, { type: "joined", id: ws.id, peers });
      rooms[ws.roomId].forEach(c => {
        if (c !== ws) send(c, { type: "new-peer", id: ws.id, name: ws.name });
      });
    }

    if (data.type === "leave") {
      if (rooms[ws.roomId]) {
        rooms[ws.roomId].delete(ws);
        rooms[ws.roomId].forEach(c => send(c, { type: "peer-left", id: ws.id }));
      }
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

  ws.on("close", () => {
    if (rooms[ws.roomId]) {
      rooms[ws.roomId].delete(ws);
      rooms[ws.roomId].forEach(c => send(c, { type: "peer-left", id: ws.id }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));
