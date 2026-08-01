import { describe, expect, test } from "vitest";
import { add, divide, multiply, subtract } from "./math.js";

describe("add", () => {
  test("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  test("adds negative numbers", () => {
    expect(add(-2, -3)).toBe(-5);
  });
});

describe("subtract", () => {
  test("subtracts two positive numbers", () => {
    expect(subtract(5, 3)).toBe(2);
  });

  test("subtracting a larger number yields a negative result", () => {
    expect(subtract(3, 5)).toBe(-2);
  });
});

describe("multiply", () => {
  test("multiplies two positive numbers", () => {
    expect(multiply(4, 3)).toBe(12);
  });

  test("multiplying by zero returns zero", () => {
    expect(multiply(4, 0)).toBe(0);
  });
});

describe("divide", () => {
  test("divides two positive numbers", () => {
    expect(divide(10, 2)).toBe(5);
  });

  test("dividing by zero throws an error", () => {
    expect(() => divide(10, 0)).toThrow("Division by zero");
  });
});
