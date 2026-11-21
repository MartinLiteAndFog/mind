// Legacy import of the original pilot data is not part of the public package.
import type { GraphState } from './model.ts';

export interface LegacySeed {
  nodes: Record<string, [string, string, string]>;
  links: { origin: string; target: string; relation: string; source: string }[];
  runs: { key: string; variant: string; period: string; end: number; drawdown: number; source: string }[];
  sources: Record<string, [string, string, string]>;
}

export function buildSeedState(_seed?: LegacySeed): GraphState {
  throw new Error('Legacy seed import is not available in this package.');
}
