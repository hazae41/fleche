import { test } from "@hazae41/phobos"
import { Iterables } from "./iterables.js"

const array = [1, 2, 3, 4, 5]

test("peek", async ({ test }) => {
  for (const { current, next } of Iterables.peek(array))
    console.log(current, next)
})