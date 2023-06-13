import { BinaryReadError, BinaryWriteError } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { Cursor } from "@hazae41/cursor"
import { Option } from "@hazae41/option"
import { Ok, Result } from "@hazae41/result"

export class WebSocketClose {
  readonly #class = WebSocketClose

  constructor(
    readonly code: number,
    readonly reason: Option<Bytes>
  ) { }

  static tryNew(code: number, reason?: string): Result<WebSocketClose, never> {
    return new Ok(new WebSocketClose(code, Option.wrap(reason).mapSync(Bytes.fromUtf8)))
  }

  trySize(): Result<number, never> {
    return new Ok(2 + this.reason.mapOrSync(0, x => x.length))
  }

  tryWrite(cursor: Cursor): Result<void, BinaryWriteError> {
    return Result.unthrowSync(t => {
      cursor.tryWriteUint16(this.code).throw(t)
      this.reason.inspectSync(x => cursor.tryWrite(x).throw(t))

      return Ok.void()
    })
  }

  static tryRead(cursor: Cursor): Result<WebSocketClose, BinaryReadError> {
    return Result.unthrowSync(t => {
      const code = cursor.tryReadUint16().throw(t)

      if (cursor.remaining) {
        const bytes = cursor.tryRead(cursor.remaining).throw(t)
        const reason = Bytes.toUtf8(bytes)
        return WebSocketClose.tryNew(code, reason)
      }

      return WebSocketClose.tryNew(code)
    })
  }

}