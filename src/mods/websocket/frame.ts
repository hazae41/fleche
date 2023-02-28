import { Cursor } from "@hazae41/binary"
import { pack_left, unpack, xor_mod } from "@hazae41/naberius"
import { Length } from "mods/websocket/length.js"

export class Frame {
  readonly #class = Frame

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

  constructor(
    readonly final: boolean,
    readonly opcode: number,
    readonly payload: Uint8Array,
    readonly mask?: Uint8Array,
  ) { }

  #data?: {
    length: Length
  }

  prepare() {
    const length = new Length(this.payload.length)
    this.#data = { length }
    return this
  }

  /**
   * Size as bits
   * @returns bits
   */
  size() {
    if (!this.#data)
      throw new Error(`Unprepared ${this.#class.name}`)
    const { length } = this.#data

    return 0
      + 1 // FIN
      + 3 // RSV
      + 4 // opcode
      + 1 // MASK
      + length.size()
      + (this.mask?.length ?? 0) * 8
      + this.payload.length * 8
  }

  /**
   * Write as bits
   * @param binary bits
   */
  write(binary: Cursor) {
    if (!this.#data)
      throw new Error(`Unprepared ${this.#class.name}`)
    const { length } = this.#data

    binary.writeUint8(Number(this.final))

    binary.writeUint8(0)
    binary.writeUint8(0)
    binary.writeUint8(0)

    const opcodeBytes = Cursor.allocUnsafe(1)
    opcodeBytes.writeUint8(this.opcode)
    const opcodeBits = unpack(opcodeBytes.bytes)
    binary.write(opcodeBits.subarray(4)) // 8 - 4

    const masked = Boolean(this.mask)
    binary.writeUint8(Number(masked))

    length.write(binary)

    if (this.mask) {
      binary.write(unpack(this.mask))
      xor_mod(this.payload, this.mask)
    }

    binary.write(unpack(this.payload))
  }

  /**
   * Read from bits
   * @param binary bits
   * @returns 
   */
  static read(binary: Cursor) {
    const final = Boolean(binary.readUint8())

    binary.offset += 3

    const opcode = binary.read(4).reduce((p, n) => (p << 1) | n)

    const masked = Boolean(binary.readUint8())

    const length = Length.read(binary)

    if (masked) {
      const mask = pack_left(binary.read(4 * 8))
      const payload = pack_left(binary.read(length.value * 8))
      xor_mod(payload, mask)

      return new this(final, opcode, payload, mask)
    } else {
      const payload = pack_left(binary.read(length.value * 8))

      return new this(final, opcode, payload)
    }
  }

}