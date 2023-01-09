import { test } from "@hazae41/phobos"
import { TransformByteStream } from "libs/streams/streams.js"
import { Uint8Arrays } from "libs/uint8arrays/uint8arrays.js"
import { fetch } from "mods/fetch/fetch.js"
import { HttpStream } from "mods/http/http.js"

test("HTTP 1.1 superstream", async ({ message }) => {


  const start = Date.now()

  const sub = new TransformByteStream({
    async transform(chunk, controller) {
      await new Promise(ok => setTimeout(ok, 100))
      controller.enqueue(chunk)
    },
  })

  let i = 0

  const sup = {
    readable: new ReadableStream({
      type: "bytes",
      async pull(controller) {
        await new Promise(ok => setTimeout(ok, 10))

        if (i++ === 10)
          controller.close()
        else
          controller.enqueue(Uint8Arrays.fromUtf8("hello world"))
      }
    }),
    writable: new WritableStream<Buffer>({
      write(chunk) {
        console.log(Uint8Arrays.intoUtf8(chunk))
      }
    })
  }

  const aborter = new AbortController()
  const { signal } = aborter

  const http = new HttpStream(sub, { signal })

  // setTimeout(() => aborter.abort(), 1000)

  const reading = http.readable.pipeTo(sup.writable, { signal })
  const writing = sup.readable.pipeTo(http.writable, { signal })

  try {
    await Promise.all([reading, writing])
  } catch (e: unknown) {
    console.error(e)
  }

  const end = Date.now()

  if (end - start < 1000)
    throw new Error("Stopped before delay")
  if (end - start > 1100)
    throw new Error("Stopped after delay")

  console.log("✅", message, `(${end - start}ms)`)
})

test("HTTP 1.1 fetch", async ({ message }) => {
  return

  const start = Date.now()

  const sub = new TransformByteStream({
    async transform(chunk, controller) {
      await new Promise(ok => setTimeout(ok, 100))

      console.log("<->", chunk)
      controller.enqueue(chunk)
    },
  })

  const aborter = new AbortController()
  const { signal } = aborter

  let i = 0

  const body = new ReadableStream({
    type: "bytes",
    pull(controller) {
      if (i++ === 5)
        controller.close()
      else
        controller.enqueue(Uint8Arrays.fromUtf8("hello world"))
    }
  })

  const http = new HttpStream(sub)

  // setTimeout(() => aborter.abort(), 200)

  try {
    const res = await fetch(http, "https://google.com", { method: "POST", body, signal })

    console.log("got response", res)
    console.log(await res.arrayBuffer())
  } catch (e: unknown) {
    console.error(e)
  }

  const end = Date.now()

  console.log("✅", message, `(${end - start}ms)`)
})

console.log("lol")