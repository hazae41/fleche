import { BinaryReadError, BinaryWriteError, CursorReadLengthUnderflowError } from "@hazae41/binary"
import { Box, Copied } from "@hazae41/box"
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

      const opcodeBytesCursor = new Cursor(Bytes.tryAllocUnsafe(1).throw(t))
      opcodeBytesCursor.tryWriteUint8(this.opcode).throw(t)

      const opcodeBytesCopied = new Box(new Copied(opcodeBytesCursor.bytes))
      using opcodeBitsSlice = unpack(opcodeBytesCopied)

      cursor.tryWrite(opcodeBitsSlice.bytes.subarray(4)).throw(t) // 8 - 4

      const masked = Boolean(this.mask)
      cursor.tryWriteUint8(Number(masked)).throw(t)

      this.length.tryWrite(cursor).throw(t)

      if (this.mask.isSome()) {
        const maskBytesCopied = new Box(new Copied(this.mask.get()))
        using maskBitsSlice = unpack(maskBytesCopied)
        cursor.tryWrite(maskBitsSlice.bytes).throw(t)

        const payloadBytesCopied = new Box(new Copied(this.payload))
        using xoredBytesSlice = new Box(xor_mod(payloadBytesCopied, maskBytesCopied))

        using payloadBitsSlice = unpack(xoredBytesSlice)
        cursor.tryWrite(payloadBitsSlice.bytes).throw(t)
      } else {
        const payloadBytesCopied = new Box(new Copied(this.payload))
        using payloadBitsSlice = unpack(payloadBytesCopied)
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
        const maskBitsCopied = new Box(new Copied(cursor.tryRead(4 * 8).throw(t)))
        using maskBytesSlice = new Box(pack_left(maskBitsCopied))

        const mask = Bytes.tryCast(maskBytesSlice.get().bytes.slice(), 4).throw(t)

        const xoredBitsCopied = new Box(new Copied(cursor.tryRead(length.value * 8).throw(t)))
        using xoredBytesSlice = new Box(pack_left(xoredBitsCopied))

        const payloadBitsCopied = xor_mod(xoredBytesSlice, maskBytesSlice).copyAndDispose()

        return WebSocketFrame.tryNew({ final, opcode, payload: payloadBitsCopied.bytes, mask })
      } else {
        const payloadBytesCopied = new Box(new Copied(cursor.tryRead(length.value * 8).throw(t)))
        const payloadBitsCopied = pack_left(payloadBytesCopied).copyAndDispose()

        return WebSocketFrame.tryNew({ final, opcode, payload: payloadBitsCopied.bytes })
      }
    })
  }

}