/**
 * Pure Solidity source-code analysis utilities.
 * No side effects — safe to import in unit tests.
 */

export interface Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  description: string;
  line: number;
}

export function findLine(source: string, pattern: string): number {
  const idx = source.indexOf(pattern);
  if (idx === -1) return 0;
  return source.slice(0, idx).split('\n').length;
}

export function hasStateChangingFunctions(source: string): boolean {
  const funcPattern = /\bfunction\s+\w+\s*\([^)]*\)\s*([\s\S]*?)\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(source)) !== null) {
    const signature = match[0];
    if (/\bexternal\b/.test(signature) || /\bpublic\b/.test(signature)) {
      if (!/\bview\b/.test(signature) && !/\bpure\b/.test(signature)) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeSolidity(source: string): Finding[] {
  const findings: Finding[] = [];

  if (source.includes('selfdestruct')) {
    findings.push({
      severity: 'high',
      description: 'Contains selfdestruct — contract can be destroyed, potentially losing all funds',
      line: findLine(source, 'selfdestruct'),
    });
  }

  if (source.includes('tx.origin')) {
    findings.push({
      severity: 'high',
      description: 'Uses tx.origin for authorization — vulnerable to phishing attacks',
      line: findLine(source, 'tx.origin'),
    });
  }

  if (source.includes('call{value:') || source.includes('call{ value:')) {
    findings.push({
      severity: 'high',
      description: 'Contains low-level call with value — potentially unchecked external call that could drain funds',
      line: findLine(source, 'call{'),
    });
  }

  if (source.includes('delegatecall')) {
    findings.push({
      severity: 'medium',
      description: 'Contains delegatecall — can execute arbitrary code in contract context',
      line: findLine(source, 'delegatecall'),
    });
  }

  if (source.includes('bytes calldata') && /\bexternal\b/.test(source)) {
    findings.push({
      severity: 'medium',
      description: 'Accepts arbitrary bytes calldata in external function — could enable unauthorized calls',
      line: findLine(source, 'bytes calldata'),
    });
  }

  if (source.includes('assembly')) {
    findings.push({
      severity: 'medium',
      description: 'Contains inline assembly block — bypasses Solidity safety checks and type system',
      line: findLine(source, 'assembly'),
    });
  }

  if (!source.includes('nonReentrant') && hasStateChangingFunctions(source)) {
    findings.push({
      severity: 'medium',
      description: 'Missing nonReentrant modifier on state-changing external/public functions — vulnerable to reentrancy attacks',
      line: 0,
    });
  }

  if (/\bblock\.timestamp\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses block.timestamp — can be manipulated by miners within ~15 seconds',
      line: findLine(source, 'block.timestamp'),
    });
  }

  if (/\bblockhash\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses blockhash for randomness — predictable and manipulable',
      line: findLine(source, 'blockhash'),
    });
  }

  if (source.includes('onlyOwner')) {
    findings.push({
      severity: 'low',
      description: 'Uses onlyOwner modifier — centralized control risk',
      line: findLine(source, 'onlyOwner'),
    });
  }

  if (/\btransfer\s*\(/.test(source) || /\.transfer\(/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses .transfer() for ETH — fixed 2300 gas stipend may fail with evolving gas costs',
      line: findLine(source, 'transfer('),
    });
  }

  if (/\bextcodesize\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses extcodesize to check if address is a contract — unreliable (contract in constructor returns 0)',
      line: findLine(source, 'extcodesize'),
    });
  }

  const dcCount = (source.match(/delegatecall/g) || []).length;
  if (dcCount >= 2) {
    findings.push({
      severity: 'info',
      description: `Possible proxy pattern detected (${dcCount} delegatecall uses)`,
      line: 0,
    });
  }

  const order: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return findings;
}

const severityScore: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0.5,
};

export function calculateRiskScore(findings: Finding[]): number {
  const raw = findings.reduce((sum, f) => sum + (severityScore[f.severity] ?? 0), 0);
  return Math.min(raw, 10);
}

export function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings detected';
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
