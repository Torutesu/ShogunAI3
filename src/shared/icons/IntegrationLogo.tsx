import React from 'react';
import { Icon } from './Icon';

// Brand marks under public/assets/integrations/ (served by Vite)
const INTEGRATION_ASSET_BASE = '/assets/integrations/';

export const IntegrationLogo = ({ slug, size = 30, title, className = '', style }) => {
  const C = typeof window !== 'undefined' ? (window as any).ShogunIntegrationConnectors : null;
  const file = C && slug ? C.getIconFile(slug) : null;
  const dim = Math.max(16, size - 8);
  if (!file) {
    return (
      <div
        className={`s-intg-icon ${className}`.trim()}
        style={{ width: size, height: size, ...style }}
        title={title}
        aria-hidden={!title}
      >
        <Icon name="plug" size={14} className="dim" />
      </div>
    );
  }
  return (
    <div
      className={`s-intg-icon s-intg-icon-brand ${className}`.trim()}
      style={{ width: size, height: size, ...style }}
      title={title}
      role="img"
      aria-label={title || slug}
    >
      <img
        src={INTEGRATION_ASSET_BASE + file}
        width={dim}
        height={dim}
        alt=""
        draggable={false}
        decoding="async"
      />
    </div>
  );
};

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).IntegrationLogo = IntegrationLogo;
}
