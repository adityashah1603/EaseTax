// Map a return line to the tax_effect_rates category it moves (DECISIONS D-08).
// The engine cannot be rerun, so a change's effect is estimated as
//   Δ (dollars) × sign × rate[category]   per jurisdiction,
// with credits and payments applied 1:1. Lines we can't map are "not estimable".

export type EffectKind = 'rate' | 'credit' | 'payment' | 'none';

export interface LineEffectMapping {
  kind: EffectKind;
  category?: string;
  /** +1 when the line increases the category's base (income), -1 when it reduces it (expense). */
  sign: number;
  /** Multiplier from the line's unit to dollars. */
  scale: number;
  jurisdiction?: 'federal' | 'california';
  note?: string;
}

const NONE: LineEffectMapping = { kind: 'none', sign: 0, scale: 1 };

const SCHC_INCOME = new Set(['1', '3', '4', '5', '6', '7', '29', '31']);
const SHORT_8949_BOXES = new Set(['A', 'B', 'C', 'G', 'H', 'I']);

export function mapLineToEffect(key: string): LineEffectMapping {
  const dot = key.indexOf('.');
  if (dot < 0) return NONE;
  const form = key.slice(0, dot);
  const line = key.slice(dot + 1);

  switch (form) {
    case 'F1040':
      if (line === '1a' || line === '1z') return { kind: 'rate', category: 'wages', sign: 1, scale: 1 };
      if (['2b', '3b'].includes(line)) return { kind: 'rate', category: 'interest', sign: 1, scale: 1 };
      if (line === '19') return { kind: 'credit', sign: -1, scale: 1, jurisdiction: 'federal' };
      if (['25a', '25b', '25c', '25d', '26'].includes(line)) return { kind: 'payment', sign: -1, scale: 1, jurisdiction: 'federal' };
      return NONE;
    case 'SchB':
      return { kind: 'rate', category: 'interest', sign: 1, scale: 1 };
    case 'SchC':
      if (/^4[3-7]/.test(line) || ['I', 'J'].includes(line)) return NONE; // vehicle facts, yes/no
      return { kind: 'rate', category: 'schc_profit', sign: SCHC_INCOME.has(line) ? 1 : -1, scale: 1 };
    case 'F8949': {
      // Lot lines hold the lot's gain in dollars, to the cent (README's "in cents" means precision,
      // not unit: F8949.B.N1 = 19240.00 = proceeds 19,240.00 - basis 0). Box totals are lines too.
      const box = line.split('.')[0] ?? '';
      const cat = SHORT_8949_BOXES.has(box) ? 'stcg' : 'ltcg';
      return { kind: 'rate', category: cat, sign: 1, scale: 1 };
    }
    case 'SchD': {
      const n = parseFloat(line);
      if (Number.isNaN(n)) return NONE;
      return { kind: 'rate', category: n <= 7 ? 'stcg' : 'ltcg', sign: 1, scale: 1 };
    }
    case 'SchE':
      if (/^(1|2)[A-Z]$/.test(line)) return NONE; // property address, days
      if (/^3[A-Z]$/.test(line) || /^(21|22|26|28|32|41)/.test(line)) return { kind: 'rate', category: 'ordinary_income', sign: 1, scale: 1 };
      return { kind: 'rate', category: 'ordinary_income', sign: -1, scale: 1, note: 'Rental expense; passive-loss limits may absorb the change' };
    case 'Sch1': {
      const n = parseFloat(line);
      if (n >= 11 && n <= 26) return { kind: 'rate', category: 'adjustment', sign: 1, scale: 1 };
      return { kind: 'rate', category: 'ordinary_income', sign: 1, scale: 1 };
    }
    case 'SchA':
      if (line.startsWith('5')) return { kind: 'rate', category: 'salt', sign: 1, scale: 1 };
      return { kind: 'rate', category: 'itemized', sign: 1, scale: 1 };
    case 'Sch3':
      if (['1', '2', '3', '4', '5', '6', '7', '8'].some((p) => line === p || line.startsWith(p + '.'))) {
        return { kind: 'credit', sign: -1, scale: 1, jurisdiction: 'federal' };
      }
      return { kind: 'payment', sign: -1, scale: 1, jurisdiction: 'federal' };
    case 'F540NR':
      if (['71', '72', '73', '74', '75'].includes(line)) return { kind: 'payment', sign: -1, scale: 1, jurisdiction: 'california' };
      return NONE;
    case 'SchCA540NR':
      if (line.endsWith('.E')) return { kind: 'rate', category: 'ca_source_income', sign: 1, scale: 1 };
      return NONE;
    case 'F2441':
    case 'F8812':
    case 'F8863':
      return NONE; // credit lines whose effect depends on limits; the engine's what_if is authoritative
    default:
      return NONE;
  }
}

export interface EstimatedEffect {
  estimable: boolean;
  /** Change in total tax (positive = more tax). */
  federalTax: number;
  californiaTax: number;
  /** Change in balance due from payments (positive = more owed). */
  federalBalance: number;
  californiaBalance: number;
  basis: string;
  warnings: string[];
}

export function estimateEffect(
  key: string,
  oldValue: unknown,
  newValue: unknown,
  rates: Record<string, { federal_per_dollar: number; california_per_dollar: number }>,
  version: string,
): EstimatedEffect {
  const m = mapLineToEffect(key);
  const empty: EstimatedEffect = {
    estimable: false,
    federalTax: 0,
    californiaTax: 0,
    federalBalance: 0,
    californiaBalance: 0,
    basis: `Not estimable from ${version} rates`,
    warnings: [],
  };
  if (typeof oldValue !== 'number' || typeof newValue !== 'number' || m.kind === 'none') return empty;
  const delta = (newValue - oldValue) * m.scale;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const warnings: string[] = [];
  if (Math.abs(delta) > 25000) warnings.push('Large change: may cross a bracket, cap or phase-out; the engine would recompute.');
  if (m.note) warnings.push(m.note);

  if (m.kind === 'rate') {
    const rate = rates[m.category!];
    if (!rate) return empty;
    return {
      estimable: true,
      federalTax: r2(delta * m.sign * rate.federal_per_dollar),
      californiaTax: r2(delta * m.sign * rate.california_per_dollar),
      federalBalance: 0,
      californiaBalance: 0,
      basis: `Δ ${r2(delta)} × ${m.category} rate (${version})`,
      warnings,
    };
  }
  if (m.kind === 'credit') {
    return {
      ...empty,
      estimable: true,
      federalTax: m.jurisdiction === 'federal' ? r2(delta * m.sign) : 0,
      californiaTax: m.jurisdiction === 'california' ? r2(delta * m.sign) : 0,
      basis: 'Credit: 1:1 against tax',
      warnings,
    };
  }
  return {
    ...empty,
    estimable: true,
    federalBalance: m.jurisdiction === 'federal' ? r2(delta * m.sign) : 0,
    californiaBalance: m.jurisdiction === 'california' ? r2(delta * m.sign) : 0,
    basis: 'Payment: 1:1 against balance due',
    warnings,
  };
}

/** Firm rule: any adjustment with a tax effect over 1,000 (federal or state) needs partner sign-off. */
export function effectMagnitude(e: EstimatedEffect): number {
  return Math.max(
    Math.abs(e.federalTax) + Math.abs(e.federalBalance),
    Math.abs(e.californiaTax) + Math.abs(e.californiaBalance),
  );
}
