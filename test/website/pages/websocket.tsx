import { Opaque, Writable } from "@hazae41/binary"
import { bench } from "@hazae41/deimos"
import { Fleche } from "@hazae41/fleche"
import { Future } from "@hazae41/future"
import { WebSocketDuplex, createWebSocketDuplex } from "libs/transports/websocket"
import { useCallback, useEffect, useState } from "react"

async function createFlecheSocket(tcp: ReadableWritablePair<Opaque, Writable>) {
  const socket = new Fleche.WebSocket("ws://localhost", undefined)

  tcp.readable.pipeTo(socket.inner.writable, { preventCancel: true }).catch(() => { })
  socket.inner.readable.pipeTo(tcp.writable, { preventClose: true, preventAbort: true }).catch(() => { })

  socket.binaryType = "arraybuffer"

  await new Promise((ok, err) => {
    socket.addEventListener("open", ok)
    socket.addEventListener("error", err)
  })

  return socket
}

async function createNativeSocket() {
  const socket = new WebSocket("ws://localhost:8081", undefined)

  socket.binaryType = "arraybuffer"

  await new Promise((ok, err) => {
    socket.addEventListener("open", ok)
    socket.addEventListener("error", err)
  })

  return socket
}

export default function Page() {
  const [tcp, setTcp] = useState<WebSocketDuplex>()

  useEffect(() => {
    createWebSocketDuplex("ws://localhost:8080",).then(setTcp)
  }, [])

  const [flecheSocket, setFlecheSocket] = useState<WebSocket>()

  useEffect(() => {
    if (tcp == null)
      return
    createFlecheSocket(tcp.outer).then(setFlecheSocket)
  }, [tcp])

  const [nativeSocket, setNativeSocket] = useState<WebSocket>()

  useEffect(() => {
    createNativeSocket().then(setNativeSocket)
  }, [])

  const onFlecheClick = useCallback(async () => {
    try {
      if (flecheSocket == null)
        return
      if (nativeSocket == null)
        return

      const fleche = await bench("fleche", async () => {
        const future = new Future<MessageEvent>()

        flecheSocket.addEventListener("message", (event) => {
          future.resolve(event)
        }, { once: true })

        flecheSocket.send(new Uint8Array([1, 2, 3]))

        await future.promise
      }, { warmup: false, samples: 10000 })

      const native = await bench("native", async () => {
        const future = new Future<MessageEvent>()

        nativeSocket.addEventListener("message", (event) => {
          future.resolve(event)
        }, { once: true })

        nativeSocket.send(new Uint8Array([1, 2, 3]))

        await future.promise
      }, { warmup: false, samples: 10000 })

      native.tableAndSummary(fleche)
    } catch (e: unknown) {
      console.error("onClick", e)
    }
  }, [flecheSocket, nativeSocket])

  return <>
    <button onClick={onFlecheClick}>
      Click me
    </button>
  </>
}
