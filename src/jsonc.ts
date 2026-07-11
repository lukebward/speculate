/**
 * Tolerant JSON for config files: `//` and `/* *\/` comments plus trailing
 * commas, stripped with a small state machine that respects string
 * literals. Everything else remains strict JSON.parse.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue; // keep the newline for line numbers in error messages
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      // Trailing comma: skip if the next non-whitespace/non-comment char
      // closes the container.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < text.length && text[j] !== '\n') j++;
          continue;
        }
        if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (text[j] === '}' || text[j] === ']') {
        i++; // drop the comma; the closer is emitted on later iterations
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
