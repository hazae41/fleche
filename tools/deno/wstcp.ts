import { writeAll } from "https://deno.land/std@0.157.0/streams/mod.ts";

const server = Deno.listen({ port: 8080 })

for await (const conn of server)
  onconn(conn).catch(console.error)

async function read(reader: Deno.Reader) {
  const p = new Uint8Array(32 * 1024)
  const n = await reader.read(p)
  if (n) return p.subarray(0, n)
}

async function onconn(conn: Deno.Conn) {
  const http = Deno.serveHttp(conn)

  for await (const { request, respondWith } of http) {
    try {
      const { socket, response } = Deno.upgradeWebSocket(request);

      const target = await Deno.connect({ hostname: "127.0.0.1", port: 8081, transport: "tcp" })

      onsocket(socket, target)

      await respondWith(response)
    } catch (_: unknown) {
      await respondWith(new Response(undefined, { status: 500 }))
    }
  }
}

async function onsocket(socket: WebSocket, target: Deno.Conn) {
  socket.binaryType = "arraybuffer"

  socket.addEventListener("message", async e => {
    try {
      const bytes = new Uint8Array(e.data)
      console.debug("->", bytes)
      await writeAll(target, bytes)
    } catch (_: unknown) {
      socket.close()
      return
    }
  })

  while (true) {
    try {
      const bytes = await read(target)

      if (!bytes) {
        socket.close()
        return
      }

      console.debug("<-", bytes)
      socket.send(bytes)
    } catch (_: unknown) {
      socket.close()
      return
    }
  }
}