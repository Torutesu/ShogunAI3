import React from 'react';
import { PRODUCT } from '../lib/defaults';

/** In notices when hosted Terms URL may be unset — underline non-link. */
export function TermsNoticeAnchor({ children }: { children: React.ReactNode }) {
  const href = PRODUCT.termsJaUrl || PRODUCT.termsEnUrl;
  if (!href) {
    return (
      <span
        className="s-link"
        style={{ cursor: 'help', textDecoration: 'underline dotted' }}
        title="See TERMS_OF_SERVICE.md and TERMS_OF_SERVICE_EN.md included with your purchase"
      >
        {children}
      </span>
    );
  }
  return (
    <a className="s-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
