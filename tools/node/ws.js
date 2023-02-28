import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', function connection(ws) {
  ws.on('error', console.error);

  ws.on('message', function message(data) {
    ws.send(data, { fin: false })
    ws.send(new Uint8Array([4, 5]), { fin: false })
    ws.send(new Uint8Array([6, 7]), { fin: true })
    // ws.close(1000, "lol")
  });
});