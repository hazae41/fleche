import { ReadUnderflowError } from "@hazae41/binary"
import { Bytes, Uint8Array } from "@hazae41/bytes"
import { Cursor } from "@hazae41/cursor"
import { Naberius, pack_left, unpack, xor_mod } from "@hazae41/naberius"
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
    readonly mask?: Uint8Array<4>,
  ) {
    this.length = new Length(this.payload.length)
  }

  static from(params: {
    final: boolean,
    opcode: number,
    payload: Uint8Array,
    mask?: Uint8Array<4>
  }) {
    return new WebSocketFrame(params.final, params.opcode, params.payload, params.mask)
  }

  /**
   * Size as bits
   * @returns bits
   */
  sizeOrThrow() {
    return 0
      + 1 // FIN
      + 3 // RSV
      + 4 // opcode
      + 1 // MASK
      + this.length.sizeOrThrow()
      + (this.mask == null ? 0 : this.mask.length * 8)
      + this.payload.length * 8
  }

  /**
   * Write as bits
   * @param cursor bits
   */
  writeOrThrow(cursor: Cursor) {
    cursor.writeUint8OrThrow(Number(this.final))

    cursor.writeUint8OrThrow(0)
    cursor.writeUint8OrThrow(0)
    cursor.writeUint8OrThrow(0)

    const opcodeBytesCursor = new Cursor(Bytes.alloc(1))
    opcodeBytesCursor.writeUint8OrThrow(this.opcode)

    using opcodeBytesMemory = new Naberius.Memory(opcodeBytesCursor.bytes)
    using opcodeBitsMemory = unpack(opcodeBytesMemory)

    cursor.writeOrThrow(opcodeBitsMemory.bytes.subarray(4)) // 8 - 4

    const masked = Boolean(this.mask)
    cursor.writeUint8OrThrow(Number(masked))

    this.length.writeOrThrow(cursor)

    if (this.mask != null) {
      using maskBytesMemory = new Naberius.Memory(this.mask)
      using maskBitsMemory = unpack(maskBytesMemory)
      cursor.writeOrThrow(maskBitsMemory.bytes)

      using xoredBytesMemory = new Naberius.Memory(this.payload)
      xor_mod(xoredBytesMemory, maskBytesMemory)

      using xoredBitsMemory = unpack(xoredBytesMemory)
      cursor.writeOrThrow(xoredBitsMemory.bytes)

      return
    }

    using payloadBytesMemory = new Naberius.Memory(this.payload)
    using payloadBitsMemory = unpack(payloadBytesMemory)
    cursor.writeOrThrow(payloadBitsMemory.bytes)
  }

  /**
   * Read from bits
   * @param cursor bits
   * @returns 
   */
  static readOrThrow(cursor: Cursor) {
    const final = Boolean(cursor.readUint8OrThrow())

    cursor.offset += 3

    const opcode = cursor.readOrThrow(4).reduce((p, n) => (p << 1) | n)

    const masked = Boolean(cursor.readUint8OrThrow())

    const length = Length.readOrThrow(cursor)

    if (cursor.remaining < length.value)
      throw ReadUnderflowError.from(cursor)

    if (masked) {
      const maskBitsBytes = cursor.readOrThrow(4 * 8)
      using maskBitsMemory = new Naberius.Memory(maskBitsBytes)
      using maskBytesMemory = pack_left(maskBitsMemory)

      const xoredBitsBytes = cursor.readOrThrow(length.value * 8)
      using xoredBitsMemory = new Naberius.Memory(xoredBitsBytes)
      using xoredBytesMemory = pack_left(xoredBitsMemory)

      xor_mod(xoredBytesMemory, maskBytesMemory)

      const mask = maskBytesMemory.bytes.slice() as Uint8Array<4>
      const payload = xoredBytesMemory.bytes.slice()

      return WebSocketFrame.from({ final, opcode, payload, mask })
    }

    const payloadBitsBytes = cursor.readOrThrow(length.value * 8)
    using payloadBitsMemory = new Naberius.Memory(payloadBitsBytes)
    using payloadBytesMemory = pack_left(payloadBitsMemory)

    const payload = payloadBytesMemory.bytes.slice()

    return WebSocketFrame.from({ final, opcode, payload })
  }

}