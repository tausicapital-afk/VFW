import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Catalog, Currency, Submission } from '../lib/types';
import { Page } from '../shell/Shell';

const PAYMENT_METHODS = [
  'Bank Transfer / Wire', 'Credit Card', 'Stripe', 'PayPal',
  'Cheque', 'Cash', 'Sponsored — No Charge',
];

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
  const [eventId, setEventId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [discountValue, setDiscountValue] = useState(0);
  const [deposit, setDeposit] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const event = catalog?.events.find((e) => e.id === eventId);

  // A package is only offered if it belongs to this event's brand AND carries a
  // price for the city the event runs in — the same two rules the server
  // enforces, so the form cannot compose a sale the API would reject.
  const packages = useMemo(() => {
    if (!catalog || !event) return [];
    return catalog.packages.filter(
      (p) => p.brand === event.brand && p.prices.some((pr) => pr.cityId === event.cityId),
    );
  }, [catalog, event]);

  const addons = useMemo(() => {
    if (!catalog || !event) return [];
    return catalog.addons.filter((a) => a.forBrands.includes(event.brand));
  }, [catalog, event]);

  const pkg = packages.find((p) => p.id === packageId);
  const price = pkg && event ? pkg.prices.find((pr) => pr.cityId === event.cityId) : undefined;
  const currency: Currency = price?.currency ?? 'USD';

  // Add-ons priced in another currency cannot go on this invoice; the server
  // rejects them, so grey them out rather than let the rep pick one.
  const sellable = addons.filter((a) => a.currency === currency);

  /**
   * A preview only. The server recomputes all of this from the catalog on
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

  const create = useMutation({
    mutationFn: () =>
      api.post<Submission>('/api/submissions', {
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
      }),
    onSuccess: (sub) => {
      void qc.invalidateQueries({ queryKey: ['submissions'] });
      void qc.invalidateQueries({ queryKey: ['queue'] });
      nav(`/submissions?created=${sub.ref}`);
    },
    onError: (e: Error) => setError(e.message),
  });

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
      <div className="cols">
        <div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
          >
            <div className="sect">
              <div className="hd"><h3>Customer</h3><span className="n">01</span></div>
              <div className="bd">
                <div className="grid2">
                  <div className="f">
                    <label>Designer name *</label>
                    <input value={designer} onChange={(e) => setDesigner(e.target.value)} required />
                  </div>
                  <div className="f">
                    <label>Brand *</label>
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
            </div>

            <div className="sect">
              <div className="hd"><h3>Event</h3><span className="n">02</span></div>
              <div className="bd">
                <div className="f">
                  <label>Show *</label>
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
                    {catalog?.events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name} — {ev.city.name} · {ev.season}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="sect">
              <div className="hd"><h3>Package</h3><span className="n">03</span></div>
              <div className="bd">
                {!event ? (
                  <p className="hint">Choose a show first — packages and prices differ by city.</p>
                ) : (
                  <div className="opts">
                    {packages.map((p) => {
                      const pr = p.prices.find((x) => x.cityId === event.cityId)!;
                      return (
                        <label key={p.id} className={'opt' + (packageId === p.id ? ' on' : '')}>
                          <input
                            type="radio"
                            name="pkg"
                            checked={packageId === p.id}
                            onChange={() => {
                              setPackageId(p.id);
                              setAddonIds([]);
                            }}
                          />
                          <div style={{ flex: 1 }}>
                            <b>{p.name}</b>
                            <div className="sm mut">{p.blurb}</div>
                          </div>
                          <div className="mono">{money(pr.price, pr.currency)}</div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="sect">
              <div className="hd"><h3>Add-on services</h3><span className="n">04</span></div>
              <div className="bd">
                {!pkg ? (
                  <p className="hint">Choose a package first.</p>
                ) : sellable.length === 0 ? (
                  <p className="hint">No add-ons are sold in {currency} for this show.</p>
                ) : (
                  <div className="opts">
                    {sellable.map((a) => (
                      <label key={a.id} className={'opt' + (addonIds.includes(a.id) ? ' on' : '')}>
                        <input
                          type="checkbox"
                          checked={addonIds.includes(a.id)}
                          onChange={(e) =>
                            setAddonIds((prev) =>
                              e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                            )
                          }
                        />
                        <div style={{ flex: 1 }}>
                          <b>{a.name}</b>
                          {a.note && <div className="sm mut">{a.note}</div>}
                        </div>
                        <div className="mono">{money(a.price, a.currency)}</div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="sect">
              <div className="hd"><h3>Pricing &amp; payment</h3><span className="n">05</span></div>
              <div className="bd">
                <div className="grid2">
                  <div className="f">
                    <label>Discount (%)</label>
                    <input
                      type="number" min={0} max={100} step="0.01"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(Number(e.target.value))}
                    />
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
            </div>

            <div className="sect">
              <div className="hd"><h3>Sales notes</h3><span className="n">06</span></div>
              <div className="bd">
                <div className="f">
                  <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
              </div>
            </div>

            {error && <div className="note bad" style={{ marginTop: 14 }}>{error}</div>}

            <div className="rowflex" style={{ marginTop: 18, gap: 10 }}>
              <button className="btn pri" disabled={!ready || create.isPending}>
                {create.isPending ? 'Sending…' : 'Send to Accounting'}
              </button>
              <button type="button" className="btn" onClick={() => nav('/submissions')}>
                Cancel
              </button>
            </div>
          </form>
        </div>

        <aside>
          <div className="card">
            <div className="hd">
              <h3>Live total</h3>
              <div className="sp" style={{ flex: 1 }} />
              {event && <span className={'tag ' + event.brand}>{event.brand}</span>}
            </div>
            <div className="bd">
              {!preview ? (
                <p className="hint">Pick a show and a package to see the total.</p>
              ) : (
                <div className="totals">
                  <div><span>Package</span><b className="mono">{money(preview.base, currency)}</b></div>
                  <div><span>Add-ons</span><b className="mono">{money(preview.addonTotal, currency)}</b></div>
                  <div><span>Subtotal</span><b className="mono">{money(preview.subtotal, currency)}</b></div>
                  {preview.discount > 0 && (
                    <div><span>Discount ({discountValue}%)</span>
                      <b className="mono">− {money(preview.discount, currency)}</b></div>
                  )}
                  <div><span>Net revenue</span><b className="mono">{money(preview.taxable, currency)}</b></div>
                  <div><span>Tax ({preview.rate}%)</span><b className="mono">{money(preview.tax, currency)}</b></div>
                  <div className="big"><span>Total</span><b className="mono">{money(preview.total, currency)}</b></div>
                  {deposit > 0 && (
                    <>
                      <div><span>Deposit</span><b className="mono">− {money(deposit, currency)}</b></div>
                      <div><span>Balance due</span><b className="mono">{money(preview.balance, currency)}</b></div>
                    </>
                  )}
                </div>
              )}
              <div className="note lock" style={{ marginTop: 14 }}>
                Indicative only. Accounting's figure is recomputed from the rate card on submit.
              </div>
            </div>
          </div>
        </aside>
      </div>
    </Page>
  );
}
