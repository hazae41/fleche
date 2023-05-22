import { Fleche } from "@hazae41/fleche"
import { tryCreateWebSocketStream } from "libs/transports/websocket"
import { useCallback } from "react"

export default function Page() {

  const onClick = useCallback(async () => {
    try {
      const tcp = await tryCreateWebSocketStream("ws://localhost:8080")
      const res = await Fleche.fetch("https://twitter.com", { stream: tcp })

      const text = await res.text()

      console.log(text)
    } catch (e: unknown) {
      console.error(e)
    }
  }, [])

  return <button onClick={onClick}>
    Click me
  </button>
}
