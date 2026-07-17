/**
 * reputation score.ts pure unit tests
 * Tests computeScore with various rating inputs
 */

import { describe, it, expect } from 'vitest';
import { computeScore } from '../src/score.js';
import type { Rating } from '../src/score.js';

const NOW = 1_750_000_000_000; // fixed reference timestamp (ms)

function rating(score: number, ageMs = 0): Rating {
  return { score, timestamp: NOW - ageMs };
}

describe('computeScore', () => {
  it('returns null scores and low confidence when < 3 ratings', () => {
    const result = computeScore([rating(5), rating(6)], NOW);
    expect(result.averageScore).toBeNull();
    expect(result.weightedScore).toBeNull();
    expect(result.totalRatings).toBe(2);
    expect(result.confidence).toBe('low');
  });

  it('returns null for zero ratings', () => {
    const result = computeScore([], NOW);
    expect(result.averageScore).toBeNull();
    expect(result.totalRatings).toBe(0);
  });

  it('computes average score with >= 3 ratings', () => {
    const result = computeScore([rating(4), rating(6), rating(8)], NOW);
    expect(result.averageScore).toBe(6);
    expect(result.weightedScore).toBe(6);
    expect(result.totalRatings).toBe(3);
    expect(result.confidence).toBe('low');
  });

  it('applies time decay weights', () => {
    const ratings = [
      rating(10, 0),           // fresh: weight 1.0
      rating(0, 91 * 24 * 3600_000),  // old: weight 0.5
      rating(0, 91 * 24 * 3600_000),  // old: weight 0.5
    ];
    const result = computeScore(ratings, NOW);
    // weighted = (10*1 + 0*0.5 + 0*0.5) / (1 + 0.5 + 0.5) = 10/2 = 5
    expect(result.weightedScore).toBe(5);
    // average = (10 + 0 + 0) / 3 = 3.33
    expect(result.averageScore).toBe(3.33);
  });

  it('medium confidence at 5+ ratings', () => {
    const ratings = [rating(5), rating(5), rating(5), rating(5), rating(5)];
    const result = computeScore(ratings, NOW);
    expect(result.confidence).toBe('medium');
  });

  it('high confidence at 10+ ratings', () => {
    const ratings = Array(10).fill(rating(7));
    const result = computeScore(ratings, NOW);
    expect(result.confidence).toBe('high');
  });

  it('caps recentRatings at 10', () => {
    const ratings = Array(15).fill(0).map((_, i) => rating(i, i * 1000));
    const result = computeScore(ratings, NOW);
    expect(result.recentRatings.length).toBe(10);
  });

  it('sorts recentRatings by timestamp descending', () => {
    const ratings = [
      rating(1, 10000),
      rating(2, 5000),
      rating(3, 0),
    ];
    const result = computeScore(ratings, NOW);
    expect(result.recentRatings[0].score).toBe(3);
    expect(result.recentRatings[1].score).toBe(2);
    expect(result.recentRatings[2].score).toBe(1);
  });

  it('rounds scores to 2 decimal places', () => {
    const result = computeScore([rating(1), rating(1), rating(2)], NOW);
    expect(result.averageScore).toBe(1.33);
    expect(result.weightedScore).toBe(1.33);
  });
});
