import { test } from "@hazae41/phobos"
import { Future } from "libs/futures/future.js"
import { fetch } from "mods/fetch/fetch.js"
import { WebSocketStream } from "./websocket.js"

async function ready(socket: WebSocket, hostname: string) {
  socket.binaryType = "arraybuffer"

  const open = new Future<Event>()

  socket.addEventListener("open", open.ok)
  socket.addEventListener("close", open.err)
  socket.addEventListener("error", open.err)

  await open.promise

  socket.removeEventListener("open", open.ok)
  socket.removeEventListener("close", open.err)
  socket.removeEventListener("error", open.err)

  const hello = new Future<MessageEvent>()

  socket.addEventListener("message", hello.ok)
  socket.addEventListener("close", hello.err)
  socket.addEventListener("error", hello.err)

  socket.send(hostname)
  await hello.promise

  socket.removeEventListener("message", hello.ok)
  socket.removeEventListener("close", hello.err)
  socket.removeEventListener("error", hello.err)
}

test("WebSocketStream", async () => {
  const socket = new WebSocket("ws://127.0.0.1:8080")

  /**
   * Wait TCP/TLS over WebSocket to given hostname
   */
  await ready(socket, "orbitum.space")

  const stream = new WebSocketStream(socket)

  // const body = JSON.stringify({ hello: "world" })
  // const headers = new Headers({ "content-type": "application/json" })

  const res = await fetch("https://orbitum.space", { method: "GET", stream })

  console.log("response", res)
  console.log(await res.text())

  // socket.close()
})