import { test } from "@hazae41/phobos"
import { WebSocketStream } from "libs/transports/websocket.js"
import { fetch } from "mods/fetch/fetch.js"
import { WebSocket } from "ws"

test("WebSocketStream", async () => {
  const ws = new WebSocket("ws://127.0.0.1")
  const stream = new WebSocketStream(ws)

  const res = await fetch("https://google.com", { stream })

  console.log(await res.text())
})