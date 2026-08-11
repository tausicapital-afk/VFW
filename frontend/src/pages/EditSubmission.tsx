import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { discountPctOfPackage, discountPreview } from '../lib/pricing';
import type { Catalog, Currency, DiscountType, Submission } from '../lib/types';
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
 * Edit a submission that has not been decided yet (draft, returned, pending), or
 * amend one that has (approved, exported) if you are Accounting. The form mirrors New
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
  const [season, setSeason] = useState('');
  const [eventId, setEventId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);

  // Per-sale package customization — see NewSubmission.tsx for the mechanism.
  const [customize, setCustomize] = useState(false);
  const [fullyCustom, setFullyCustom] = useState(false);
  const [overrideName, setOverrideName] = useState('');
  const [overrideLooks, setOverrideLooks] = useState('');
  const [overrideBlurb, setOverrideBlurb] = useState('');
  const [overridePrice, setOverridePrice] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('PCT');
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
    setSeason(sub.event.season);
    setEventId(sub.event.id);
    setPackageId(sub.package.id);
    setAddonIds(sub.addons.map((a) => a.addonId));
    setCustomize(sub.packageCustomized);
    setFullyCustom(
      sub.packageCustomized &&
      sub.packageNameOverride != null && sub.packageLooksOverride != null &&
      sub.packageBlurbOverride != null && sub.packagePriceOverride != null,
    );
    setOverrideName(sub.packageNameOverride ?? sub.package.name);
    setOverrideLooks(String(sub.packageLooksOverride ?? sub.package.looks));
    setOverrideBlurb(sub.packageBlurbOverride ?? sub.package.blurb ?? '');
    setOverridePrice(sub.packagePriceOverride ?? sub.packagePrice);
    setDiscountType(sub.discountType);
    setDiscountValue(Number(sub.discountValue));
    setDeposit(Number(sub.deposit));
    setPaymentMethod(sub.paymentMethod ?? PAYMENT_METHODS[0]);
    setNotes(sub.notes ?? '');
    setShowDate(sub.showDate ? sub.showDate.slice(0, 10) : '');
    setSeeded(true);
  }, [sub, seeded]);

  const event = catalog?.events.find((e) => e.id === eventId);

  // Defaults to the first season in the catalogue until seeded from the record
  // or picked by hand.
  const activeSeason = season || catalog?.seasons[0]?.label || '';

  // The Show list is narrowed to the chosen season — drawn from the Seasons
  // catalogue an admin maintains under Packages & pricing, the same vocabulary
  // a show's own `season` is copied from when it is added there.
  const shows = useMemo(
    () => catalog?.events.filter((ev) => ev.season === activeSeason) ?? [],
    [catalog, activeSeason],
  );

  // Switching seasons drops a show that no longer belongs — and with it the
  // package and add-ons that were keyed off that show.
  function chooseSeason(next: string) {
    setSeason(next);
    if (event && event.season !== next) {
      setEventId('');
      setPackageId('');
      setAddonIds([]);
    }
  }

  const packages = useMemo(() => {
    if (!catalog || !event) return [];
    return catalog.packages.filter(
      (p) => p.brand === event.brand && p.prices.some((pr) => pr.cityId === event.cityId),
    );
  }, [catalog, event]);

  const pkg = packages.find((p) => p.id === packageId);
  const price = pkg && event ? pkg.prices.find((pr) => pr.cityId === event.cityId) : undefined;
  const currency: Currency = price?.currency ?? 'USD';

  function toggleCustomize(on: boolean) {
    setCustomize(on);
    if (on && pkg && price) {
      setOverrideName(pkg.name);
      setOverrideLooks(String(pkg.looks));
      setOverrideBlurb(pkg.blurb ?? '');
      setOverridePrice(String(price.price));
    } else {
      setFullyCustom(false);
      setOverrideName(''); setOverrideLooks(''); setOverrideBlurb(''); setOverridePrice('');
    }
  }

  function toggleFullyCustom(on: boolean) {
    setFullyCustom(on);
    if (on) {
      setOverrideName(''); setOverrideLooks(''); setOverrideBlurb(''); setOverridePrice('');
    } else if (pkg && price) {
      setOverrideName(pkg.name);
      setOverrideLooks(String(pkg.looks));
      setOverrideBlurb(pkg.blurb ?? '');
      setOverridePrice(String(price.price));
    }
  }

  const overridePriceNum = customize && overridePrice.trim() !== '' ? Number(overridePrice) : null;
  const customPackageReady =
    !customize || !fullyCustom ||
    (overrideName.trim() !== '' && Number(overrideLooks) > 0 && overridePrice.trim() !== '');

  const sellable = useMemo(() => {
    if (!catalog || !event || !price) return [];
    return catalog.addons.filter(
      (a) => a.forBrands.includes(event.brand) && a.currency === price.currency,
    );
  }, [catalog, event, price]);

  const preview = useMemo(() => {
    if (!pkg || !price || !catalog) return null;
    const base = overridePriceNum ?? Number(price.price);
    const addonTotal = sellable
      .filter((a) => addonIds.includes(a.id))
      .reduce((t, a) => t + Number(a.price), 0);
    const subtotal = base + addonTotal;
    const discount = discountPreview(base, discountType, discountValue);
    const taxable = Math.max(0, subtotal - discount);
    const rate = Number(catalog.taxes.find((t) => t.code === pkg.taxCode)?.rate ?? 0);
    const tax = Math.round(taxable * (rate / 100) * 100) / 100;
    const total = Math.round((taxable + tax) * 100) / 100;
    return { base, addonTotal, subtotal, discount, taxable, rate, tax, total, balance: total - deposit };
  }, [pkg, price, catalog, sellable, addonIds, discountType, discountValue, deposit, overridePriceNum]);

  const resubmit = useMutation({
    mutationFn: () =>
      api.put<Submission>(`/api/submissions/${id}`, {
        designer, brand,
        company: company || undefined,
        email: email || undefined,
        country: country || undefined,
        eventId, packageId, addonIds,
        ...(customize ? {
          packageNameOverride: overrideName.trim() || undefined,
          packageLooksOverride: overrideLooks.trim() !== '' ? Number(overrideLooks) : undefined,
          packageBlurbOverride: overrideBlurb.trim() || undefined,
          packagePriceOverride: overridePrice.trim() !== '' ? Number(overridePrice) : undefined,
        } : {}),
        discountType,
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

  // The same rule the server enforces in update(). Undecided sales — draft,
  // returned, and now pending — are correctable by whoever owns them; an approved
  // or exported one is an amendment, and only Accounting/Admin may make it.
  const decided = ['APPROVED', 'EXPORTED'].includes(sub.status);
  const mine = sub.rep.id === user?.id && can('submission.editOwn', user?.role);
  const editable = decided
    ? can('submission.editAny', user?.role)
    : ['DRAFT', 'RETURNED', 'PENDING'].includes(sub.status) &&
      (mine || can('submission.editAny', user?.role));

  if (!editable) {
    return (
      <Page crumb="Work" title="Cannot edit">
        <div className="empty">
          <h3>This submission cannot be edited</h3>
          <p>
            {decided
              ? 'This sale is approved. Only Accounting or an administrator can amend it now.'
              : sub.status === 'VOIDED'
                ? 'This sale is voided. Restore it before editing.'
                : 'This sale was rejected. It has to be returned to sales before it can be edited.'}
          </p>
        </div>
      </Page>
    );
  }

  const ready = designer && brand && eventId && packageId && customPackageReady;

  return (
    <Page crumb="Work / Submissions" title={`${decided ? 'Amend' : 'Edit'} ${sub.ref}`}>
      {sub.status === 'RETURNED' && sub.returnNote && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <b>Returned by Accounting:</b> {sub.returnNote}
        </div>
      )}
      {sub.status === 'PENDING' && (
        <div className="note" style={{ marginBottom: 16 }}>
          This sale is queued for approval. Saving keeps it in the queue in its current
          place — it is a correction, not a resubmission.
        </div>
      )}
      {decided && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <b>This sale is already approved.</b> Saving re-prices it and keeps the approval —
          it does not go back through the queue.
          {sub.status === 'EXPORTED' && (
            <>
              {' '}It has also been exported to QuickBooks
              {sub.qbDocNumber ? ` as ${sub.qbDocNumber}` : ''}, and those figures will
              <b> not</b> change. Re-sync them by hand.
            </>
          )}
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
              <div className="f">
                <label>Season <span className="req">*</span></label>
                {catalog && catalog.seasons.length === 0 ? (
                  <p className="sm mut" style={{ marginTop: 0 }}>
                    No seasons yet — ask an admin to add one under Packages &amp; pricing.
                  </p>
                ) : (
                  <select value={activeSeason} onChange={(e) => chooseSeason(e.target.value)}>
                    {/* This sale's season may since have been renamed or deleted —
                        kept as an extra option so seeding never silently switches it. */}
                    {activeSeason && !catalog?.seasons.some((s) => s.label === activeSeason) && (
                      <option value={activeSeason}>{activeSeason}</option>
                    )}
                    {catalog?.seasons.map((s) => (
                      <option key={s.id} value={s.label}>{s.label}</option>
                    ))}
                  </select>
                )}
              </div>
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
                  {shows.map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.name} — {ev.city.name}</option>
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
                          setCustomize(false);
                          setFullyCustom(false);
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
            {pkg && price && (
              <div style={{ marginTop: 14 }}>
                <label className="chk" style={{ marginBottom: customize ? 10 : 0 }}>
                  <input
                    type="checkbox"
                    checked={customize}
                    onChange={(e) => toggleCustomize(e.target.checked)}
                  />
                  <span className="t">
                    <b>Customize this package for this sale</b>
                    <div className="sm mut">
                      Override the price and/or the name, looks and description shown to this client.
                    </div>
                  </span>
                </label>
                {customize && (
                  <>
                    <label className="chk" style={{ marginBottom: 10 }}>
                      <input
                        type="checkbox"
                        checked={fullyCustom}
                        onChange={(e) => toggleFullyCustom(e.target.checked)}
                      />
                      <span className="t">
                        <b>Fully custom package (not on the rate card)</b>
                        <div className="sm mut">
                          Build this line from scratch instead of starting from {pkg.name}.
                        </div>
                      </span>
                    </label>
                    <div className="fields">
                      <div className="f wide">
                        <label>Package name</label>
                        <input value={overrideName} onChange={(e) => setOverrideName(e.target.value)} />
                      </div>
                      <div className="f">
                        <label>Looks</label>
                        <input
                          type="number" min={0}
                          value={overrideLooks}
                          onChange={(e) => setOverrideLooks(e.target.value)}
                        />
                      </div>
                      <div className="f">
                        <label>Price ({currency})</label>
                        <input
                          type="number" min={0} step="0.01"
                          value={overridePrice}
                          onChange={(e) => setOverridePrice(e.target.value)}
                        />
                      </div>
                      <div className="f wide">
                        <label>Description (optional)</label>
                        <input value={overrideBlurb} onChange={(e) => setOverrideBlurb(e.target.value)} />
                      </div>
                    </div>
                    <div className="help">
                      Customized packages are flagged for Accounting and need explicit sign-off at
                      approval.
                    </div>
                  </>
                )}
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
                <label>Discount</label>
                <div className="rowflex" style={{ gap: 8 }}>
                  <select
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as DiscountType)}
                    style={{ maxWidth: 150 }}
                  >
                    <option value="PCT">Percentage (%)</option>
                    <option value="AMT">Amount ({currency})</option>
                  </select>
                  <input
                    type="number" min={0} max={discountType === 'PCT' ? 100 : undefined} step="0.01"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(Number(e.target.value))}
                  />
                </div>
                <div className="help">Applies to the package price only — add-ons are never discounted.</div>
                {discountPctOfPackage(preview?.base ?? 0, discountType, discountValue) > 15 && (
                  <div className="help">Above 15% of the package — Accounting must sign this off explicitly.</div>
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
              {resubmit.isPending
                ? 'Saving…'
                : decided
                  ? 'Save amendment'
                  : sub.status === 'PENDING'
                    ? 'Save correction'
                    : 'Resubmit to Accounting'}
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
                  <Row
                    label={discountType === 'PCT' ? `Discount (${discountValue}% of package)` : 'Discount (package)'}
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
              Indicative only. Accounting's figure is recomputed from the rate card on save.
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
