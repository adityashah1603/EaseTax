// Tax computation as a chain: income → AGI → deductions → taxable income → tax → credits →
// other taxes → payments → balance → penalty, federal and California side by side.
import type { ViewDto, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowDown } from 'lucide-react';
import { useDrawer } from '../../state/drawer';
import { AdjPill, FlagText, Num, Rest, isAdjusted, sectionsOf } from './kit';

const SUM_RULES = /^R-SUM$/;

export function TaxComputation({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const fed = s.get('federal');
  const ca = s.get('california');
  const eff = (view.meta?.adjustmentEffect ?? null) as { federalTax: number; californiaTax: number } | null;
  return (
    <div className="space-y-4">
      <p className="text-xs text-graphite">
        Read top to bottom. Subtotals are the engine’s sums (rule R-SUM) and close each stage. Every amount opens its formula tree.
        {eff && (eff.federalTax || eff.californiaTax) ? ' Adjusted amounts show the engine figure struck through.' : ' No workpaper adjustments are in force, so effective = engine.'}
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {fed && <Chain section={fed} />}
        {ca && <Chain section={ca} />}
      </div>
      <Rest sections={s.rest(['federal', 'california'])} />
    </div>
  );
}

function Chain({ section }: { section: ViewSection }) {
  const stages: { name: string; rows: ViewRow[] }[] = [];
  for (const r of section.rows) {
    const name = r.status ?? 'Other';
    const last = stages[stages.length - 1];
    if (last && last.name === name) last.rows.push(r);
    else stages.push({ name, rows: [r] });
  }
  return (
    <section className="rounded border border-rule bg-panel" aria-label={section.title}>
      <h2 className="border-b border-rule px-3 py-2 font-serif text-lg font-semibold">{section.title}</h2>
      <ol className="px-3 py-3">
        {stages.map((st, i) => (
          <li key={st.name + i}>
            {i > 0 && (
              <div className="flex justify-center py-0.5 text-faint" aria-hidden>
                <ArrowDown size={14} />
              </div>
            )}
            <div className="rounded border border-ruleSoft">
              <div className="border-b border-ruleSoft bg-paper px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-graphite">{st.name}</div>
              {st.rows.map((r) => (
                <ChainRow key={r.id} r={r} />
              ))}
            </div>
          </li>
        ))}
      </ol>
      {!!section.totals?.length && (
        <div className="border-t-2 border-ink px-3 py-2">
          {section.totals.map((t) => (
            <div key={t.id} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-sm font-semibold">{t.label}</span>
              <span className="flex items-baseline gap-2">
                {t.cells.amount?.note && <span className="text-2xs text-blue-ink">{t.cells.amount.note}</span>}
                <Num cell={t.cells.amount} className="text-base font-semibold" />
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ChainRow({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  const rule = r.cells.rule?.value as string | undefined;
  const sum = !!rule && SUM_RULES.test(rule);
  const cell = r.cells.amount ?? r.cells.ratio;
  const kind = r.cells.ratio && !r.cells.amount ? 'ratio' : 'money';
  return (
    <div
      className={clsx('cursor-pointer px-2.5 py-1 hover:bg-blue-soft/40', sum ? 'border-t border-rule font-semibold' : 'text-ink', isAdjusted(cell) && 'bg-blue-soft/30')}
      onClick={() => r.nodeId && drawer.open(r.nodeId)}
    >
      <div className="flex items-baseline gap-2">
        <span className="w-[86px] shrink-0 truncate text-2xs font-normal text-faint" title={r.sublabel}>
          {(r.sublabel ?? '').split(' · ').pop()}
        </span>
        <span className={clsx('min-w-0 flex-1 truncate text-sm', sum && 'text-ink')} title={r.label}>
          {sum && <span className="mr-1 text-faint">=</span>}
          {r.label}
        </span>
        {isAdjusted(cell) && <AdjPill />}
        {rule && !sum && (
          <code className="hidden shrink-0 text-2xs font-normal text-faint md:inline" title="Engine rule">
            {rule}
          </code>
        )}
        <Num cell={cell} kind={kind} className="w-[110px] shrink-0" />
      </div>
      {r.flags?.map((f, i) => <FlagText key={i} flag={f} className="ml-[94px]" />)}
    </div>
  );
}
