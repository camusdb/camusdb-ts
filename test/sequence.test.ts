import { describe, expect, it } from 'vitest';

import {
  createSequenceStatement,
  dropSequenceStatement,
  nextValueExpression,
  selectNextValueStatement,
} from '../src/sequence.js';

describe('sequence statements', () => {
  it('composes a bare CREATE SEQUENCE', () => {
    expect(createSequenceStatement('s')).toBe('CREATE SEQUENCE `s`');
  });

  it('composes every option in the order the server reads them', () => {
    expect(
      createSequenceStatement('s', {
        ifNotExists: true,
        startWith: 10n,
        incrementBy: 2,
        minValue: 5,
        maxValue: 9_223_372_036_854_775_807n,
      }),
    ).toBe(
      'CREATE SEQUENCE IF NOT EXISTS `s` START WITH 10 INCREMENT BY 2 MINVALUE 5 MAXVALUE 9223372036854775807',
    );
  });

  it('refuses an increment that is not positive', () => {
    expect(() => createSequenceStatement('s', { incrementBy: 0 })).toThrow(/positive increment/);
    expect(() => createSequenceStatement('s', { incrementBy: -1n })).toThrow(TypeError);
  });

  it('refuses a value that is not a safe integer', () => {
    expect(() => createSequenceStatement('s', { startWith: 1.5 })).toThrow(/startWith/);
    expect(() => createSequenceStatement('s', { maxValue: 2 ** 60 })).toThrow(/maxValue/);
  });

  it('refuses a name that cannot be delimited', () => {
    expect(() => createSequenceStatement('a`b')).toThrow(TypeError);
    expect(() => dropSequenceStatement('')).toThrow(TypeError);
    expect(() => nextValueExpression('a`b')).toThrow(TypeError);
  });

  it('composes DROP SEQUENCE', () => {
    expect(dropSequenceStatement('s')).toBe('DROP SEQUENCE `s`');
    expect(dropSequenceStatement('s', { ifExists: true })).toBe('DROP SEQUENCE IF EXISTS `s`');
  });

  it('quotes the sequence name as a literal in nextval', () => {
    expect(nextValueExpression("o'brien")).toBe("nextval('o''brien')");
    expect(selectNextValueStatement('s')).toBe("SELECT nextval('s')");
  });
});
