import { Row } from '../../components/Row';
import { Toggle } from '../../components/Toggle';

interface IncognitoSectionProps {
  apps: any[];
  sites: any[];
  incognitoEnabled: boolean;
  setIncognitoEnabled: (v: boolean) => void;
  incognitoBrowsers: Record<string, boolean>;
  setIncognitoBrowsers: (v: any) => void;
  persistPrivacy: (apps: any[], sites: any[], overrides?: any) => Promise<any>;
}

const BROWSER_ROWS = [
  { key: 'safari', label: 'Safari (and Technology Preview)' },
  { key: 'chrome', label: 'Chrome / Chromium / Brave / Opera / Vivaldi' },
  { key: 'arc', label: 'Arc' },
  { key: 'firefox', label: 'Firefox (and Developer / Nightly)' },
  { key: 'edge', label: 'Microsoft Edge' },
];

export function IncognitoSection({
  apps,
  sites,
  incognitoEnabled,
  setIncognitoEnabled,
  incognitoBrowsers,
  setIncognitoBrowsers,
  persistPrivacy,
}: IncognitoSectionProps) {
  return (
    <div className="s-card" style={{ marginBottom: 14 }}>
      <Row
        title="Private browsing"
        desc="Skip captures when a supported browser's window is in incognito / private mode (detected from the window title)."
      >
        <Toggle
          on={incognitoEnabled}
          onClick={async () => {
            const next = !incognitoEnabled;
            setIncognitoEnabled(next);
            await persistPrivacy(apps, sites, { incognitoEnabled: next });
          }}
        />
      </Row>
      {BROWSER_ROWS.map((row, i, arr) => (
        <Row
          key={row.key}
          title={row.label}
          desc={`Match incognito titles for ${row.label}.`}
          last={i === arr.length - 1}
        >
          <Toggle
            on={!!(incognitoBrowsers as any)[row.key]}
            onClick={async () => {
              const next = { ...incognitoBrowsers, [row.key]: !(incognitoBrowsers as any)[row.key] };
              setIncognitoBrowsers(next);
              await persistPrivacy(apps, sites, { incognitoBrowsers: next });
            }}
          />
        </Row>
      ))}
    </div>
  );
}
