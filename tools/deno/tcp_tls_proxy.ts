import { iterateReader, writeAll } from "https://deno.land/std@0.187.0/streams/mod.ts";

const server = Deno.listen({ port: 8081 });

for await (const conn of server)
  handleConn(conn).catch(console.error)

async function pipeAndLog(symbol: string, reader: Deno.Reader, writer: Deno.Writer) {
  for await (const bytes of iterateReader(reader)) {
    console.debug(symbol, bytes)
    await writeAll(writer, bytes)
  }
}

async function handleConn(conn: Deno.Conn) {
  const target = await Deno.connectTls({ hostname: "eth.llamarpc.com", port: 443 })

  const forward = pipeAndLog("->", conn, target)
  const backward = pipeAndLog("<-", target, conn)

  try {
    await Promise.any([forward, backward])
  } catch (e: unknown) {
    console.error(e)
  } finally {
    console.log("closed")
    conn.close()
    target.close()
  }
}