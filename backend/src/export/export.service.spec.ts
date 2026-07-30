import { BadRequestException } from '@nestjs/common';
import { AuthUser } from '../common/auth.guard';
import { ExportDataset, MAX_EXPORT_ROWS } from './export.types';
import { ExportService } from './export.service';

/**
 * The row ceiling, tested here rather than through HTTP: proving it needs
 * MAX_EXPORT_ROWS + 1 rows, and generating those in Postgres to assert on a
 * number this file already knows would buy nothing.
 */

const USER = { id: 'u1', name: 'Tester', role: 'ADMIN' } as AuthUser;

/** A dataset of `count` trivial rows — the ceiling does not care what is in them. */
function datasetOf(count: number): ExportDataset<{ n: number }> {
  return {
    key: 'fake',
    title: 'Fake',
    filename: 'fake',
    load: () => Promise.resolve(Array.from({ length: count }, (_, n) => ({ n }))),
    columns: [{ header: 'N', value: (r) => r.n }],
  };
}

describe('export row ceiling', () => {
  const service = new ExportService();

  it('renders a file at exactly the ceiling', async () => {
    const file = await service.render(datasetOf(MAX_EXPORT_ROWS), USER, 'csv');
    expect(file.buffer.length).toBeGreaterThan(0);
    // Header + every row: nothing was dropped on the way to the line.
    expect(file.buffer.toString('utf8').trim().split('\n').length).toBe(MAX_EXPORT_ROWS + 1);
  }, 30_000);

  it('refuses one row past it rather than truncating', async () => {
    await expect(service.render(datasetOf(MAX_EXPORT_ROWS + 1), USER, 'csv')).rejects.toThrow(
      BadRequestException,
    );
  }, 30_000);

  it('says how many rows there were and what to do about it', async () => {
    // The menu shows this message inline and keeps itself open, so it has to be
    // the sentence someone can act on — not "Export failed".
    const err = await service
      .render(datasetOf(MAX_EXPORT_ROWS + 1), USER, 'csv')
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('10,001');
    expect((err as Error).message).toContain('10,000');
    expect((err as Error).message).toMatch(/narrow the filter/i);
  }, 30_000);

  it('hands the screen\'s filters to load, untouched', async () => {
    const seen: unknown[] = [];
    // Built out rather than spread from datasetOf: ExportDataset is a union, and
    // spreading one erases which side of it this is.
    const dataset: ExportDataset<{ n: number }> = {
      key: 'fake',
      title: 'Fake',
      filename: 'fake',
      columns: [{ header: 'N', value: (r) => r.n }],
      load: (_u, filters) => {
        seen.push(filters);
        return Promise.resolve([{ n: 1 }]);
      },
    };
    await service.render(dataset, USER, 'csv', 'UTC', { q: 'needle', action: 'APPROVED' });
    expect(seen).toEqual([{ q: 'needle', action: 'APPROVED' }]);
  });

  it('takes its columns from a dynamic dataset, which has none to declare', async () => {
    // The Reports shape: the table decides its own columns, and an empty one
    // still has to arrive with headers.
    const dataset: ExportDataset<string[]> = {
      key: 'dyn',
      title: 'Dynamic',
      filename: 'dyn',
      load: () =>
        Promise.resolve({
          rows: [],
          columns: [{ header: 'Decided On Load', value: (r) => r[0] }],
        }),
    };
    const file = await service.render(dataset, USER, 'csv');
    expect(file.buffer.toString('utf8')).toContain('Decided On Load');
  });
});
