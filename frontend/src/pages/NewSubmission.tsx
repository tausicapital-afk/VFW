import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { SEASON_TABS, seasonLabel, seasonTab, type SeasonTab } from '../lib/season';
import type { Catalog, Currency, DocumentType, Submission } from '../lib/types';
import { fmtSize, TYPE_LABEL, uploadDocument } from '../lib/uploads';
import { Page } from '../shell/Shell';

/** A file chosen before the submission exists, held until we have its id. */
type StagedFile = { file: File; type: DocumentType };

const PAYMENT_METHODS = [
  'Bank Transfer / Wire', 'Credit Card', 'Stripe', 'PayPal',
  'Cheque', 'Cash', 'Sponsored — No Charge',
];

function Row({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className={'r' + (cls ? ' ' + cls : '')}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function NewSubmission() {
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: catalog, isLoading } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.get<Catalog>('/api/catalog'),
    staleTime: Infinity,
  });

  const [designer, setDesigner] = useState('');
  const [brand, setBrand] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('');
  const [season, setSeason] = useState<SeasonTab>('FW');
  const [eventId, setEventId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [discountValue, setDiscountValue] = useState(0);
  const [deposit, setDeposit] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const [attachType, setAttachType] = useState<DocumentType>('contract');
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const event = catalog?.events.find((e) => e.id === eventId);

  // The Show list is narrowed to the chosen season tab.
  const shows = useMemo(
    () => catalog?.events.filter((ev) => seasonTab(ev.season) === season) ?? [],
    [catalog, season],
  );

  // Switching seasons drops a show that no longer belongs — and with it the
  // package and add-ons that were keyed off that show.
  function chooseSeason(next: SeasonTab) {
    setSeason(next);
    if (event && seasonTab(event.season) !== next) {
      setEventId('');
      setPackageId('');
      setAddonIds([]);
    }
  }

  // A package is only offered if it belongs to this event's brand AND carries a
  // price for the city the event runs in — the same two rules the server
  // enforces, so the form cannot compose a sale the API would reject.
  const packages = useMemo(() => {
    if (!catalog || !event) return [];
    return catalog.packages.filter(
      (p) => p.brand === event.brand && p.prices.some((pr) => pr.cityId === event.cityId),
    );
  }, [catalog, event]);

  const pkg = packages.find((p) => p.id === packageId);
  const price = pkg && event ? pkg.prices.find((pr) => pr.cityId === event.cityId) : undefined;
  const currency: Currency = price?.currency ?? 'USD';

  // Add-ons priced in another currency cannot go on this invoice — the server
  // rejects a mixed-currency sale, so never offer one.
  const sellable = useMemo(() => {
    if (!catalog || !event || !price) return [];
    return catalog.addons.filter(
      (a) => a.forBrands.includes(event.brand) && a.currency === price.currency,
    );
  }, [catalog, event, price]);

  /**
   * A preview only. The server recomputes all of this from the catalogue on
   * submit and its answer is the one that gets stored — this exists so the rep
   * can see the shape of the deal while they build it.
   */
  const preview = useMemo(() => {
    if (!pkg || !price || !catalog) return null;
    const base = Number(price.price);
    const addonTotal = sellable
      .filter((a) => addonIds.includes(a.id))
      .reduce((t, a) => t + Number(a.price), 0);
    const subtotal = base + addonTotal;
    const discount = Math.round(subtotal * (discountValue / 100) * 100) / 100;
    const taxable = Math.max(0, subtotal - discount);
    const rate = Number(catalog.taxes.find((t) => t.code === pkg.taxCode)?.rate ?? 0);
    const tax = Math.round(taxable * (rate / 100) * 100) / 100;
    const total = Math.round((taxable + tax) * 100) / 100;
    return { base, addonTotal, subtotal, discount, taxable, rate, tax, total, balance: total - deposit };
  }, [pkg, price, catalog, sellable, addonIds, discountValue, deposit]);

  // Holds the submission once created so that a retry after a failed attachment
  // upload flushes the remaining files instead of creating a duplicate sale.
  const createdRef = useRef<Submission | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      let sub = createdRef.current;
      if (!sub) {
        sub = await api.post<Submission>('/api/submissions', {
          designer, brand,
          company: company || undefined,
          email: email || undefined,
          country: country || undefined,
          eventId, packageId, addonIds,
          discountType: 'PCT',
          discountValue,
          deposit,
          paymentMethod,
          notes: notes || undefined,
        });
        createdRef.current = sub;
        // The sale is saved the moment this returns — reflect it in the lists
        // right away, even if attachments below fail.
        void qc.invalidateQueries({ queryKey: ['submissions'] });
        void qc.invalidateQueries({ queryKey: ['queue'] });
      }

      // Now that we have an id, flush the staged attachments to it. A file that
      // fails stays staged so the rep can retry without re-sending the sale.
      if (staged.length) {
        setUploading(true);
        const remaining: StagedFile[] = [];
        const failed: string[] = [];
        for (const s of staged) {
          try {
            await uploadDocument(sub.id, s.file, s.type);
          } catch {
            remaining.push(s);
            failed.push(s.file.name);
          }
        }
        setStaged(remaining);
        setUploading(false);
        if (failed.length) {
          throw new Error(
            `Submission saved, but these files did not upload: ${failed.join(', ')}. Retry to attach them.`,
          );
        }
      }

      return sub;
    },
    onSuccess: (sub) => {
      nav(`/submissions?created=${sub.ref}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  function onPickFiles(files: FileList | null) {
    if (!files?.length) return;
    setStaged((prev) => [
      ...prev,
      ...Array.from(files).map((file) => ({ file, type: attachType })),
    ]);
    if (fileRef.current) fileRef.current.value = '';
  }

  if (isLoading) {
    return (
      <Page crumb="Work" title="New submission">
        <div className="empty"><h3>Loading catalogue…</h3></div>
      </Page>
    );
  }

  const ready = designer && brand && eventId && packageId;

  return (
    <Page crumb="Work" title="New submission">
      <div className="split">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <div className="sect">
            <div className="hd"><h3>Customer</h3><span className="n">01</span></div>
            <div className="fields">
              <div className="f">
                <label>Designer name <span className="req">*</span></label>
                <input value={designer} onChange={(e) => setDesigner(e.target.value)} required />
              </div>
              <div className="f">
                <label>Brand <span className="req">*</span></label>
                <input value={brand} onChange={(e) => setBrand(e.target.value)} required />
              </div>
              <div className="f">
                <label>Company</label>
                <input value={company} onChange={(e) => setCompany(e.target.value)} />
              </div>
              <div className="f">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="f">
                <label>Country</label>
                <input value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="sect">
            <div className="hd"><h3>Event</h3><span className="n">02</span></div>
            <div className="tabs" style={{ marginBottom: 14 }}>
              {SEASON_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={'tab' + (season === t.key ? ' on' : '')}
                  onClick={() => chooseSeason(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="fields">
              <div className="f wide">
                <label>Show <span className="req">*</span></label>
                <select
                  value={eventId}
                  onChange={(e) => {
                    setEventId(e.target.value);
                    // The catalogue below is keyed off the event, so a stale
                    // package or add-on would be a sale that cannot exist.
                    setPackageId('');
                    setAddonIds([]);
                  }}
                  required
                >
                  <option value="">Select a show…</option>
                  {shows.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} — {ev.city.name} · {seasonLabel(ev.season)}
                    </option>
                  ))}
                </select>
                {event && (
                  <div className="help">
                    {event.venue} · {event.city.country} · prices in{' '}
                    {event.city.currency}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="sect">
            <div className="hd"><h3>Package</h3><span className="n">03</span></div>
            {!event ? (
              <p className="sm mut">Choose a show first — packages and prices differ by city.</p>
            ) : (
              <div className="checks">
                {packages.map((p) => {
                  const pr = p.prices.find((x) => x.cityId === event.cityId)!;
                  return (
                    <label key={p.id} className={'chk' + (packageId === p.id ? ' on' : '')}>
                      <input
                        type="radio"
                        name="pkg"
                        checked={packageId === p.id}
                        onChange={() => {
                          setPackageId(p.id);
                          setAddonIds([]);
                        }}
                      />
                      <span className="t">
                        <b>{p.name}</b>
                        <div className="sm mut">{p.looks} looks</div>
                      </span>
                      <span className="p">{money(pr.price, pr.currency)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="sect">
            <div className="hd"><h3>Add-on services</h3><span className="n">04</span></div>
            {!pkg ? (
              <p className="sm mut">Choose a package first.</p>
            ) : sellable.length === 0 ? (
              <p className="sm mut">No add-ons are sold in {currency} for this show.</p>
            ) : (
              <div className="checks">
                {sellable.map((a) => (
                  <label key={a.id} className={'chk' + (addonIds.includes(a.id) ? ' on' : '')}>
                    <input
                      type="checkbox"
                      checked={addonIds.includes(a.id)}
                      onChange={(e) =>
                        setAddonIds((prev) =>
                          e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                        )
                      }
                    />
                    <span className="t">
                      <b>{a.name}</b>
                      {a.note && <div className="sm mut">{a.note}</div>}
                    </span>
                    <span className="p">{money(a.price, a.currency)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="sect">
            <div className="hd"><h3>Pricing &amp; payment</h3><span className="n">05</span></div>
            <div className="fields">
              <div className="f">
                <label>Discount (%)</label>
                <input
                  type="number" min={0} max={100} step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(Number(e.target.value))}
                />
                {discountValue > 15 && (
                  <div className="help">Above 15% — Accounting must sign this off explicitly.</div>
                )}
              </div>
              <div className="f">
                <label>Deposit ({currency})</label>
                <input
                  type="number" min={0} step="0.01"
                  value={deposit}
                  onChange={(e) => setDeposit(Number(e.target.value))}
                />
              </div>
              <div className="f">
                <label>Payment method</label>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="sect">
            <div className="hd"><h3>Sales notes</h3><span className="n">06</span></div>
            <div className="f">
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="sect">
            <div className="hd"><h3>Attachments</h3><span className="n">07</span></div>
            <p className="sm mut" style={{ marginTop: 0 }}>
              Optional. Attach the signed contract, PO, receipt or any supporting
              media — they upload once the submission is sent.
            </p>
            <div className="rowflex upload" style={{ gap: 8, marginBottom: 12 }}>
              <select
                value={attachType}
                onChange={(e) => setAttachType(e.target.value as DocumentType)}
                disabled={create.isPending}
              >
                {(Object.keys(TYPE_LABEL) as DocumentType[]).map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
              <input
                ref={fileRef}
                type="file"
                multiple
                disabled={create.isPending}
                onChange={(e) => onPickFiles(e.target.files)}
              />
            </div>
            {staged.length > 0 && (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Type</th><th>File</th><th /></tr>
                  </thead>
                  <tbody>
                    {staged.map((s, i) => (
                      <tr key={`${s.file.name}-${i}`}>
                        <td className="sm">{TYPE_LABEL[s.type]}</td>
                        <td className="sm">
                          {s.file.name}
                          {s.file.size ? <span className="mut"> · {fmtSize(s.file.size)}</span> : null}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={create.isPending}
                            onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {error && <div className="note bad" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="rowflex">
            <button className="btn primary" disabled={!ready || create.isPending}>
              {uploading
                ? 'Uploading attachments…'
                : create.isPending
                  ? 'Sending…'
                  : createdRef.current
                    ? 'Retry attachments'
                    : 'Send to Accounting'}
            </button>
            <button type="button" className="btn" onClick={() => nav('/submissions')}>
              Cancel
            </button>
          </div>
        </form>

        <div className="card">
          <div className="hd">
            <h3>Live total</h3>
            <div className="sp" />
            {event && <span className={'tag ' + event.brand}>{event.brand}</span>}
          </div>
          <div className="bd">
            {!preview ? (
              <p className="sm mut">Pick a show and a package to see the total.</p>
            ) : (
              <div className="totals">
                <Row label="Package" value={money(preview.base, currency)} />
                <Row label="Add-ons" value={money(preview.addonTotal, currency)} />
                <Row label="Subtotal" value={money(preview.subtotal, currency)} />
                {preview.discount > 0 && (
                  <Row
                    label={`Discount (${discountValue}%)`}
                    value={'− ' + money(preview.discount, currency)}
                  />
                )}
                <Row label="Net revenue" value={money(preview.taxable, currency)} />
                <Row label={`Tax (${preview.rate}%)`} value={money(preview.tax, currency)} />
                <Row label="Total" value={money(preview.total, currency)} cls="big" />
                {deposit > 0 && (
                  <>
                    <Row label="Deposit" value={'− ' + money(deposit, currency)} />
                    <Row label="Balance due" value={money(preview.balance, currency)} cls="due" />
                  </>
                )}
              </div>
            )}
            <div className="note lock" style={{ marginTop: 14 }}>
              Indicative only. Accounting's figure is recomputed from the rate card on submit.
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
