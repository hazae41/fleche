import { Cursor } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"

export class WebSocketClose {
  readonly #class = WebSocketClose

  constructor(
    readonly code: number,
    readonly reason?: string
  ) { }

  #data?: {
    reason?: Uint8Array
  }

  prepare() {
    const reason = this.reason
      ? Bytes.fromUtf8(this.reason)
      : undefined

    this.#data = { reason }
    return this
  }

  size() {
    if (!this.#data)
      throw new Error(`Unprepared ${this.#class.name}`)
    const { reason } = this.#data

    return 2 + (reason?.length ?? 0)
  }

  write(cursor: Cursor) {
    if (!this.#data)
      throw new Error(`Unprepared ${this.#class.name}`)
    const { reason } = this.#data

    cursor.writeUint16(this.code)

    if (reason) {
      cursor.write(reason)
    }
  }

  static read(cursor: Cursor) {
    const code = cursor.readUint16()

    if (cursor.remaining) {
      const bytes = cursor.read(cursor.remaining)
      const reason = Bytes.toUtf8(bytes)
      return new this(code, reason)
    }

    return new this(code)
  }

}