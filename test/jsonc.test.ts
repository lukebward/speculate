/**
 * jsonc.ts tests: comment stripping (`//`, block), string-literal safety,
 * trailing-comma tolerance, and strictness for everything else.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonc, stripJsonComments } from '../src/jsonc.js';

describe('plain JSON passes through', () => {
  it('leaves comment-free JSON byte-for-byte unchanged', () => {
    const text = '{\n  "a": 1,\n  "b": [true, null, "x"],\n  "c": {"d": 2.5}\n}';
    expect(stripJsonComments(text)).toBe(text);
    expect(parseJsonc(text)).toEqual({ a: 1, b: [true, null, 'x'], c: { d: 2.5 } });
  });

  it('keeps a non-trailing comma intact', () => {
    expect(parseJsonc('[1, 2]')).toEqual([1, 2]);
  });
});

describe('// line comments', () => {
  it('strips a line comment and keeps the newline', () => {
    expect(stripJsonComments('{\n"a": 1 // count\n}')).toBe('{\n"a": 1 \n}');
    expect(parseJsonc('{\n"a": 1 // count\n}')).toEqual({ a: 1 });
  });

  it('strips a line comment at EOF without a trailing newline', () => {
    expect(stripJsonComments('{"a":1} // tail')).toBe('{"a":1} ');
    expect(parseJsonc('{"a":1} // tail')).toEqual({ a: 1 });
  });
});

describe('/* block */ comments', () => {
  it('strips an inline block comment', () => {
    expect(stripJsonComments('{"a": /*x*/ 1}')).toBe('{"a":  1}');
    expect(parseJsonc('{"a": /*x*/ 1}')).toEqual({ a: 1 });
  });

  it('strips a multiline block comment', () => {
    const text = '{\n/* line one\n   line two\n*/\n"a": 1\n}';
    expect(parseJsonc(text)).toEqual({ a: 1 });
  });

  it('terminates on an unterminated block comment at EOF (no hang, comment dropped)', () => {
    expect(stripJsonComments('{"a":1} /* never closed')).toBe('{"a":1} ');
    expect(parseJsonc('{"a":1} /* never closed')).toEqual({ a: 1 });
  });
});

describe('comment-lookalikes inside strings', () => {
  it('preserves //, /* */ and URLs inside string literals', () => {
    const text = '{"url":"http://x","path":"a//b","glob":"/*not*/"}';
    expect(stripJsonComments(text)).toBe(text);
    expect(parseJsonc(text)).toEqual({ url: 'http://x', path: 'a//b', glob: '/*not*/' });
  });

  it('handles escaped quotes: the string does not end early and its // survives', () => {
    const text = '{"q":"she said \\"hi\\" // ok","n":1}';
    expect(stripJsonComments(text)).toBe(text);
    expect(parseJsonc(text)).toEqual({ q: 'she said "hi" // ok', n: 1 });
  });
});

describe('trailing commas', () => {
  it('drops a trailing comma in an object', () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 });
  });

  it('drops a trailing comma in an array', () => {
    expect(parseJsonc('[1,2,]')).toEqual([1, 2]);
  });

  it('drops a trailing comma with a line comment between comma and closer', () => {
    expect(parseJsonc('{"a":1, // done\n}')).toEqual({ a: 1 });
  });

  it('drops a trailing comma with a block comment between comma and closer', () => {
    expect(parseJsonc('[1, 2, /* pad */ ]')).toEqual([1, 2]);
  });

  it('drops a trailing comma with mixed comments and whitespace before the closer', () => {
    expect(parseJsonc('{"a":1, // x\n /* y */ }')).toEqual({ a: 1 });
  });

  it('drops nested trailing commas', () => {
    expect(parseJsonc('{"a": [1, {"b": 2,},], "c": {"d": [],},}')).toEqual({
      a: [1, { b: 2 }],
      c: { d: [] },
    });
  });
});

describe('realistic config', () => {
  it('parses a commented speculate-style config to the expected object', () => {
    const text = `{
  // Speculate proxy configuration.
  "mode": "annotated", /* strict|annotated|off */
  "maxPredictionsPerTrigger": 3,
  "servers": {
    "github": {
      "command": "github-mcp-server", // resolved on PATH
      "args": ["stdio"],
      "url": "http://localhost:8080", // lookalike inside a string
      "allowTools": [
        "list_issues",
        "get_issue", // trailing comma follows
      ],
    },
  },
  /* Decision log:
     JSONL on stderr. */
  "log": "stderr",
}`;
    expect(parseJsonc(text)).toEqual({
      mode: 'annotated',
      maxPredictionsPerTrigger: 3,
      servers: {
        github: {
          command: 'github-mcp-server',
          args: ['stdio'],
          url: 'http://localhost:8080',
          allowTools: ['list_issues', 'get_issue'],
        },
      },
      log: 'stderr',
    });
  });
});

describe('genuinely invalid JSON still throws', () => {
  it('throws on a missing value', () => {
    expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError);
  });

  it('throws on unquoted keys', () => {
    expect(() => parseJsonc('{a: 1}')).toThrow(SyntaxError);
  });

  it('throws on a missing comma between elements', () => {
    expect(() => parseJsonc('[1 2]')).toThrow(SyntaxError);
  });

  it('throws on an unterminated string even when it contains //', () => {
    expect(() => parseJsonc('{"a": "no end // ')).toThrow(SyntaxError);
  });
});
