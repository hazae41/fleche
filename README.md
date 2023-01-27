<div align="center">
<img width="500" src="https://user-images.githubusercontent.com/4405263/211164253-c5f977ea-358a-4ad0-a8ab-9c4cdd4137e1.png" />
</div>
<h3 align="center">
Zero-copy HTTP protocol for the web 🏎️
</h3>

```bash
npm i @hazae41/fleche
```

[**Node Package 📦**](https://www.npmjs.com/package/@hazae41/fleche)

### Current features
- 100% TypeScript and ESM
- Zero-copy reading and writing
- Transport agnostic (WebSocket, Tor, TLS)
- WebStreams backpressure
- WebAssembly Gzip compression
- AbortSignal cancellation
- Compatible with fetch
- HTTP 1.1

### [Upcoming features](https://github.com/sponsors/hazae41)
- More HTTP 1.1 features
- Brotli compression
- HTTP 2, HTTP 3 (QUIC)
- WebSockets

### Usage

```tsx
import { fetch } from "@hazae41/fleche"

function example(stream: ReadableWritablePair<Uint8Array>) {
  const res = await fetch("https://example.com", { stream })

  if (!res.ok)
    throw new Error(await res.text())

  return await res.json()
}
```
