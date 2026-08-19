import { describe, it, expect } from 'vitest';
import { Either } from 'effect';

describe('Either (Effect)', () => {
  describe('Either.right()', () => {
    it('creates a Right result', () => {
      const result = Either.right(42);

      expect(Either.isRight(result)).toBe(true);
      expect(Either.isLeft(result)).toBe(false);
      if (Either.isRight(result)) {
        expect(result.right).toBe(42);
      }
    });

    it('works with void value', () => {
      const result = Either.right(undefined);

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right).toBeUndefined();
      }
    });

    it('works with complex values', () => {
      const value = { id: '123', data: ['a', 'b'] };
      const result = Either.right(value);

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right).toEqual(value);
      }
    });
  });

  describe('Either.left()', () => {
    it('creates a Left result', () => {
      const error = new Error('Something went wrong');
      const result = Either.left(error);

      expect(Either.isRight(result)).toBe(false);
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBe(error);
      }
    });

    it('works with any error type', () => {
      const result = Either.left('string error');

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBe('string error');
      }
    });
  });

  describe('Type narrowing', () => {
    it('narrows Right type with isRight check', () => {
      const result: Either.Either<number, Error> = Either.right(42);

      if (Either.isRight(result)) {
        const value: number = result.right;
        expect(value).toBe(42);
      }
    });

    it('narrows Left type with isLeft check', () => {
      const result: Either.Either<number, Error> = Either.left(new Error('Failed'));

      if (Either.isLeft(result)) {
        const error: Error = result.left;
        expect(error.message).toBe('Failed');
      }
    });

    it('can be used in if-else for exhaustive handling', () => {
      function process(result: Either.Either<number, Error>): string {
        if (Either.isRight(result)) {
          return `Success: ${result.right}`;
        } else {
          return `Error: ${result.left.message}`;
        }
      }

      expect(process(Either.right(42))).toBe('Success: 42');
      expect(process(Either.left(new Error('Failed')))).toBe('Error: Failed');
    });
  });

  describe('Use cases', () => {
    it('works with handler return type', () => {
      function handler(value: number): Either.Either<void, Error> {
        if (value < 0) {
          return Either.left(new Error('Value must be positive'));
        }
        return Either.right(undefined);
      }

      const successResult = handler(5);
      expect(Either.isRight(successResult)).toBe(true);

      const errorResult = handler(-1);
      expect(Either.isLeft(errorResult)).toBe(true);
      if (Either.isLeft(errorResult)) {
        expect(errorResult.left.message).toBe('Value must be positive');
      }
    });

    it('forces explicit error handling at compile-time', () => {
      function mayFail(): Either.Either<string, Error> {
        return Either.right('success');
      }

      // This forces you to handle both cases
      const result = mayFail();
      let output: string;

      if (Either.isRight(result)) {
        output = result.right;
      } else {
        output = `Error: ${result.left.message}`;
      }

      expect(output).toBe('success');
    });
  });
});
