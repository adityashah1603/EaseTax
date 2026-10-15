// Which renderer draws which view, and how the index groups and explains them.
// A view the server adds later still renders (generically) and lands in "Other records".
import type { ViewDto } from '@easetax/shared';
import type { ComponentType } from 'react';
import { BooksToTax } from './BooksToTax';
import { Completeness } from './Completeness';
import { DeductionsCredits, RetirementForeign } from './Deductions';
import { Depreciation } from './Depreciation';
import { Payments } from './Payments';
import { K1, Rentals } from './Rentals';
import { Sales } from './Sales';
import { StateSplit } from './StateSplit';
import { SummaryVsPrior } from './SummaryVsPrior';
import { TaxComputation } from './TaxComputation';
import { Basis, Carryovers, PriorPreparer } from './YearToYear';
import { Rest } from './kit';

export interface RecordMeta {
  render: ComponentType<{ view: ViewDto }>;
  group: string;
  /** What a reviewer uses it for, in one line. */
  purpose: string;
}

export const RECORD_GROUPS = ['The return', 'Income detail', 'California', 'Agreement to outside records', 'Year to year', 'Deductions, retirement and foreign', 'Completeness', 'Other records'];

export const RECORDS: Record<string, RecordMeta> = {
  'summary-vs-prior': { render: SummaryVsPrior, group: 'The return', purpose: 'Which lines moved past the firm variance rule and still need an explanation.' },
  'tax-computation': { render: TaxComputation, group: 'The return', purpose: 'Follow income to balance due, federal and California, as one chain.' },
  sales: { render: Sales, group: 'Income detail', purpose: '295 lots reduced to the exceptions, then groups by box, term and broker.' },
  depreciation: { render: Depreciation, group: 'Income detail', purpose: 'Each asset’s federal, California and AMT depreciation, tied to the return.' },
  'books-to-tax': { render: BooksToTax, group: 'Income detail', purpose: 'Bridge the client’s books to Schedule C net profit, item by item.' },
  rentals: { render: Rentals, group: 'Income detail', purpose: 'Each property’s result and how suspended passive losses were released.' },
  k1: { render: K1, group: 'Income detail', purpose: 'Every K-1 box and the return line it landed on.' },
  'state-split': { render: StateSplit, group: 'California', purpose: 'Residency dates, columns A–E, how each item is sourced, and the column math.' },
  payments: { render: Payments, group: 'Agreement to outside records', purpose: 'Payments claimed against the IRS transcript and the FTB account.' },
  carryovers: { render: Carryovers, group: 'Year to year', purpose: 'What came in from 2024, what 2025 used, and what goes out to 2026.' },
  basis: { render: Basis, group: 'Year to year', purpose: 'Stock, partnership and IRA basis rolled year by year, gaps called out.' },
  'prior-preparer': { render: PriorPreparer, group: 'Year to year', purpose: 'What the prior preparer noted or left open, against what this return does.' },
  'deductions-credits': { render: DeductionsCredits, group: 'Deductions, retirement and foreign', purpose: 'Schedule A and credits with each limit applied and what it cut off.' },
  'retirement-foreign': { render: RetirementForeign, group: 'Deductions, retirement and foreign', purpose: 'SEP limit, Form 8606, HSA, and foreign amounts re-converted at the right rate.' },
  completeness: { render: Completeness, group: 'Completeness', purpose: 'Documents without a disposition, areas not considered, outside filings.' },
};

function Generic({ view }: { view: ViewDto }) {
  return <Rest sections={view.sections} />;
}

export const recordFor = (id: string): RecordMeta => RECORDS[id] ?? { render: Generic, group: 'Other records', purpose: '' };
