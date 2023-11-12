<div align="center">
<img src="https://user-images.githubusercontent.com/4405263/219943458-f5fa0f94-8dfd-4f8e-9fb5-df780a600dd4.png" />
</div>

```bash
npm i @hazae41/fleche
```

[**Node Package 📦**](https://www.npmjs.com/package/@hazae41/fleche)

## Features

### Goals
- 100% TypeScript and ESM
- Zero-copy reading and writing
- Transport agnostic (TCP, TLS, Tor)
- Supports backpressure

### HTTP
- HTTP 1.1
- Native Gzip and Deflate compression
- Compatible with code using `fetch`
- Reusable underlying connection

### WebSocket
- Relies on the above HTTP
- Powered by WebAssembly
- Same API than native
- Only 0.3ms slower than native

### [Upcoming features](https://github.com/sponsors/hazae41)
- More HTTP 1.1 features
- HTTP 2, HTTP 3 (QUIC)

## Usage

```tsx
import { Opaque, Writable } from "@hazae41/binary"
import { fetch } from "@hazae41/fleche"

function example(stream: ReadableWritablePair<Opaque, Writable>) {
  /**
   * Fetch using the underlying TCP or TLS stream
   */
  const res = await fetch("https://example.com", { stream })

  if (!res.ok)
    throw new Error(await res.text())

  return await res.json()
}
```

```tsx
import { Opaque, Writable } from "@hazae41/binary"
import { WebSocket } from "@hazae41/fleche"

function example(stream: ReadableWritablePair<Opaque, Writable>) {
  const socket = new WebSocket("wss://example.com")

  /**
   * Pipe TCP or TLS input to WebSocket input
   */
  stream.readable
    .pipeTo(socket.input.writable, { preventCancel: true })
    .catch(() => {})

  /**
   * Pipe WebSocket output to TCP or TLS output
   */
  socket.output.readable
    .pipeTo(stream.writable, { preventClose: true, preventAbort: true })
    .catch(() => {})

  await new Promise((ok, err) => {
    socket.addEventListener("open", ok)
    socket.addEventListener("error", err)
  })

  socket.addEventListener("message", e => console.log(e.data))
  socket.send("Hello world")
}
