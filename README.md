<div align="center">
<img src="https://user-images.githubusercontent.com/4405263/219943458-f5fa0f94-8dfd-4f8e-9fb5-df780a600dd4.png" />
</div>

```bash
npm i @hazae41/fleche
```

[**Node Package 📦**](https://www.npmjs.com/package/@hazae41/fleche)

## Features

### Current features
- 100% TypeScript and ESM
- Zero-copy reading and writing
- Transport agnostic (WebSocket, Tor, TLS)
- WebStreams backpressure
- WebAssembly Gzip compression
- AbortSignal cancellation
- Compatible with fetch
- HTTP 1.1
- WebSockets

### [Upcoming features](https://github.com/sponsors/hazae41)
- More HTTP 1.1 features
- Brotli compression
- HTTP 2, HTTP 3 (QUIC)

## Usage

```tsx
import { fetch } from "@hazae41/fleche"

function example(stream: ReadableWritablePair<Uint8Array>) {
  const res = await fetch("https://example.com", { stream })

  if (!res.ok)
    throw new Error(await res.text())

  return await res.json()
}
```
