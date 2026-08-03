/**
 * Shared model for the README demo assets.
 *
 * Both generators (SVG and GIF) read the SAME captured run through here, so
 * the two assets cannot drift into showing different numbers or different
 * pacing. The only difference between them is how the reveal is expressed:
 * the SVG animates with CSS, the GIF is rasterized one keyframe per reveal.
 */

const COLORS = {
  default: '#e6edf3',
  dim: '#8b949e',
  bold: '#e6edf3',
  green: '#3fb950',
  yellow: '#d29922',
  cyan: '#39c5cf',
};

export const GEOM = { FONT: 13, LINE_H: 19, PAD: 16, HEADER: 34, W: 780 };

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

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Captured demo output -> the lines to draw and when each appears.
 *
 * Each tool-call line waits for the latency it reports (capped for
 * watchability), so the animation replays the run's real pacing and the
 * prefetched call visibly lands the instant it is asked for.
 */
export function parseCapture(text) {
  const raw = text.split('\n');
  // Drop npm's run banner; keep everything from the title line on.
  const start = raw.findIndex((l) => l.includes('Speculate demo'));
  const lines = raw.slice(start === -1 ? 0 : start).map(parseAnsi);
  while (lines.length && lines[lines.length - 1].every((s) => !s.text.trim())) lines.pop();

  let t = 0;
  const delays = lines.map((spans) => {
    const joined = spans.map((s) => s.text).join('');
    const dur = /(\d+(?:\.\d+)?) (ms|s)\b/.exec(joined);
    if (dur) t += 0.35 + Math.min(dur[2] === 'ms' ? Number(dur[1]) / 1000 : Number(dur[1]), 1.6);
    else if (joined.trim() === '') t += 0.08;
    else t += 0.45;
    return t;
  });

  const H = GEOM.HEADER + GEOM.PAD * 2 + lines.length * GEOM.LINE_H;
  return { lines, delays, H, total: t };
}

/**
 * The terminal window as SVG.
 *
 * `visible` renders a STILL: only the first N lines are drawn, and no CSS is
 * emitted. That is what the GIF rasterizes, one frame per reveal. Omitting it
 * renders the animated version, where every line is present from the start and
 * CSS fades it in on schedule.
 */
export function renderSvg(model, { visible } = {}) {
  const { FONT, LINE_H, PAD, HEADER, W } = GEOM;
  const still = visible !== undefined;
  const shown = still ? model.lines.slice(0, visible) : model.lines;

  let body = '';
  shown.forEach((spans, i) => {
    const y = HEADER + PAD + (i + 1) * LINE_H - 5;
    let x = PAD;
    let tspans = '';
    for (const s of spans) {
      const fill = COLORS[s.color] ?? COLORS.default;
      const weight = s.bold ? ' font-weight="600"' : '';
      tspans += `<tspan x="${x}" fill="${fill}"${weight} xml:space="preserve">${esc(s.text)}</tspan>`;
      x += s.text.length * (FONT * 0.602);
    }
    if (!tspans) return;
    const anim = still ? '' : ` class="l" style="animation-delay:${model.delays[i].toFixed(2)}s"`;
    body += `<text${anim} y="${y}" font-size="${FONT}">${tspans}</text>\n`;
  });

  const style = still
    ? ''
    : `<style>
  .l { opacity: 0; animation: reveal 0.15s ease-out forwards; }
  @keyframes reveal { to { opacity: 1; } }
</style>
`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${model.H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
${style}<rect width="${W}" height="${model.H}" rx="10" fill="#0d1117" stroke="#30363d"/>
<rect width="${W}" height="${HEADER}" rx="10" fill="#161b22"/>
<rect y="${HEADER - 10}" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="${HEADER / 2}" r="5.5" fill="#ff5f57"/>
<circle cx="40" cy="${HEADER / 2}" r="5.5" fill="#febc2e"/>
<circle cx="60" cy="${HEADER / 2}" r="5.5" fill="#28c840"/>
<text x="${W / 2}" y="${HEADER / 2 + 4}" text-anchor="middle" font-size="12" fill="#8b949e">npm run demo</text>
${body}</svg>
`;
}
