import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type { Catalog, ReportCell, ReportCol, ReportTable, ReportType } from '../lib/types';
import { Page } from '../shell/Shell';

/**
 * Reports. Every figure on this screen was computed and consolidated by the
 * server — the client receives columns and rows and does no arithmetic on them.
 * Consolidated columns are already in CAD, converted with the FX rates in
 * Settings before they were summed.
 */

export interface Period {
  from?: string;
  to?: string;
  eventId?: string;
  cityId?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The mockup's period presets (applyPeriod, line 2708). */
function preset(p: string): Pick<Period, 'from' | 'to'> {
  const now = new Date();
  const y = now.getFullYear();
  if (p === 'm') return { from: iso(new Date(y, now.getMonth(), 1)), to: iso(now) };
  if (p === 'q') {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { from: iso(new Date(y, q, 1)), to: iso(now) };
  }
  if (p === 'y') return { from: iso(new Date(y, 0, 1)), to: iso(now) };
  return { from: undefined, to: undefined };
}

/** Shared by Reports and the Leaderboard — one definition of "the period". */
export function PeriodFilters({
  period, onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  const { data: catalog } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.get<Catalog>('/api/catalog'),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <>
      <select
        value={period.from ? 'custom' : ''}
        onChange={(e) => onChange({ ...period, ...preset(e.target.value) })}
      >
        <option value="">All time</option>
        <option value="m">This month</option>
        <option value="q">This quarter</option>
        <option value="y">This year</option>
        {period.from && <option value="custom">{period.from} → {period.to}</option>}
      </select>

      <select
        value={period.eventId ?? ''}
        onChange={(e) => onChange({ ...period, eventId: e.target.value || undefined })}
      >
        <option value="">All events</option>
        {catalog?.events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
      </select>

      <select
        value={period.cityId ?? ''}
        onChange={(e) => onChange({ ...period, cityId: e.target.value || undefined })}
      >
        <option value="">All cities</option>
        {catalog?.cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <button className="btn sm" onClick={() => onChange({})}>Clear</button>
    </>
  );
}

export function query(period: Period, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (period.from) p.set('from', period.from);
  if (period.to) p.set('to', period.to);
  if (period.eventId) p.set('eventId', period.eventId);
  if (period.cityId) p.set('cityId', period.cityId);
  return p.toString();
}

/**
 * Money arrives as a string; format it, never compute with it. A money column
 * always keeps its cents — an accountant reading 21,459 where the figure is
 * 21,459.00 is a bug — while counts and scores stay whole.
 */
function cell(v: ReportCell, col?: ReportCol) {
  const num = col?.num;
  if (v === null || v === '') return <td className={num ? 'num' : undefined}>—</td>;
  if (!num) return <td className="sm">{String(v)}</td>;
  const n = Number(v);
  const text = Number.isFinite(n)
    ? n.toLocaleString('en-CA', {
        minimumFractionDigits: col?.money ? 2 : Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: 2,
      })
    : String(v);
  return <td className="num">{text}</td>;
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csv(rows: ReportCell[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}

function exportTable(table: ReportTable, fmt: 'csv' | 'json') {
  const day = iso(new Date());
  const labels = table.cols.map((c) => c.label);
  if (fmt === 'json') {
    const objs = table.rows.map((r) => Object.fromEntries(labels.map((c, i) => [c, r[i]])));
    download(
      `vfw-${table.key}-${day}.json`,
      JSON.stringify({ report: table.name, generated: new Date().toISOString(), rows: objs }, null, 2),
      'application/json',
    );
  } else {
    download(`vfw-${table.key}-${day}.csv`, csv([labels, ...table.rows]), 'text/csv');
  }
}

export function Reports() {
  const [key, setKey] = useState('revenue');
  const [period, setPeriod] = useState<Period>({});

  const { data: types } = useQuery({
    queryKey: ['report-types'],
    queryFn: () => api.get<ReportType[]>('/api/reports/types'),
    staleTime: Infinity,
  });

  const qs = query(period, { type: key });
  const { data: table, isLoading, error } = useQuery({
    queryKey: ['report', qs],
    queryFn: () => api.get<ReportTable>(`/api/reports/summary?${qs}`),
  });

  return (
    <Page crumb="Insight" title="Reports">
      <div className="toolbar">
        {(types ?? []).map((t) => (
          <button
            key={t.key}
            className={'btn sm' + (t.key === key ? ' primary' : '')}
            onClick={() => setKey(t.key)}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <PeriodFilters period={period} onChange={setPeriod} />
      </div>

      <div className="card">
        <div className="hd">
          <h3>{table?.name ?? 'Report'}</h3>
          <div className="sp" />
          <span className="sm mut">
            {table ? `${table.rows.length} row${table.rows.length === 1 ? '' : 's'}` : '—'}
          </span>
          <button className="btn sm" disabled={!table} onClick={() => table && exportTable(table, 'csv')}>
            CSV
          </button>
          <button className="btn sm" disabled={!table} onClick={() => table && exportTable(table, 'json')}>
            JSON
          </button>
          <button className="btn sm" onClick={() => window.print()}>PDF / print</button>
        </div>

        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : error ? (
            <div className="empty">
              <h3>This report could not be run</h3>
              <p>{(error as Error).message}</p>
            </div>
          ) : !table || table.rows.length === 0 ? (
            <div className="empty">
              <h3>Nothing to report</h3>
              <p>This report has no rows for the current period.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  {table.cols.map((c) => (
                    <th key={c.label} className={c.num ? 'num' : undefined}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <Cell key={j} v={v} col={table.cols[j]} />)}</tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="note" style={{ marginTop: 16 }}>
        Consolidated columns are converted to CAD by the server using the FX rates in Settings,
        before they are summed. CSV opens directly in Excel; JSON matches the internal data model.
      </div>
    </Page>
  );
}

function Cell({ v, col }: { v: ReportCell; col?: ReportCol }) {
  return cell(v, col);
}
