// Roles, firm rules and sensitive-data masking (D-09, D-10). Enforced server-side.

import type { Actor, Role } from '@easetax/shared';
import type { Baseline } from '../baseline/baseline.ts';

export class PolicyError extends Error {
  constructor(
    message: string,
    public code: 'forbidden' | 'policy' | 'invalid' | 'conflict' | 'not_found' = 'policy',
    public rule?: string,
  ) {
    super(message);
  }
}

export const RULES = {
  noSelfReview: 'A person may not review or sign off on work they prepared.',
  partnerOver1000: 'Any adjustment with a tax effect over 1,000 (federal or state) requires partner sign-off.',
  authority: 'Every judgment call records the authority relied on.',
  blockingNotes: 'Open review notes block filing.',
  masking: 'Staff without sensitive-data clearance see SSNs, bank and account numbers and IP PINs masked; every unmasked view is logged.',
} as const;

export function actorsFrom(b: Baseline): Actor[] {
  const staff: Actor[] = b.packet.firm.staff.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role as Role,
    kind: 'staff',
    clearance: s.sensitive_data_clearance,
    activeFrom: s.active_from,
    note: s.note,
  }));
  const clients: Actor[] = b.packet.firm.client_users.map((c) => ({
    id: c.id,
    name: c.name,
    role: 'client',
    kind: 'client',
    clearance: false,
  }));
  return [...staff, ...clients];
}

type Action =
  | 'read'
  | 'verify'
  | 'adjust'
  | 'approve_adjustment'
  | 'note'
  | 'resolve_issue'
  | 'ask'
  | 'answer_client_question'
  | 'attach'
  | 'judgment'
  | 'disposition'
  | 'signoff'
  | 'assign'
  | 'log_time'
  | 'unmask'
  | 'standards'
  | 'filing'
  | 'client_approval'
  | 'undo';

const STAFF_WORK: Role[] = ['preparer', 'reviewer', 'partner'];

const ALLOWED: Record<Action, Role[]> = {
  read: ['preparer', 'reviewer', 'partner', 'firm_administrator', 'quality_reviewer', 'client'],
  verify: STAFF_WORK,
  adjust: STAFF_WORK,
  approve_adjustment: ['partner'],
  note: [...STAFF_WORK, 'quality_reviewer'],
  resolve_issue: STAFF_WORK,
  ask: STAFF_WORK,
  answer_client_question: ['client', ...STAFF_WORK],
  attach: [...STAFF_WORK, 'client'],
  judgment: STAFF_WORK,
  disposition: STAFF_WORK,
  signoff: STAFF_WORK,
  assign: ['reviewer', 'partner', 'firm_administrator'],
  log_time: [...STAFF_WORK, 'quality_reviewer'],
  unmask: ['preparer', 'reviewer', 'partner', 'firm_administrator', 'quality_reviewer'],
  standards: ['firm_administrator'],
  filing: ['reviewer', 'partner'],
  client_approval: ['client'],
  undo: STAFF_WORK,
};

const ACTION_TEXT: Partial<Record<Action, string>> = {
  filing: 'file, extend or record e-file results',
  standards: 'change firm standards or read the access log',
  approve_adjustment: 'approve adjustments',
  client_approval: 'approve the return for the client',
  answer_client_question: 'answer this question',
  log_time: 'log time',
};

export function assertCan(actor: Actor, action: Action) {
  if (!ALLOWED[action].includes(actor.role)) {
    throw new PolicyError(`${actor.name} (${actor.role}) cannot ${ACTION_TEXT[action] ?? action.replace(/_/g, ' ')}`, 'forbidden');
  }
}

/**
 * What a client user may call. Everything else under /api is firm-only: the workpaper
 * (issues, notes, traces, views) is the firm's record, not the client's (D-35).
 */
const CLIENT_ROUTES: [method: string, pattern: RegExp][] = [
  ['GET', /^\/api\/me$/],
  ['GET', /^\/api\/summary$/],
  ['GET', /^\/api\/questions$/],
  ['POST', /^\/api\/questions\/[^/]+\/answer$/],
  ['POST', /^\/api\/attachments$/],
  ['GET', /^\/api\/filing\/status$/],
  ['GET', /^\/api\/filing\/client-copy$/],
  ['POST', /^\/api\/filing\/client-approval$/],
  ['POST', /^\/api\/presence$/],
  ['GET', /^\/api\/inbox$/],
];

export function clientMayCall(method: string, path: string): boolean {
  return CLIENT_ROUTES.some(([m, re]) => m === method && re.test(path));
}

export function canSignLevel(role: Role, level: 'preparer' | 'reviewer' | 'partner'): boolean {
  if (level === 'preparer') return role === 'preparer';
  if (level === 'reviewer') return role === 'reviewer' || role === 'partner';
  return role === 'partner';
}

// ---------- Masking ----------

const SSN_RE = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?: ?[0-9A-Z]{4}){3,7})\b/g;
const ACCOUNT_CTX_RE = /((?:account|acct|routing)(?: number| no\.?| #)?[:\s#]*)(\d[\d -]{4,}\d)/gi;
const IP_PIN_CTX_RE = /(IP PIN[:\s]*)(\d{6})/gi;

export function maskText(text: string): string {
  return text
    .replace(SSN_RE, (_m, _a, _b, last) => `***-**-${last}`)
    .replace(IBAN_RE, (m) => `${'•'.repeat(4)} ${m.replace(/\s/g, '').slice(-4)}`)
    .replace(ACCOUNT_CTX_RE, (_m, pre, num: string) => `${pre}••••${num.replace(/\D/g, '').slice(-4)}`)
    .replace(IP_PIN_CTX_RE, (_m, pre) => `${pre}••••••`);
}

export const SENSITIVE_VALUE_TYPES = new Set(['ssn', 'account_number']);
const SENSITIVE_KEYS = new Set(['ssn', 'ip_pin', 'account', 'routing', 'account_number']);

export function maskValue(v: unknown): unknown {
  if (typeof v === 'string') return maskText(v).replace(/^\d{5,}$/, (m) => `••••${m.slice(-4)}`);
  return v;
}

/** Deep-mask an object: sensitive keys are masked fully, every string is pattern-masked. */
export function maskDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return maskText(obj);
  if (Array.isArray(obj)) return obj.map(maskDeep);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) {
        const s = String(v);
        out[k] = k === 'ip_pin' ? '••••••' : `••••${s.replace(/\D/g, '').slice(-4)}`;
      } else out[k] = maskDeep(v);
    }
    return out;
  }
  return obj;
}
