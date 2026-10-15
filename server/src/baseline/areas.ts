// Review areas: how the return is divided for work, budget and sign-off.
// Area ids match firm.budget_hours where the firm defines a budget.

export interface AreaDef {
  id: string;
  title: string;
  /** Line keys belong to the first area whose matcher accepts them. */
  match: (form: string, line: string) => boolean;
  forms: string[];
}

const formIs = (...forms: string[]) => (form: string) => forms.includes(form);

export const AREAS: AreaDef[] = [
  {
    id: 'wages_and_stock_compensation',
    title: 'Wages & stock compensation',
    forms: ['F1040 (1a–1z)', 'F8959', 'F6251'],
    match: (f, l) => (f === 'F1040' && l.startsWith('1')) || formIs('F8959', 'F6251')(f),
  },
  {
    id: 'investments_and_digital_assets',
    title: 'Investments & digital assets',
    forms: ['SchB', 'SchD', 'F8949', 'F8960', 'F8938'],
    match: (f) => formIs('SchB', 'SchD', 'F8949', 'F8960', 'F8938')(f),
  },
  {
    id: 'business',
    title: 'Business (Schedule C)',
    forms: ['SchC', 'SchSE', 'F4562-C', 'F8995', 'F8995A'],
    match: (f, l) => formIs('SchC', 'SchSE', 'F4562-C', 'F8995', 'F8995A')(f) || (f === 'Sch1' && ['3', '15', '16', '17'].includes(l)),
  },
  {
    id: 'rentals_and_sale',
    title: 'Rentals & sale',
    forms: ['SchE (properties)', 'F4797', 'F4562-E', 'F8582'],
    match: (f, l) => formIs('F4797', 'F4562-E', 'F8582')(f) || (f === 'SchE' && /^\d+[AB]$/.test(l)) || (f === 'SchE' && l === '26'),
  },
  {
    id: 'pass_throughs_and_basis',
    title: 'Pass-throughs & basis',
    forms: ['SchE (K-1s)', 'F7203'],
    match: (f) => formIs('F7203', 'SchE')(f),
  },
  {
    id: 'deductions_and_credits',
    title: 'Deductions & credits',
    forms: ['SchA', 'F8283', 'F8812', 'F8863', 'F2441', 'F8867', 'Sch3', 'F8889'],
    match: (f) => formIs('SchA', 'F8283', 'F8812', 'F8863', 'F2441', 'F8867', 'Sch3', 'F8889')(f),
  },
  {
    id: 'retirement_and_foreign',
    title: 'Retirement & foreign',
    forms: ['F8606'],
    match: (f) => formIs('F8606')(f),
  },
  {
    id: 'california',
    title: 'California (540NR) & state split',
    forms: ['F540NR', 'SchCA540NR', 'ScheduleS', 'FTB3885A', 'FTB5805'],
    match: (f) => formIs('F540NR', 'SchCA540NR', 'ScheduleS', 'FTB3885A', 'FTB5805')(f),
  },
  {
    id: 'tax_and_payments',
    title: 'Tax computation & payments',
    forms: ['F1040', 'Sch1', 'Sch2', 'F2210'],
    match: () => true,
  },
];

export function areaOfKey(key: string): string {
  const dot = key.indexOf('.');
  const form = dot < 0 ? key : key.slice(0, dot);
  const line = dot < 0 ? '' : key.slice(dot + 1);
  return AREAS.find((a) => a.match(form, line))!.id;
}
