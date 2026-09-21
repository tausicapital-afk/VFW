import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchResult } from '../lib/types';

const TYPE_LABEL: Record<SearchResult['type'], string> = {
  submission: 'Submission',
  contact: 'Contact',
};

/**
 * Global search (Cmd/Ctrl-K) — a jump-to tool, not a results page.
 *
 * Every row it can show is something the signed-in user could already open by
 * URL: the server (GET /api/search) re-applies the exact same row scope each
 * entity's own screen reads through, so this never surfaces a colleague's
 * deal or contact. This component's only job is finding and opening one.
 *
 * Reuses the same .modal/.box shell every other overlay in the console uses
 * (see SubmissionQuickLook in pages/Submissions.tsx), with the same
 * Escape-to-close and click-outside-to-close conventions.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Fresh every time the palette opens — a stale query from the last time it
  // was used should not sit there when it is reopened.
  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setActiveIndex(0);
      // Wait a tick for the modal to actually be in the DOM before focusing it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced so every keystroke does not fire a request.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<SearchResult[]>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
  });
  const results = debounced ? (data ?? []) : [];

  useEffect(() => setActiveIndex(0), [results.length, debounced]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
      } else if (e.key === 'Enter') {
        const hit = results[activeIndex];
        if (hit) {
          e.preventDefault();
          onClose();
          navigate(hit.href);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, results, activeIndex, onClose, navigate]);

  if (!open) return null;

  const go = (r: SearchResult) => {
    onClose();
    navigate(r.href);
  };

  return (
    <div className="modal cmdk-modal" onClick={onClose}>
      <div className="box cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <span className="cmdk-ic">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search submissions (ref, invoice #) and contacts (brand, designer)…"
            aria-label="Global search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="cmdk-listbox"
          />
          <kbd className="cmdk-kbd">Esc</kbd>
        </div>
        <div className="cmdk-results" id="cmdk-listbox" role="listbox">
          {!debounced ? (
            <div className="cmdk-empty">Type a ref, invoice number, brand or designer…</div>
          ) : isFetching ? (
            <div className="cmdk-empty">Searching…</div>
          ) : results.length === 0 ? (
            <div className="cmdk-empty">No matches for &ldquo;{debounced}&rdquo;</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.type}-${r.id}`}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={'cmdk-item' + (i === activeIndex ? ' on' : '')}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => go(r)}
              >
                <span className="cmdk-type">{TYPE_LABEL[r.type]}</span>
                <span className={'cmdk-label' + (r.type === 'submission' ? ' mono' : '')}>{r.label}</span>
                {r.sublabel && <span className="cmdk-sub">{r.sublabel}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
