// The view registry (FR-8): generated records a CPA expects, all lenses over the same graph.

import type { ViewDto, ViewListItem } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { PolicyError } from '../policy/policy.ts';
import { ViewCtx } from './ctx.ts';
import { summaryVsPrior, taxComputation } from './summary.ts';
import { sales } from './sales.ts';
import { depreciation } from './depreciation.ts';
import { booksToTax } from './booksToTax.ts';
import { k1, rentals } from './rentals.ts';
import { stateSplit } from './stateSplit.ts';
import { payments } from './payments.ts';
import { basis, carryovers, priorPreparer } from './carryovers.ts';
import { deductionsCredits, retirementForeign } from './deductions.ts';
import { completeness } from './completeness.ts';

type Builder = (ctx: ViewCtx) => ViewDto;

const VIEWS: [ViewListItem, Builder][] = [
  [{ id: 'summary-vs-prior', title: 'Return summary vs 2024', description: 'Key lines vs last year with Δ, Δ%, the firm variance flag and explanation status.' }, summaryVsPrior],
  [{ id: 'tax-computation', title: 'Tax computation', description: 'Federal and California chain from income to balance, refund and penalty.' }, taxComputation],
  [{ id: 'sales', title: 'Sales detail (8949)', description: 'Lots by box, term and broker; exceptions first.' }, sales],
  [{ id: 'depreciation', title: 'Depreciation by asset', description: 'Federal / California / AMT, bonus and §179, accumulated, disposals and recapture.' }, depreciation],
  [{ id: 'books-to-tax', title: 'Books to tax', description: 'Schedule C bridge from the books P&L to net profit, SE tax and QBI.' }, booksToTax],
  [{ id: 'rentals', title: 'Rentals and passive losses', description: 'Per property income and expenses, Form 8582 suspended losses, and the sale.' }, rentals],
  [{ id: 'k1', title: 'K-1 lines', description: 'Every K-1 value and where it landed.' }, k1],
  [{ id: 'state-split', title: 'State split', description: 'Residency and Schedule CA (540NR) columns A–E with sourcing and column math.' }, stateSplit],
  [{ id: 'payments', title: 'Payments', description: 'Payments claimed vs the IRS transcript and the FTB account.' }, payments],
  [{ id: 'carryovers', title: 'Carryovers', description: 'In from 2024, used in 2025, out to 2026.' }, carryovers],
  [{ id: 'basis', title: 'Basis by year', description: 'S corporation stock basis, partnership capital, IRA basis; gaps called out.' }, basis],
  [{ id: 'prior-preparer', title: 'Prior preparer vs us', description: 'Prior preparer notes and open items against this return.' }, priorPreparer],
  [{ id: 'deductions-credits', title: 'Deductions and credits', description: 'Schedule A and credits with limits applied.' }, deductionsCredits],
  [{ id: 'retirement-foreign', title: 'Retirement and foreign', description: 'Form 8606, SEP, HSA, foreign interest and FX, Form 8938 / FBAR.' }, retirementForeign],
  [{ id: 'completeness', title: 'Completeness', description: 'Document dispositions, areas considered, outside filings.' }, completeness],
];

export function listViews(): ViewListItem[] {
  return VIEWS.map(([v]) => v);
}

export function buildView(wp: Workpaper, id: string): ViewDto {
  const hit = VIEWS.find(([v]) => v.id === id);
  if (!hit) throw new PolicyError(`No view ${id}`, 'not_found');
  return hit[1](new ViewCtx(wp));
}

export { ViewCtx };
