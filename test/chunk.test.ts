import { expect, test } from "vitest";
import { chunk } from "../src/utils";

test("chunks correctly", () => {
  expect(chunk([1, 2, 3, 4, 5, 6, 7, 8], 2)).toStrictEqual([
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
  ]);

  expect(chunk([], 10)).toStrictEqual([]);
  expect(chunk([1, 2, 3], 10)).toStrictEqual([[1, 2, 3]]);

  expect(chunk([1, 2, 3], 0)).toStrictEqual([[1, 2, 3]]);
});
