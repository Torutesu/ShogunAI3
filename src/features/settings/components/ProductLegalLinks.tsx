import { Icon } from '@/shared/icons';
import { PRODUCT } from '../lib/defaults';

export function ProductLegalLinks() {
  const hasHosted = !!(PRODUCT.termsJaUrl || PRODUCT.termsEnUrl || PRODUCT.privacyUrl);
  return (
    <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      {PRODUCT.termsJaUrl ? (
        <a className="s-link" href={PRODUCT.termsJaUrl} target="_blank" rel="noopener noreferrer">
          Terms / 利用規約（日本語） <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      {PRODUCT.termsEnUrl ? (
        <a className="s-link" href={PRODUCT.termsEnUrl} target="_blank" rel="noopener noreferrer">
          Terms (English) <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      {PRODUCT.privacyUrl ? (
        <a className="s-link" href={PRODUCT.privacyUrl} target="_blank" rel="noopener noreferrer">
          Privacy / プライバシー <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      <a className="s-link" href={PRODUCT.supportMailto}>
        Contact support / サポート <Icon name="arrowUpRight" size={10} />
      </a>
      {!hasHosted ? (
        <span className="s-field-hint" style={{ fontSize: 11, maxWidth: 420 }}>
          Full legal text is supplied as markdown with your license (JP/EN Terms + Privacy). Host URLs in PRODUCT.* in source when you publish web pages.
        </span>
      ) : null}
    </div>
  );
}
