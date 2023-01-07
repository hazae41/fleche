import { test } from "@hazae41/phobos"
import { Http } from "./http.js"

test("HTTP 1.1", async () => {
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

  const http = new Http(sub)
  const pread = http.read()
  const pwrite = http.write()

  http.readable.pipeTo(sup.writable)
  sup.readable.pipeTo(http.writable)

  await Promise.all([pread, pwrite])
})