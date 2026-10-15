// "How was this built" (dir=down) and "Where it landed" (dir=up) as an indented tree.
// Truncated branches load lazily; DAG joins are marked instead of repeated.
import type { TraceNode } from '@easetax/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, CornerDownRight, FileText, Loader2, Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { api, enc } from '../../api/client';
import { EDGE_LABEL, fmtValue, isMasked } from '../../lib/format';
import { Marks } from '../ui';

export interface FlatRow {
  key: string;
  t: TraceNode;
  depth: number;
}

export function isSourceLeaf(id: string) {
  return id.startsWith('ev:') || id.startsWith('doc:');
}

/** Flatten the visible tree so j/k can walk it. */
export function flatten(root: TraceNode, collapsed: Set<string>, extra: Record<string, TraceNode[]>, includeRoot = false): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (t: TraceNode, depth: number, path: string) => {
    const key = `${path}/${t.node.id}`;
    out.push({ key, t, depth });
    if (collapsed.has(key)) return;
    const kids = t.children.length ? t.children : extra[t.node.id] ?? [];
    kids.forEach((c, i) => walk(c, depth + 1, `${key}.${i}`));
  };
  if (includeRoot) walk(root, 0, '');
  else root.children.forEach((c, i) => walk(c, 0, `r.${i}`));
  return out;
}

export function FormulaTree({
  root,
  dir,
  selectedKey,
  onSelect,
  onOpen,
  extra,
  setExtra,
  collapsed,
  setCollapsed,
  highlightId,
}: {
  highlightId?: string | null;
  root: TraceNode;
  dir: 'down' | 'up';
  selectedKey: string | null;
  onSelect: (row: FlatRow) => void;
  onOpen: (id: string) => void;
  extra: Record<string, TraceNode[]>;
  setExtra: (f: (x: Record<string, TraceNode[]>) => Record<string, TraceNode[]>) => void;
  collapsed: Set<string>;
  setCollapsed: (f: (x: Set<string>) => Set<string>) => void;
}) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState<string | null>(null);
  const rows = flatten(root, collapsed, extra);

  const expand = async (id: string) => {
    setLoading(id);
    try {
      const t = await qc.fetchQuery({ queryKey: ['trace', id, dir, 3], queryFn: () => api<TraceNode>(`/api/nodes/${enc(id)}/trace?dir=${dir}&depth=3`) });
      setExtra((x) => ({ ...x, [id]: t.children }));
    } finally {
      setLoading(null);
    }
  };

  if (!rows.length)
    return <div className="px-2 py-2 text-sm text-faint">{dir === 'down' ? 'No inputs recorded: this value is entered directly.' : 'Nothing further uses this value.'}</div>;

  return (
    <ul role="tree" className="text-sm">
      {rows.map(({ key, t, depth }) => {
        const n = t.node;
        const kids = t.children.length ? t.children : extra[n.id];
        const hasKids = !!kids?.length;
        const isCollapsed = collapsed.has(key);
        const lowConf = typeof n.confidence === 'number' && n.confidence < 0.8;
        const selected = key === selectedKey;
        return (
          <li
            key={key}
            role="treeitem"
            aria-selected={selected}
            data-row-key={key}
            className={clsx(
              'group relative flex cursor-pointer items-start gap-1 border-l-2 py-[3px] pr-2',
              selected ? 'border-blue bg-blue-soft' : n.id === highlightId ? 'border-blue/60 bg-blue-soft/50' : 'border-transparent hover:bg-ruleSoft',
              t.repeated && 'opacity-60',
            )}
            style={{ paddingLeft: 6 + depth * 18 }}
            onClick={() => onSelect({ key, t, depth })}
            onDoubleClick={() => onOpen(n.id)}
          >
            {/* connector rule, like a ledger's indent line */}
            {depth > 0 && <span className="absolute bottom-0 top-0 border-l border-dotted border-rule" style={{ left: depth * 18 - 6 }} aria-hidden />}
            <span className="mt-[3px] w-4 shrink-0">
              {hasKids ? (
                <button
                  className="text-faint hover:text-ink"
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((c) => {
                      const nx = new Set(c);
                      if (nx.has(key)) nx.delete(key);
                      else nx.add(key);
                      return nx;
                    });
                  }}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : isSourceLeaf(n.id) ? (
                <FileText size={13} className="mt-[1px] text-faint" />
              ) : (
                <CornerDownRight size={13} className="mt-[1px] text-rule" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                {t.edge && <span className="shrink-0 text-2xs text-faint">{EDGE_LABEL[t.edge] ?? t.edge}</span>}
                <span className="truncate">{n.label}</span>
              </span>
              {n.sublabel && <span className="block truncate text-xs text-graphite">{n.sublabel}</span>}
              {t.repeated && <span className="block text-2xs text-faint">Already shown above</span>}
              {t.truncated && !extra[n.id] && (
                <button
                  className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-blue hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    void expand(n.id);
                  }}
                >
                  {loading === n.id ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} />}
                  {dir === 'down' ? 'Show inputs' : 'Show where it goes'}
                </button>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 pt-[1px]">
              <Marks openIssues={n.openIssues} verified={n.verified} adjusted={n.adjusted} />
              {lowConf && (
                <span className="rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink" title="Pipeline read confidence">
                  {Math.round(n.confidence! * 100)}%
                </span>
              )}
              {n.value !== undefined && (
                <span className={clsx('num min-w-[70px] text-right', isMasked(n.value) && 'text-graphite')}>
                  {n.adjusted ? (
                    <>
                      <span className="mr-1 text-faint line-through">{fmtValue(n.value)}</span>
                      <span className="font-semibold text-blue-ink">{fmtValue(n.effectiveValue)}</span>
                    </>
                  ) : (
                    fmtValue(n.value)
                  )}
                </span>
              )}
              <button
                className="invisible text-faint hover:text-ink group-hover:visible"
                title="Open this item's own trace"
                aria-label="Open trace"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(n.id);
                }}
              >
                <Maximize2 size={12} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
