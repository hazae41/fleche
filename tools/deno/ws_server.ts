const server = Deno.listen({ port: 8081 })

for await (const conn of server)
  handleConn(conn).catch(console.error)

async function handleConn(conn: Deno.Conn) {
  const http = Deno.serveHttp(conn)

  for await (const { request, respondWith } of http) {
    try {
      const { socket, response } = Deno.upgradeWebSocket(request);

      socket.binaryType = "arraybuffer"

      socket.addEventListener("message", e => {
        try {
          const buffer = e.data as ArrayBuffer
          // console.debug(new Uint8Array(buffer))
          socket.send(buffer)
        } catch (_: unknown) {
          socket.close()
          return
        }
      })

      await respondWith(response)
    } catch (_: unknown) {
      await respondWith(new Response(undefined, { status: 500 }))
    }
  }
}