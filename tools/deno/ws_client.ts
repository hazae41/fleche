const socket = new WebSocket("ws://localhost:8080")

socket.binaryType = "arraybuffer"

await new Promise<void>((ok, err) => {
  socket.addEventListener("open", () => ok())
  socket.addEventListener("error", () => err())
  socket.addEventListener("close", () => err())
})

socket.send(new Uint8Array([1, 2, 3]))

const reply = await new Promise<Uint8Array>((ok, err) => {
  socket.addEventListener("message", e => ok(new Uint8Array(e.data)))
  socket.addEventListener("error", () => err())
  socket.addEventListener("close", () => err())
})

console.debug(reply)

socket.close(3123)

while (true);