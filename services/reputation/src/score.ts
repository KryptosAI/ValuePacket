export interface Rating {
  score: number;
  timestamp: number;
}

export interface ReputationScore {
  averageScore: number | null;
  weightedScore: number | null;
  totalRatings: number;
  recentRatings: Rating[];
  confidence: 'low' | 'medium' | 'high';
}

const DECAY_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
const FRESH_WEIGHT = 1.0;
const DECAYED_WEIGHT = 0.5;
const MIN_RATINGS = 3;

function computeWeight(timestamp: number, now: number): number {
  return now - timestamp < DECAY_THRESHOLD_MS ? FRESH_WEIGHT : DECAYED_WEIGHT;
}

function computeConfidence(count: number): ReputationScore['confidence'] {
  if (count >= 10) return 'high';
  if (count >= 5) return 'medium';
  return 'low';
}

export function computeScore(ratings: Rating[], now: number = Date.now()): ReputationScore {
  const sorted = [...ratings].sort((a, b) => b.timestamp - a.timestamp);

  const totalRatings = sorted.length;

  if (totalRatings < MIN_RATINGS) {
    return {
      averageScore: null,
      weightedScore: null,
      totalRatings,
      recentRatings: sorted.slice(0, 10),
      confidence: 'low',
    };
  }

  const rawSum = sorted.reduce((sum, r) => sum + r.score, 0);
  const averageScore = rawSum / totalRatings;

  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of sorted) {
    const w = computeWeight(r.timestamp, now);
    weightedSum += r.score * w;
    totalWeight += w;
  }
  const weightedScore = totalWeight > 0 ? weightedSum / totalWeight : averageScore;

  return {
    averageScore: Math.round(averageScore * 100) / 100,
    weightedScore: Math.round(weightedScore * 100) / 100,
    totalRatings,
    recentRatings: sorted.slice(0, 10),
    confidence: computeConfidence(totalRatings),
  };
}
