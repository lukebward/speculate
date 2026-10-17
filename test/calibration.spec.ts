import { describe, expect, it } from 'vitest';
import {
  CandidateCalibrator,
  mergeCandidateFeedbackSnapshots,
} from '../src/calibration.js';

const DAY = 24 * 60 * 60_000;

describe('CandidateCalibrator', () => {
  it('uses static confidence as a four-observation prior', () => {
    const calibrator = new CandidateCalibrator({ now: () => 0 });
    expect(calibrator.probability('r', 0.75)).toEqual({
      probability: 0.75,
      observations: 0,
      source: 'prior',
    });
    calibrator.observe('r', false);
    expect(calibrator.probability('r', 0.75).probability).toBeCloseTo(3 / 5);
    calibrator.observe('r', true);
    expect(calibrator.probability('r', 0.75).probability).toBeCloseTo(4 / 6);
  });

  it('lets consistently different alternatives diverge', () => {
    const calibrator = new CandidateCalibrator({ now: () => 0 });
    for (let i = 0; i < 12; i++) {
      calibrator.observe('rule#2', false);
      calibrator.observe('rule#3', true);
    }
    expect(calibrator.probability('rule#3', 0.5).probability).toBeGreaterThan(0.8);
    expect(calibrator.probability('rule#2', 0.5).probability).toBeLessThan(0.2);
  });

  it('decays observations over the existing feedback horizon', () => {
    let now = 0;
    const calibrator = new CandidateCalibrator({ now: () => now });
    calibrator.observe('r', true);
    now = 14 * DAY;
    expect(calibrator.probability('r', 0.5).observations).toBeCloseTo(Math.exp(-1));
  });

  it('imports defensively without becoming dirty', () => {
    const calibrator = new CandidateCalibrator({ now: () => 10 });
    calibrator.importState({
      good: { correct: 2, evaluated: 3, lastUpdated: 10 },
      impossible: { correct: 4, evaluated: 3, lastUpdated: 10 },
      broken: 'nope',
    });
    expect(calibrator.revision).toBe(0);
    expect(Object.keys(calibrator.exportState())).toEqual(['good']);
  });
});

describe('mergeCandidateFeedbackSnapshots', () => {
  it('adds only feedback accrued since a shared baseline', () => {
    const baseline = { r: { correct: 3, evaluated: 5, lastUpdated: 0 } };
    const existing = { r: { correct: 4, evaluated: 6, lastUpdated: 0 } };
    const incoming = { r: { correct: 3, evaluated: 7, lastUpdated: 0 } };
    expect(mergeCandidateFeedbackSnapshots(existing, incoming, baseline, 0).r).toMatchObject({
      correct: 4,
      evaluated: 8,
    });
  });

  it('unions disjoint candidate identities', () => {
    const merged = mergeCandidateFeedbackSnapshots(
      { a: { correct: 1, evaluated: 1, lastUpdated: 0 } },
      { b: { correct: 0, evaluated: 1, lastUpdated: 0 } },
      undefined,
      0,
    );
    expect(Object.keys(merged)).toEqual(['a', 'b']);
  });
});
