import { writeAll } from "https://deno.land/std@0.157.0/streams/mod.ts";
import { Future } from "../src/libs/futures/future.ts";

const server = Deno.listen({ port: 8080 })

for await (const conn of server)
  onconn(conn)

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

      onsocket(socket)

      await respondWith(response)
    } catch (_: unknown) {
      await respondWith(new Response(undefined, { status: 500 }))
    }
  }
}

async function onsocket(socket: WebSocket) {
  socket.binaryType = "arraybuffer"

  const hello = new Future<MessageEvent<string>>()

  socket.addEventListener("message", hello.ok)
  socket.addEventListener("close", hello.err)
  socket.addEventListener("error", hello.err)

  const message = await hello.promise

  socket.removeEventListener("message", hello.ok)
  socket.removeEventListener("close", hello.err)
  socket.removeEventListener("error", hello.err)

  const hostname = message.data

  const target = await Deno.connectTls({ hostname, port: 443 })

  socket.send("hello")

  socket.addEventListener("message", async e => {
    try {
      const buffer = new Uint8Array(e.data)
      console.debug("->", buffer)
      await writeAll(target, buffer)
    } catch (_: unknown) {
      socket.close()
      return
    }
  })

  while (true) {
    try {
      const output = await read(target)

      if (!output) {
        socket.close()
        return
      }

      console.debug("<-", output)
      socket.send(output)
    } catch (_: unknown) {
      socket.close()
      return
    }
  }
}