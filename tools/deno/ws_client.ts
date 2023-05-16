const socket = new WebSocket("ws://localhost:8080")

await new Promise<void>((ok, err) => {
  socket.addEventListener("open", () => ok())
  socket.addEventListener("error", () => err())
  socket.addEventListener("close", () => err())
})

socket.addEventListener("message", e => {
  const buffer = e.data as ArrayBuffer
  console.debug(new Uint8Array(buffer))
})

socket.send(new Uint8Array([1, 2, 3]))

socket.close(3123)

while (true);