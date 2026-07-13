import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Leaderboard, LeaderboardRep } from '../lib/types';
import { Page } from '../shell/Shell';
import { PeriodFilters, type Period, query } from './Reports';

/**
 * The leaderboard. The score, the rank and the parts all come from the server —
 * this screen ranks nobody, it only draws what it was given.
 *
 * The note at the bottom is not decoration. Internal department comments and
 * designer feedback are coaching inputs; they never touch the score, the ranking
 * or anyone's commission. The scoring function on the server has no parameter for
 * them (backend/src/reports/score.ts), and score.spec.ts holds that line.
 */

function Avatar({ rep }: { rep: LeaderboardRep }) {
  const initials = rep.name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return <div className="av" style={{ background: rep.colour ?? '#0E0E11' }}>{initials}</div>;
}

const pct = (part: number) => `${Math.round(part * 100)}%`;

export function Board() {
  const [period, setPeriod] = useState<Period>({});
  const qs = query(period);

  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard', qs],
    queryFn: () => api.get<Leaderboard>(`/api/reports/leaderboard?${qs}`),
  });

  const reps = data?.reps ?? [];
  const w = data?.weights;

  return (
    <Page crumb="People" title="Leaderboard">
      <div className="toolbar">
        <PeriodFilters period={period} onChange={setPeriod} />
      </div>

      <div className="card">
        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : reps.length === 0 ? (
            <div className="empty">
              <h3>No representatives to rank</h3>
              <p>The board ranks active sales representatives once they have submissions.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Representative</th>
                  <th className="num">Revenue (CAD)</th>
                  <th className="num">Approved</th>
                  <th className="num">Collection</th>
                  <th className="num">Retention</th>
                  <th className="num">Score</th>
                  <th>Rating</th>
                </tr>
              </thead>
              <tbody>
                {reps.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className={r.rank <= 3 ? `rank g${r.rank}` : 'rank'}>{r.rank}</div>
                    </td>
                    <td>
                      <div className="rowflex">
                        <Avatar rep={r} />
                        <div>
                          <div className="b">{r.name}</div>
                          <div className="sm mut">{r.employeeId ?? '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num">{money(r.revenue, 'CAD')}</td>
                    <td className="num">{r.approvedCount} / {r.decidedCount}</td>
                    <td className="num">{pct(r.parts.collection)}</td>
                    <td className="num">{pct(r.parts.retention)}</td>
                    <td className="num b">{r.score}</td>
                    <td>
                      <span className={`pill ${r.rating.cls}`}>
                        {'★'.repeat(r.rating.stars)} {r.rating.label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {w && (
        <div className="note lock" style={{ marginTop: 16 }}>
          Ranking uses revenue ({w.revenue}), approved sales ({w.approved}), payment collection
          ({w.collection}) and customer retention ({w.retention}) only. Designer feedback and
          internal department comments are excluded by design — they are coaching inputs and
          cannot move a score, a rank or a commission.
        </div>
      )}
    </Page>
  );
}
