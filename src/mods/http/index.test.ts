import { test } from "@hazae41/phobos"
import { fetch } from "mods/fetch/fetch.js"
import { HttpStream } from "mods/http/http.js"

test("HTTP 1.1 superstream should gracefully close on http abort", async ({ message }) => {
  return

  const start = Date.now()

  const sub = {
    readable: new ReadableStream<Buffer>({
      pull(controller) {
        controller.enqueue(Buffer.from("hello from sub"))
      }
    }),
    writable: new WritableStream<Buffer>({
      write(chunk) {
        // NOOP
      }
    })
  }

  const sup = {
    readable: new ReadableStream<Buffer>({
      pull(controller) {
        controller.enqueue(Buffer.from("hello from sup"))
      }
    }),
    writable: new WritableStream<Buffer>({
      write(chunk) {
        // NOOP
      }
    })
  }

  const http = new HttpStream(sub)

  setTimeout(() => http.aborter.abort(), 1000)

  http.readable.pipeTo(sup.writable).catch(() => { })
  sup.readable.pipeTo(http.writable).catch(() => { })

  await Promise.all([http.reading, http.writing])

  const end = Date.now()

  if (end - start < 1000)
    throw new Error("Stopped before delay")
  if (end - start > 1100)
    throw new Error("Stopped after delay")

  console.log("✅", message, `(${end - start}ms)`)
})

test("HTTP 1.1 fetch", async ({ message }) => {
  const start = Date.now()

  const closer = new AbortController()

  // const sub = {
  //   readable: new ReadableStream<Buffer>({
  //     pull(controller) {
  //       if (closer.signal.aborted)
  //         controller.close()
  //       else
  //         controller.enqueue(Buffer.from("hello from sub"))
  //     }
  //   }),
  //   writable: new WritableStream<Buffer>({
  //     write(chunk) {
  //       console.log(chunk)
  //     }
  //   })
  // }

  const sub = new TransformStream<Buffer, Buffer>({
    transform(chunk) {
      console.log(chunk)
    }
  })

  const aborter = new AbortController()
  const { signal } = aborter

  // setTimeout(() => aborter.abort(), 1000)
  // setTimeout(() => closer.abort(), 1000)

  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(Buffer.from("hello from sup"))
      controller.enqueue(Buffer.from("hello from sup"))
      controller.enqueue(Buffer.from("hello from sup"))
      controller.enqueue(Buffer.from("hello from sup"))
      controller.close()
    }
  })

  const res = await fetch(new HttpStream(sub), "https://google.com", { method: "POST", body, signal })

  console.log("got response", res)

  if (!res) return

  console.log(Buffer.from(await res.arrayBuffer()))

  const end = Date.now()

  console.log("✅", message, `(${end - start}ms)`)
})

console.log("lol")