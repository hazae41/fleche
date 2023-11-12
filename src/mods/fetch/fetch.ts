import { Opaque, Writable } from "@hazae41/binary"
import { Disposable, PromiseDisposer } from "@hazae41/cleaner"
import { Future } from "@hazae41/future"
import { None } from "@hazae41/option"
import { AbortedError, ClosedError, ErroredError } from "@hazae41/plume"
import { Catched, Err, Ok, Result } from "@hazae41/result"
import { HttpClientDuplex } from "mods/http/client.js"

export interface FetchParams {
  stream: ReadableWritablePair<Opaque, Writable>
}

namespace Requests {

  export async function getBody(request: Request, init: RequestInit) {
    /**
     * Firefox fix
     */
    if (request.body == null && init.body != null) {
      if (init.body instanceof ReadableStream) {
        return init.body as ReadableStream<Uint8Array>
      } else {
        const blob = await request.blob()
        return blob.stream()
      }
    }

    return request.body
  }

}

export class PipeError extends Error {
  readonly #class = PipeError
  readonly name = this.#class.name

  constructor(options: ErrorOptions) {
    super(undefined, options)
  }

  static wait(http: HttpClientDuplex, body?: ReadableStream<Uint8Array> | null) {
    const controller = new AbortController()
    const future = new Future<Err<PipeError>>()

    const { signal } = controller

    if (body != null)
      body.pipeTo(http.output.writable, { signal }).catch(e => future.resolve(new Err(new PipeError({ cause: e }))))
    else
      http.output.writable.close().catch(e => future.resolve(new Err(new PipeError({ cause: e }))))

    return new PromiseDisposer(future.promise, () => controller.abort())
  }

}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function fetch(input: RequestInfo | URL, init: RequestInit & FetchParams & StreamPipeOptions) {
  return await tryFetch(input, init).then(r => r.unwrap())
}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function tryFetch(input: RequestInfo | URL, init: RequestInit & FetchParams & StreamPipeOptions): Promise<Result<Response, AbortedError | ErroredError | ClosedError | PipeError>> {
  const { stream, preventAbort, preventCancel, preventClose, ...others } = init

  const request = new Request(input, others)
  const body = await Requests.getBody(request, others)

  const { url, method, signal } = request
  const { host, pathname, search } = new URL(url)

  const target = pathname + search
  const headers = new Headers(init.headers)

  if (!headers.has("Host"))
    headers.set("Host", host)
  if (!headers.has("Connection"))
    headers.set("Connection", "keep-alive")
  if (!headers.has("Transfer-Encoding") && !headers.has("Content-Length"))
    headers.set("Transfer-Encoding", "chunked")
  if (!headers.has("Accept-Encoding"))
    headers.set("Accept-Encoding", "gzip, deflate")

  const http = new HttpClientDuplex({ method, target, headers })

  stream.readable
    .pipeTo(http.input.writable, { signal, preventClose, preventAbort, preventCancel })
    .catch(Catched.throwOrErr)
    .then(r => r?.ignore())
    .catch(console.error)

  http.output.readable
    .pipeTo(stream.writable, { signal, preventClose, preventAbort, preventCancel })
    .catch(Catched.throwOrErr)
    .then(r => r?.ignore())
    .catch(console.error)

  const abort = AbortedError.wait(signal)
  const error = ErroredError.wait(http.events.input)
  const close = ClosedError.wait(http.events.input)
  const pipe = PipeError.wait(http, body)

  const head = http.events.input.wait("head", (future: Future<Ok<Response>>, init) => {
    future.resolve(new Ok(new Response(http.input.readable, init)))
    return new None()
  })

  const response = await Disposable.race<Result<Response, AbortedError | ErroredError | ClosedError | PipeError>>([abort, error, close, pipe, head])

  if (response.isErr())
    return response

  http.events.input.on("close", async () => {
    if (headers.get("Connection") === "close") {
      await stream.readable
        .cancel(new Error(`Request "Connection" header is "close"`))
        .catch(console.warn)
      return new None()
    }

    if (response.get().headers.get("Connection") === "close") {
      await stream.readable
        .cancel(new Error(`Response "Connection" header is "close"`))
        .catch(console.warn)
      return new None()
    }

    return new None()
  }, { once: true })

  return response
}