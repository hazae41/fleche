import { Bytes } from "@hazae41/bytes"
import { WebSocketClient } from "@hazae41/fleche"
import { useCallback } from "react"
import { createWebSocketStream } from "../src/transports/websocket"

export default function Home() {

  const onClick = useCallback(async () => {
    try {
      const tcp = await createWebSocketStream("ws://localhost:8080")
      const ws = new WebSocketClient("ws://localhost", undefined, { stream: tcp })

      await new Promise((ok, err) => {
        ws.addEventListener("open", ok)
        ws.addEventListener("close", err)
        ws.addEventListener("error", err)
      })

      ws.addEventListener("message", (event) => {
        const msgEvent = event as MessageEvent<ArrayBuffer>
        const bytes = new Uint8Array(msgEvent.data)
        console.log(bytes[123])
      })

      const bytes = Bytes.allocUnsafe(8 * 1024 * 1024)
      bytes[123] = 123
      ws.send(bytes)
    } catch (e: unknown) {
      console.error(e)
    }
  }, [])

  return <button onClick={onClick}>
    Click me
  </button>
}
