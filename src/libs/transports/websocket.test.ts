import { test } from "@hazae41/phobos"
import { Future } from "libs/futures/future.js"
import { WebSocketStream } from "libs/transports/websocket.js"
import { fetch } from "mods/fetch/fetch.js"
import { WebSocket } from "ws"

async function ready(ws: WebSocket) {
  const ready = new Future<void>()

  ws.addEventListener("open", () => ready.ok())
  ws.addEventListener("error", e => ready.err(e))

  ready.promise.catch(() => { })

  await ready.promise
}

test("WebSocketStream", async () => {
  const ws = new WebSocket("ws://127.0.0.1:8080")

  await ready(ws)

  const stream = new WebSocketStream(ws)

  const res = await fetch("https://webhook.site/d4ff9617-e29b-4b85-8443-6fcf1a2048ec", { stream })

  console.log("response", res)
  console.log(await res.text())
})