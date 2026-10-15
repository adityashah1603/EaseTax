// Books to tax: a bridge (waterfall) from net income per books, through each adjusting item,
// to Schedule C line 31; then receipts against information returns and profit to SE tax / QBI.
import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowDown } from 'lucide-react';
import { useDrawer } from '../../state/drawer';
import { Box, Collapsible, FlagText, Num, Plain, Rest, Signed, Verdict, num, sectionsOf } from './kit';

export function BooksToTax({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const bridge = s.get('bridge');
  const third = s.get('third-party');
  const down = s.get('downstream');
  const flagsFor = (r: ViewRow): ViewFlag[] => [...(r.flags ?? []), ...view.findings.filter((f) => r.nodeId && f.nodeIds?.includes(r.nodeId) && !(r.flags ?? []).some((x) => x.code === f.code))];
  return (
    <div className="space-y-4">
      {bridge && <Bridge rows={bridge.rows} totals={bridge.totals ?? []} flagsFor={flagsFor} />}
      {third && <Receipts rows={third.rows} totals={third.totals ?? []} />}
      {down && (
        <Box title={down.title} note="Where net profit goes next. Each step opens its line.">
          <Downstream rows={down.rows} />
        </Box>
      )}
      <Rest sections={s.rest(['bridge', 'third-party', 'downstream'])} />
    </div>
  );
}

function Bridge({ rows, totals, flagsFor }: { rows: ViewRow[]; totals: ViewRow[]; flagsFor: (r: ViewRow) => ViewFlag[] }) {
  const drawer = useDrawer();
  const start = rows[0];
  const rest = rows.slice(1);
  const moving = rest.filter((r) => Math.round(num(r.cells.effect) ?? 0) !== 0);
  const agreeing = rest.filter((r) => Math.round(num(r.cells.effect) ?? 0) === 0);
  const t = new Map(totals.map((x) => [x.id, x]));
  const end = t.get('SchC.31');
  const unexplained = num(t.get('unexplained')?.cells.effect) ?? 0;

  // Running totals for the waterfall bars.
  let run = num(start?.cells.effect) ?? num(start?.cells.books) ?? 0;
  const steps = moving.map((r) => {
    const from = run;
    run += num(r.cells.effect) ?? 0;
    return { r, from, to: run };
  });
  const max = Math.max(1, ...[num(start?.cells.effect) ?? 0, ...steps.flatMap((x) => [x.from, x.to]), num(end?.cells.tax) ?? 0].map(Math.abs));
  const pct = (v: number) => `${((Math.max(0, v) / max) * 100).toFixed(2)}%`;

  const Bar = ({ from, to, kind }: { from: number; to: number; kind: 'total' | 'up' | 'down' }) => (
    <span className="relative block h-3 w-full rounded-sm bg-ruleSoft/60" aria-hidden>
      <span
        className={clsx('absolute inset-y-0 rounded-sm', kind === 'total' ? 'bg-ink/70' : kind === 'up' ? 'bg-ledger' : 'bg-pencil')}
        style={{ left: pct(Math.min(from, to)), width: `max(2px, ${pct(Math.abs(to - from))})` }}
      />
    </span>
  );

  const head = 'grid grid-cols-[minmax(0,1.3fr)_96px_96px_96px_minmax(140px,1fr)] items-center gap-2';
  return (
    <Box
      title="Bridge: books → Schedule C line 31"
      note="Green raises profit, red lowers it. Items where books and return agree are folded."
      right={<Verdict ok={Math.abs(unexplained) < 1}>{Math.abs(unexplained) < 1 ? 'bridge closes: no unexplained difference' : `unexplained difference ${unexplained}`}</Verdict>}
    >
      <div className={clsx(head, 'border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite')}>
        <span>Item</span>
        <span className="text-right">Books</span>
        <span className="text-right">Return</span>
        <span className="text-right">Effect</span>
        <span>Running profit</span>
      </div>
      {start && (
        <div className={clsx(head, 'border-b border-ruleSoft px-3 py-1.5 font-semibold')}>
          <span>{start.label}</span>
          <Num cell={start.cells.books} className="text-right" />
          <span />
          <Num cell={start.cells.effect} className="text-right" />
          <Bar from={0} to={num(start.cells.effect) ?? 0} kind="total" />
        </div>
      )}
      {steps.map(({ r, from, to }) => {
        const flags = flagsFor(r);
        const why = r.cells.why?.value as string | undefined;
        return (
          <div
            key={r.id}
            className={clsx('cursor-pointer border-b border-ruleSoft px-3 py-1.5 hover:bg-paper', flags.some((f) => f.severity === 'error') && 'bg-pencil-soft/40')}
            onClick={() => r.nodeId && drawer.open(r.nodeId)}
          >
            <div className={head}>
              <span className="min-w-0">
                <span className="block truncate">{r.label}</span>
                <span className="block truncate text-xs text-faint">{why || r.sublabel}</span>
              </span>
              <Num cell={r.cells.books} className="text-right" />
              <Num cell={r.cells.tax} className="text-right" />
              <span className={clsx('text-right font-semibold', (num(r.cells.effect) ?? 0) > 0 ? 'text-ledger-ink' : 'text-pencil-ink')}>
                <Signed value={num(r.cells.effect)} />
              </span>
              <Bar from={from} to={to} kind={to >= from ? 'up' : 'down'} />
            </div>
            {flags.map((f, i) => (
              <FlagText key={i} flag={f} className="mt-0.5" />
            ))}
          </div>
        );
      })}
      {agreeing.length > 0 && (
        <div className="border-b border-ruleSoft">
          <Collapsible title={<span>{agreeing.length} expense lines agree books = return (no effect)</span>} right={<span className="text-2xs font-normal text-faint">{agreeing.reduce((n, r) => n + (r.flags?.length ?? 0) + flagsFor(r).length, 0) ? 'some carry findings' : ''}</span>} defaultOpen={agreeing.some((r) => flagsFor(r).length > 0)}>
            {agreeing.map((r) => {
              const flags = flagsFor(r);
              return (
                <div key={r.id} className={clsx('cursor-pointer px-3 py-1 hover:bg-paper', flags.length && 'bg-amber-soft/40')} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
                  <div className={clsx(head, 'text-sm')}>
                    <span className="truncate pl-4 text-graphite">{r.label}</span>
                    <Num cell={r.cells.books} className="text-right" />
                    <Num cell={r.cells.tax} className="text-right" />
                    <span className="num text-right text-faint">0</span>
                    <span />
                  </div>
                  {flags.map((f, i) => (
                    <FlagText key={i} flag={f} className="ml-4" />
                  ))}
                </div>
              );
            })}
          </Collapsible>
        </div>
      )}
      {end && (
        <div className={clsx(head, 'border-t-2 border-ink px-3 py-2 font-semibold')}>
          <span>{end.label}</span>
          <span />
          <Num cell={end.cells.tax} className="text-right text-base" />
          <span className="text-right text-xs font-normal text-graphite">
            computed <Plain value={num(t.get('computed')?.cells.effect)} />
          </span>
          <Bar from={0} to={num(end.cells.tax) ?? 0} kind="total" />
        </div>
      )}
    </Box>
  );
}

function Receipts({ rows, totals }: { rows: ViewRow[]; totals: ViewRow[] }) {
  const t = new Map(totals.map((x) => [x.id, x]));
  const nec = num(t.get('nec')?.cells.amount) ?? 0;
  const k = num(t.get('k')?.cells.amount) ?? 0;
  const books = num(t.get('books')?.cells.amount);
  const schc = num(t.get('SchC.1')?.cells.amount);
  const info = nec + k;
  return (
    <Box title="Receipts vs information returns" note="Schedule C gross receipts should cover what payers reported, and not count the same receipt twice.">
      <div className="grid grid-cols-1 gap-4 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ul className="divide-y divide-ruleSoft text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-1">
              <span className="truncate">{r.label}</span>
              <Num cell={r.cells.amount} />
            </li>
          ))}
        </ul>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-graphite">1099-NEC total</span>
            <Num cell={t.get('nec')?.cells.amount} />
          </div>
          <div className="flex justify-between">
            <span className="text-graphite">+ 1099-K total</span>
            <Num cell={t.get('k')?.cells.amount} />
          </div>
          <div className="flex justify-between border-t border-rule pt-1 font-semibold">
            <span>Reported by payers</span>
            <Plain value={info} />
          </div>
          <div className="flex justify-between pt-2">
            <span className="text-graphite">Books gross receipts</span>
            <Num cell={t.get('books')?.cells.amount} />
          </div>
          <div className="flex justify-between font-semibold">
            <span>Schedule C line 1</span>
            <Num cell={t.get('SchC.1')?.cells.amount} />
          </div>
          {books !== undefined && schc !== undefined && (
            <div className="space-y-1 pt-1">
              <Verdict ok={books >= nec} warn={books < nec}>
                Books {books >= nec ? 'cover' : 'fall short of'} the 1099-NECs ({(books - nec).toLocaleString('en-US')})
              </Verdict>
              {schc - books > 0 && (
                <div>
                  <Verdict ok={false}>
                    Schedule C is {(schc - books).toLocaleString('en-US')} above books{schc - books === k ? ' — exactly the 1099-K, which the books already hold' : ''}
                  </Verdict>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Box>
  );
}

function Downstream({ rows }: { rows: ViewRow[] }) {
  const drawer = useDrawer();
  return (
    <ol className="p-3">
      {rows.map((r, i) => (
        <li key={r.id}>
          {i > 0 && (
            <div className="flex w-[260px] justify-center text-faint" aria-hidden>
              <ArrowDown size={12} />
            </div>
          )}
          <div className="flex cursor-pointer items-baseline gap-3 rounded px-1 hover:bg-paper" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
            <span className="w-[86px] shrink-0 text-2xs text-faint">{r.sublabel}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{r.label}</span>
            <Num cell={r.cells.amount} className="w-[110px]" />
          </div>
          {r.flags?.map((f, j) => (
            <FlagText key={j} flag={f} className="ml-[98px]" />
          ))}
        </li>
      ))}
    </ol>
  );
}
