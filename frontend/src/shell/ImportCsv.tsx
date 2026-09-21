import { useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import type { ImportResult } from '../lib/types';

/**
 * A file-picker button that posts a CSV to a bulk-import endpoint (see
 * backend/src/common/csv-import.ts) and shows the structured result: how many
 * rows made it in, and — for the ones that didn't — exactly which row and
 * why, so an admin can fix just those rows and re-import the same file.
 *
 * Rows are independent on the server (a bad row does not undo a good one), so
 * a result with both `succeeded` and `failed` above zero is the normal case
 * for a real-world file, not a partial failure to alarm about.
 */
export function ImportCsvButton({
  endpoint,
  onImported,
  label = 'Import CSV',
}: {
  endpoint: string;
  onImported?: () => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared immediately so picking the same filename again (after fixing the
    // bad rows it named) actually fires a change event.
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    try {
      const res = await api.upload<ImportResult>(endpoint, file);
      setResult(res);
      setError(null);
      if (res.succeeded > 0) onImported?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The file could not be imported');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e)}
      />
      <button className="btn sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Importing…' : label}
      </button>
      {(result || error) && (
        <ImportResultModal
          result={result}
          error={error}
          onClose={() => { setResult(null); setError(null); }}
        />
      )}
    </>
  );
}

function ImportResultModal({
  result,
  error,
  onClose,
}: {
  result: ImportResult | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Import result</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>

        <div className="bd">
          {error && <div className="note bad">{error}</div>}

          {result && (
            <>
              <p>
                <b>{result.succeeded}</b> row{result.succeeded === 1 ? '' : 's'} imported
                {result.failed > 0 && (
                  <> — <b>{result.failed}</b> failed and {result.failed === 1 ? 'was' : 'were'} skipped</>
                )}
                .
              </p>

              {result.failed > 0 && (
                <div className="tbl-wrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead>
                      <tr><th>Row</th><th>Error</th></tr>
                    </thead>
                    <tbody>
                      {result.errors.map((e) => (
                        <tr key={e.row}>
                          <td className="num mono">{e.row}</td>
                          <td className="sm">{e.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
