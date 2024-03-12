import { Fleche } from "@hazae41/fleche"
import { Mutex } from "@hazae41/mutex"
import { WebSocketDuplex, createWebSocketDuplex } from "libs/transports/websocket"
import { useCallback, useEffect, useMemo, useState } from "react"

Fleche.Console.debugging = true

export default function Page() {
  const [tcp, setTcp] = useState<WebSocketDuplex>()

  useEffect(() => {
    createWebSocketDuplex("ws://localhost:8080",).then(setTcp)
  }, [])

  const mutex = useMemo(() => {
    if (tcp == null)
      return
    return new Mutex(tcp)
  }, [tcp])

  const onClick = useCallback(async () => {
    try {
      if (mutex == null)
        return
      await mutex.lock(async tcp => {
        const start = performance.now()
        const headers = { "Content-Type": "application/json" }
        const body = JSON.stringify({ "jsonrpc": "2.0", "method": "web3_clientVersion", "params": [], "id": 67 })
        const res = await Fleche.fetch("https://eth.llamarpc.com", { method: "POST", headers, body, stream: tcp.outer, preventClose: true, preventCancel: true, preventAbort: true })
        console.log("head", res.headers)
        console.log("head", performance.now() - start, "ms")
        const text = await res.text()
        console.log(text)
        console.log("body", performance.now() - start, "ms")
      })
    } catch (e: unknown) {
      console.error("onClick", { e })
    }
  }, [mutex])

  return <button onClick={onClick}>
    Click me
  </button>
}
