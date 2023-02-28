export namespace Iterables {

  export function* peek<T>(iterable: Iterable<T>) {
    const iterator = iterable[Symbol.iterator]()

    let next = iterator.next()

    while (!next.done) {
      const current = next.value
      next = iterator.next()
      yield { current, next }
    }
  }

}