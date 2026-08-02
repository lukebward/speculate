/**
 * Render captured ANSI terminal output (the live demo run) into an animated
 * SVG for the README: a terminal window whose lines reveal on a timeline
 * paced by the latencies the demo actually measured and printed.
 * Self-contained — GitHub renders SVG animations inside <img>.
 *
 * Usage: node scripts/gen-demo-svg.mjs <ansi-text-file> <out.svg>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: gen-demo-svg.mjs <ansi-text-file> <out.svg>');
  process.exit(2);
}

const COLORS = {
  default: '#e6edf3',
  dim: '#8b949e',
  bold: '#e6edf3',
  green: '#3fb950',
  yellow: '#d29922',
  cyan: '#39c5cf',
};

/** Parse one line of ANSI text into colored spans. */
function parseAnsi(line) {
  const spans = [];
  let color = 'default';
  let bold = false;
  let buf = '';
  const flush = () => {
    if (buf) spans.push({ text: buf, color, bold });
    buf = '';
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end === -1) break;
      flush();
      for (const code of line.slice(i + 2, end).split(';')) {
        switch (code) {
          case '0': case '': color = 'default'; bold = false; break;
          case '1': bold = true; break;
          case '2': color = 'dim'; break;
          case '32': color = 'green'; break;
          case '33': color = 'yellow'; break;
          case '36': color = 'cyan'; break;
          default: break;
        }
      }
      i = end;
      continue;
    }
    buf += line[i];
  }
  flush();
  return spans;
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const raw = readFileSync(inPath, 'utf8').split('\n');
// Drop npm's run banner; keep everything from the title line on.
const start = raw.findIndex((l) => l.includes('Speculate demo'));
const lines = raw.slice(start === -1 ? 0 : start).map(parseAnsi);
while (lines.length && lines[lines.length - 1].every((s) => !s.text.trim())) lines.pop();

// Timeline: each tool-call line waits for the latency it reports (capped
// for watchability), so the animation replays the run's real pacing and
// the prefetched call visibly lands the instant it is asked for.
let t = 0;
const delays = lines.map((spans) => {
  const text = spans.map((s) => s.text).join('');
  const dur = /(\d+(?:\.\d+)?) (ms|s)\b/.exec(text);
  if (dur) t += 0.35 + Math.min(dur[2] === 'ms' ? Number(dur[1]) / 1000 : Number(dur[1]), 1.6);
  else if (text.trim() === '') t += 0.08;
  else t += 0.45;
  return t;
});

const FONT = 13;
const LINE_H = 19;
const PAD = 16;
const HEADER = 34;
const W = 780;
const H = HEADER + PAD * 2 + lines.length * LINE_H;

let body = '';
lines.forEach((spans, i) => {
  const y = HEADER + PAD + (i + 1) * LINE_H - 5;
  let x = PAD;
  let tspans = '';
  for (const s of spans) {
    const fill = COLORS[s.color] ?? COLORS.default;
    const weight = s.bold ? ' font-weight="600"' : '';
    tspans += `<tspan x="${x}" fill="${fill}"${weight} xml:space="preserve">${esc(s.text)}</tspan>`;
    x += s.text.length * (FONT * 0.602);
  }
  if (tspans) {
    body += `<text class="l" style="animation-delay:${delays[i].toFixed(2)}s" y="${y}" font-size="${FONT}">${tspans}</text>\n`;
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<style>
  .l { opacity: 0; animation: reveal 0.15s ease-out forwards; }
  @keyframes reveal { to { opacity: 1; } }
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117" stroke="#30363d"/>
<rect width="${W}" height="${HEADER}" rx="10" fill="#161b22"/>
<rect y="${HEADER - 10}" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="${HEADER / 2}" r="5.5" fill="#ff5f57"/>
<circle cx="40" cy="${HEADER / 2}" r="5.5" fill="#febc2e"/>
<circle cx="60" cy="${HEADER / 2}" r="5.5" fill="#28c840"/>
<text x="${W / 2}" y="${HEADER / 2 + 4}" text-anchor="middle" font-size="12" fill="#8b949e">npm run demo</text>
${body}</svg>
`;

writeFileSync(outPath, svg);
console.log(`wrote ${outPath} (${lines.length} lines, ${H}px, ~${t.toFixed(1)}s timeline)`);
