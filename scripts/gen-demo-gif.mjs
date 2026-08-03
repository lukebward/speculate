/**
 * Render captured ANSI terminal output (the live demo run) into an animated
 * GIF for the README.
 *
 * One keyframe per revealed line rather than a fixed frame rate: the reveal is
 * a step function, so ~9 frames with explicit durations reproduce the timing
 * exactly and keep the file small. Frames come from the SAME renderer the SVG
 * uses (scripts/demo-render.mjs), so the two assets cannot disagree.
 *
 * Needs ffmpeg on PATH. Only ever run by hand to refresh the asset, never by
 * the test suite or CI.
 *
 * Usage: node scripts/gen-demo-gif.mjs <ansi-text-file> <out.gif>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCapture, renderSvg, GEOM } from './demo-render.mjs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: gen-demo-gif.mjs <ansi-text-file> <out.gif>');
  process.exit(2);
}

let Resvg;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch {
  console.error("gen-demo-gif: missing rasterizer. Run: npm install -D @resvg/resvg-js");
  process.exit(2);
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('gen-demo-gif: ffmpeg is not on PATH (needed to encode the GIF)');
  process.exit(2);
}

/** How long the finished frame sits before the loop restarts. */
const HOLD_S = 2.2;
/** Rendered at 2x and downscaled, so the text is not soft on HiDPI screens. */
const SCALE = 2;

const model = parseCapture(readFileSync(inPath, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'speculate-gif-'));
try {
  // Frame i shows the first i lines. Frame 0 is the bare terminal chrome, so
  // the loop always restarts from empty rather than snapping mid-run.
  const durations = [];
  for (let i = 0; i <= model.lines.length; i++) {
    const svg = renderSvg(model, { visible: i });
    const png = new Resvg(svg, {
      // Fills the rounded corners with the panel colour. GIF has only 1-bit
      // transparency, and leaving it on fringes the rounded edges.
      background: '#0d1117',
      fitTo: { mode: 'width', value: GEOM.W * SCALE },
      font: { loadSystemFonts: true },
    })
      .render()
      .asPng();
    writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.png`), png);
    const prev = i === 0 ? 0 : model.delays[i - 1];
    durations.push(i === model.lines.length ? HOLD_S : Math.max(0.06, model.delays[i] - prev));
  }

  // concat demuxer: per-frame durations, and the last entry repeated because
  // it otherwise ignores the final `duration`.
  const list = durations
    .map((d, i) => `file 'f${String(i).padStart(3, '0')}.png'\nduration ${d.toFixed(3)}`)
    .join('\n');
  const lastFrame = `f${String(model.lines.length).padStart(3, '0')}.png`;
  writeFileSync(join(dir, 'frames.txt'), `${list}\nfile '${lastFrame}'\n`);

  // Two passes so the palette is chosen from the whole animation.
  //
  // `stats_mode=full`, not `diff`: diff weights the palette toward pixels that
  // CHANGE between frames, and on this animation that starved the body text —
  // near-white #e6edf3 got merged into the amber titlebar dot and rendered
  // #ffc534. Verified by sampling the encoded GIF, not by eye.
  //
  // A full 256 colours for the same reason: the source has only ~10 flat
  // colours, but 2x supersampling means every glyph edge is a blend of two of
  // them, and squeezing those out is what pushes a whole run of text off-hue.
  // dither=none because flat-coloured text only gains speckle from dithering.
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', 'frames.txt',
      '-filter_complex',
      `scale=${GEOM.W}:-1:flags=lanczos,split[a][b];` +
        `[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];` +
        `[b][p]paletteuse=dither=none`,
      '-loop', '0',
      outPath,
    ],
    { cwd: dir, stdio: 'inherit' },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const bytes = readFileSync(outPath).length;
console.log(
  `wrote ${outPath} (${model.lines.length} lines, ${model.H}px, ` +
    `~${(model.total + HOLD_S).toFixed(1)}s loop, ${(bytes / 1024).toFixed(1)} KB)`,
);
