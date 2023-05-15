import { Fleche } from "@hazae41/fleche"
import { createWebSocketStream } from "libs/transports/websocket"
import { useCallback } from "react"

export default function Home() {

  const onClick = useCallback(async () => {
    try {
      const tcp = await createWebSocketStream("ws://localhost:8080")
      const ws = new Fleche.WebSocket("ws://localhost", undefined, { subduplex: tcp })

      ws.binaryType = "arraybuffer"

      await new Promise((ok, err) => {
        ws.addEventListener("open", ok)
        ws.addEventListener("error", err)
      })

      ws.addEventListener("message", (event) => {
        const msgEvent = event as MessageEvent<ArrayBuffer>
        const bytes = new Uint8Array(msgEvent.data)
        console.log(bytes)
        ws.close()
      })

      const bytes = new Uint8Array([1, 2, 3])
      ws.send(bytes)
    } catch (e: unknown) {
      console.error(e)
    }
  }, [])

  return <button onClick={onClick}>
    Click me
  </button>
}
