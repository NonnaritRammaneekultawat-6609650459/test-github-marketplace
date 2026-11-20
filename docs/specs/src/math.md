# Specification: src/math.js

Applies to: src/math.js

## Shared input rules
- Every argument to an exported function must be a JavaScript number and finite.
- A non-number or NaN input throws TypeError with the message `Inputs must be valid numbers`.
- Positive or negative Infinity throws TypeError with the message `Inputs must be finite numbers`.

## Exported functions
- `add(a, b)` returns `a + b`.
- `subtract(a, b)` returns `a - b` and normalizes negative zero to positive zero.
- `multiply(a, b)` returns `a * b` and normalizes negative zero to positive zero.
- `divide(a, b)` returns `a / b`; when `b` is zero (including negative zero), it throws Error with the message `Cannot divide by zero`. Its result is normalized so negative zero becomes positive zero.
- `calculatePercentage(value, total)` returns `(value / total) * 100`. When `total` is zero (including negative zero), it returns 0. Its result is normalized so negative zero becomes positive zero.
- `modulo(a, b)` uses `((a % b) + b) % b`. When `b` is zero (including negative zero), it throws Error with the message `Cannot modulo by zero`. Its result is normalized so negative zero becomes positive zero. For positive divisors, the result is in the range from 0 inclusive to `b` exclusive.

## Test cases to cover
- Typical positive, negative, and zero operands for every exported function.
- Decimal operands and negative operands for modulo, including `modulo(-7, 4) === 1`.
- Division and modulo by both positive zero and negative zero.
- Zero total in `calculatePercentage`.
- Invalid string, null, undefined, NaN, and positive/negative Infinity arguments.
- Verify normalized zero results with `Object.is(result, -0) === false` where normalization is specified.
- Verify every exported function is callable from the module exports.
