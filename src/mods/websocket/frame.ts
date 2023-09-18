import { BinaryReadError, BinaryWriteError, CursorReadLengthUnderflowError } from "@hazae41/binary"
import { Box } from "@hazae41/box"
import { Bytes } from "@hazae41/bytes"
import { Cursor } from "@hazae41/cursor"
import { pack_left, unpack, xor_mod } from "@hazae41/naberius"
import { Option } from "@hazae41/option"
import { Err, Ok, Result } from "@hazae41/result"
import { Length } from "mods/websocket/length.js"

export class WebSocketFrame {
  readonly #class = WebSocketFrame

  static readonly opcodes = {
    continuation: 0,
    text: 1,
    binary: 2,

    /**
     * Control
     */
    close: 8,
    ping: 9,
    pong: 10
  } as const

  readonly length: Length

  private constructor(
    readonly final: boolean,
    readonly opcode: number,
    readonly payload: Uint8Array,
    readonly mask: Option<Bytes<4>>,
  ) {
    this.length = new Length(this.payload.length)
  }

  static tryNew(params: {
    final: boolean,
    opcode: number,
    payload: Bytes,
    mask?: Bytes<4>
  }): Result<WebSocketFrame, never> {
    const { final, opcode, payload } = params

    return new Ok(new WebSocketFrame(final, opcode, payload, Option.wrap(params.mask)))
  }

  /**
   * Size as bits
   * @returns bits
   */
  trySize(): Result<number, never> {
    return new Ok(0
      + 1 // FIN
      + 3 // RSV
      + 4 // opcode
      + 1 // MASK
      + this.length.trySize().get()
      + this.mask.mapOrSync(0, x => x.length * 8)
      + this.payload.length * 8)
  }

  /**
   * Write as bits
   * @param cursor bits
   */
  tryWrite(cursor: Cursor): Result<void, BinaryWriteError> {
    return Result.unthrowSync(t => {
      cursor.tryWriteUint8(Number(this.final)).throw(t)

      cursor.tryWriteUint8(0).throw(t)
      cursor.tryWriteUint8(0).throw(t)
      cursor.tryWriteUint8(0).throw(t)

      const opcodeBytes = new Cursor(Bytes.tryAllocUnsafe(1).throw(t))
      opcodeBytes.tryWriteUint8(this.opcode).throw(t)

      using opcodeBitsSlice = unpack(opcodeBytes.bytes)
      cursor.tryWrite(opcodeBitsSlice.bytes.subarray(4)).throw(t) // 8 - 4

      const masked = Boolean(this.mask)
      cursor.tryWriteUint8(Number(masked)).throw(t)

      this.length.tryWrite(cursor).throw(t)

      if (this.mask.isSome()) {
        using maskBitsSlice = unpack(this.mask.get())
        cursor.tryWrite(maskBitsSlice.bytes).throw(t)

        using xored = new Box(xor_mod(this.payload, this.mask.get()))

        using payloadBitsSlice = unpack(xored.unwrap().bytes)
        cursor.tryWrite(payloadBitsSlice.bytes).throw(t)
      } else {
        using payloadBitsSlice = unpack(this.payload)
        cursor.tryWrite(payloadBitsSlice.bytes).throw(t)
      }

      return Ok.void()
    })
  }

  /**
   * Read from bits
   * @param cursor bits
   * @returns 
   */
  static tryRead(cursor: Cursor): Result<WebSocketFrame, BinaryReadError> {
    return Result.unthrowSync(t => {
      const final = Boolean(cursor.tryReadUint8().throw(t))

      cursor.offset += 3

      const opcode = cursor.tryRead(4).throw(t).reduce((p, n) => (p << 1) | n)

      const masked = Boolean(cursor.tryReadUint8().throw(t))

      const length = Length.tryRead(cursor).throw(t)

      if (cursor.remaining < length.value)
        return new Err(CursorReadLengthUnderflowError.from(cursor))

      if (masked) {
        using maskSlice = new Box(pack_left(cursor.tryRead(4 * 8).throw(t)))
        const mask = Bytes.tryCast(maskSlice.inner.bytes.slice(), 4).throw(t)

        using xoredSlice = new Box(pack_left(cursor.tryRead(length.value * 8).throw(t)))
        const payload = xor_mod(xoredSlice.unwrap().bytes, maskSlice.unwrap().bytes).copyAndDispose()

        return WebSocketFrame.tryNew({ final, opcode, payload, mask })
      } else {
        const payload = pack_left(cursor.tryRead(length.value * 8).throw(t)).copyAndDispose()

        return WebSocketFrame.tryNew({ final, opcode, payload })
      }
    })
  }

}