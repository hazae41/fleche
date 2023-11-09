import { Bytes } from "@hazae41/bytes"
import { Cursor } from "@hazae41/cursor"
import { Option } from "@hazae41/option"

export class WebSocketClose {

  constructor(
    readonly code: number,
    readonly reason: Option<Bytes>
  ) { }

  static from(code: number, reason?: string) {
    return new WebSocketClose(code, Option.wrap(reason).mapSync(Bytes.fromUtf8))
  }

  sizeOrThrow() {
    return 2 + this.reason.mapOrSync(0, x => x.length)
  }

  writeOrThrow(cursor: Cursor) {
    cursor.writeUint16OrThrow(this.code)

    if (this.reason.isNone())
      return
    cursor.writeOrThrow(this.reason.get())
  }

  static readOrThrow(cursor: Cursor) {
    const code = cursor.readUint16OrThrow()

    if (cursor.remaining) {
      const bytes = cursor.readOrThrow(cursor.remaining)
      const reason = Bytes.toUtf8(bytes)
      return WebSocketClose.from(code, reason)
    }

    return WebSocketClose.from(code)
  }

}