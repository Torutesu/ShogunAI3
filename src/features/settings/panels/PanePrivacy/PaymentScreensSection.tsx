import { Row } from '../../components/Row';
import { Toggle } from '../../components/Toggle';

export interface PaymentDomain {
  id: string;
  host: string;
  label: string;
  enabled: boolean;
}

interface PaymentScreensSectionProps {
  apps: any[];
  sites: any[];
  paymentEnabled: boolean;
  setPaymentEnabled: (v: boolean) => void;
  paymentDetectCard: boolean;
  setPaymentDetectCard: (v: boolean) => void;
  paymentDomains: PaymentDomain[];
  setPaymentDomains: (v: any) => void;
  paymentDraft: string;
  setPaymentDraft: (v: string) => void;
  persistPrivacy: (apps: any[], sites: any[], overrides?: any) => Promise<any>;
  addPaymentDomain: () => Promise<void>;
}

export function PaymentScreensSection({
  apps,
  sites,
  paymentEnabled,
  setPaymentEnabled,
  paymentDetectCard,
  setPaymentDetectCard,
  paymentDomains,
  setPaymentDomains,
  paymentDraft,
  setPaymentDraft,
  persistPrivacy,
  addPaymentDomain,
}: PaymentScreensSectionProps) {
  return (
    <div className="s-card" style={{ marginBottom: 14 }}>
      <Row
        title="Payment screens"
        desc="Skip captures when the screen looks like a payment page (URL or card-shaped digits next to a CVV label)."
      >
        <Toggle
          on={paymentEnabled}
          onClick={async () => {
            const next = !paymentEnabled;
            setPaymentEnabled(next);
            await persistPrivacy(apps, sites, { paymentEnabled: next });
          }}
        />
      </Row>
      <Row
        title="Also detect card-number patterns"
        desc="Heuristic: 13–19 digit runs co-occurring with a CVV/CVC label. Disable if you see false positives."
        last
      >
        <Toggle
          on={paymentDetectCard}
          onClick={async () => {
            const next = !paymentDetectCard;
            setPaymentDetectCard(next);
            await persistPrivacy(apps, sites, { paymentDetectCard: next });
          }}
        />
      </Row>
      <div style={{ padding: '0 16px 14px' }}>
        <div className="s-field-hint" style={{ marginBottom: 8, fontSize: 11 }}>
          Payment domains (suffix-matched, e.g. <code>stripe.com</code> also covers <code>checkout.stripe.com</code>):
        </div>
        {paymentDomains.length === 0 ? (
          <div className="s-field-hint" style={{ padding: 8 }}>No domains.</div>
        ) : (
          <div className="s-card" style={{ marginBottom: 8 }}>
            {paymentDomains.map((d, i, arr) => (
              <div key={d.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{d.host}</div>
                  {d.label && d.label !== d.host ? (
                    <div className="s-field-hint" style={{ fontSize: 11 }}>{d.label}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ marginRight: 8 }}
                  title="Remove from list"
                  onClick={async () => {
                    const next = paymentDomains.filter((x) => x.id !== d.id);
                    setPaymentDomains(next);
                    await persistPrivacy(apps, sites, { paymentDomains: next });
                  }}
                >
                  ×
                </button>
                <Toggle
                  on={d.enabled}
                  onClick={async () => {
                    const next = paymentDomains.map((x) =>
                      x.id === d.id ? { ...x, enabled: !x.enabled } : x,
                    );
                    setPaymentDomains(next);
                    await persistPrivacy(apps, sites, { paymentDomains: next });
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <input
            className="s-input"
            style={{ flex: 1 }}
            placeholder="e.g. checkout.example.com"
            value={paymentDraft}
            onChange={(e) => setPaymentDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addPaymentDomain();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void addPaymentDomain()}
          >
            Add domain
          </button>
        </div>
      </div>
    </div>
  );
}
