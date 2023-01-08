import { test } from "@hazae41/phobos"
import { Http } from "./http.js"

test("HTTP 1.1 should gracefully cancel", async () => {
  const sub = {
    readable: new ReadableStream<Buffer>({
      pull(controller) {
        controller.enqueue(Buffer.from("hello from sub"))
      }
    }),
    writable: new WritableStream<Buffer>({
      write(chunk) {
        console.log(chunk.toString("utf8"))
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
        console.log(chunk.toString("utf8"))
      }
    })
  }

  const aborter = new AbortController()
  const http = new Http(sub, aborter.signal)

  http.readable.pipeTo(sup.writable).catch(() => { })
  sup.readable.pipeTo(http.writable).catch(() => { })

  setTimeout(() => aborter.abort(), 1000)

  await Promise.all([http.reading, http.writing])
})