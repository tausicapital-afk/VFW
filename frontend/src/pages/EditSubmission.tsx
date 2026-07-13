import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Catalog, Currency, Submission } from '../lib/types';
import { Page } from '../shell/Shell';

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

/**
 * Edit and resubmit a DRAFT or RETURNED submission. The form mirrors New
 * submission: the client sends what was *sold*, and the server re-prices it from
 * the catalogue on save — the preview here is indicative only.
 */
export function EditSubmission() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: sub, isLoading, error } = useQuery({
    queryKey: ['submission', id],
    queryFn: () => api.get<Submission>(`/api/submissions/${id}`),
  });

  const { data: catalog } = useQuery({
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
  const [showDate, setShowDate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Seed the form once, from the loaded record.
  useEffect(() => {
    if (!sub || seeded) return;
    setDesigner(sub.contact.designer);
    setBrand(sub.contact.brand);
    setCompany(sub.contact.company ?? '');
    setEmail(sub.contact.email ?? '');
    setCountry(sub.contact.country ?? '');
    setEventId(sub.event.id);
    setPackageId(sub.package.id);
    setAddonIds(sub.addons.map((a) => a.addonId));
    setDiscountValue(Number(sub.discountValue));
    setDeposit(Number(sub.deposit));
    setPaymentMethod(sub.paymentMethod ?? PAYMENT_METHODS[0]);
    setNotes(sub.notes ?? '');
    setShowDate(sub.showDate ? sub.showDate.slice(0, 10) : '');
    setSeeded(true);
  }, [sub, seeded]);

  const event = catalog?.events.find((e) => e.id === eventId);

  const packages = useMemo(() => {
    if (!catalog || !event) return [];
    return catalog.packages.filter(
      (p) => p.brand === event.brand && p.prices.some((pr) => pr.cityId === event.cityId),
    );
  }, [catalog, event]);

  const pkg = packages.find((p) => p.id === packageId);
  const price = pkg && event ? pkg.prices.find((pr) => pr.cityId === event.cityId) : undefined;
  const currency: Currency = price?.currency ?? 'USD';

  const sellable = useMemo(() => {
    if (!catalog || !event || !price) return [];
    return catalog.addons.filter(
      (a) => a.forBrands.includes(event.brand) && a.currency === price.currency,
    );
  }, [catalog, event, price]);

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

  const resubmit = useMutation({
    mutationFn: () =>
      api.put<Submission>(`/api/submissions/${id}`, {
        designer, brand,
        company: company || undefined,
        email: email || undefined,
        country: country || undefined,
        eventId, packageId, addonIds,
        discountType: 'PCT',
        discountValue,
        deposit,
        paymentMethod,
        showDate: showDate || undefined,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['submissions'] });
      void qc.invalidateQueries({ queryKey: ['queue'] });
      void qc.invalidateQueries({ queryKey: ['submission', id] });
      nav(`/submissions/${id}`);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  if (isLoading) {
    return <Page crumb="Work" title="Edit"><div className="empty"><h3>Loading…</h3></div></Page>;
  }
  if (error || !sub) {
    return (
      <Page crumb="Work" title="Not found">
        <div className="empty">
          <h3>Submission not found</h3>
          <p>It may belong to another representative, or the link is stale.</p>
        </div>
      </Page>
    );
  }

  const editable =
    sub.rep.id === user?.id &&
    ['DRAFT', 'RETURNED'].includes(sub.status) &&
    can('submission.editOwn', user?.role);

  if (!editable) {
    return (
      <Page crumb="Work" title="Cannot edit">
        <div className="empty">
          <h3>This submission cannot be edited</h3>
          <p>Only your own draft or returned submissions can be corrected and resubmitted.</p>
        </div>
      </Page>
    );
  }

  const ready = designer && brand && eventId && packageId;

  return (
    <Page crumb="Work / Submissions" title={`Edit ${sub.ref}`}>
      {sub.status === 'RETURNED' && sub.returnNote && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <b>Returned by Accounting:</b> {sub.returnNote}
        </div>
      )}
      <div className="split">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            resubmit.mutate();
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
            <div className="fields">
              <div className="f wide">
                <label>Show <span className="req">*</span></label>
                <select
                  value={eventId}
                  onChange={(e) => {
                    setEventId(e.target.value);
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
                {event && (
                  <div className="help">
                    {event.venue} · {event.city.country} · prices in {event.city.currency}
                  </div>
                )}
              </div>
              <div className="f">
                <label>Show date</label>
                <input type="date" value={showDate} onChange={(e) => setShowDate(e.target.value)} />
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

          {formError && <div className="note bad" style={{ marginBottom: 14 }}>{formError}</div>}

          <div className="rowflex">
            <button className="btn primary" disabled={!ready || resubmit.isPending}>
              {resubmit.isPending ? 'Resubmitting…' : 'Resubmit to Accounting'}
            </button>
            <button type="button" className="btn" onClick={() => nav(`/submissions/${id}`)}>
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
                  <Row label={`Discount (${discountValue}%)`} value={'− ' + money(preview.discount, currency)} />
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
              Indicative only. Accounting's figure is recomputed from the rate card on resubmit.
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
