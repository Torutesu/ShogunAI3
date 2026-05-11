import type * as React from 'react';
import { Icon } from './Icon';
import { ShogunIntegrationConnectors } from '@/shared/lib/integration-connectors';

// Brand marks under public/assets/integrations/ (served by Vite)
const INTEGRATION_ASSET_BASE = '/assets/integrations/';

interface IntegrationLogoProps {
  slug?: string;
  size?: number;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const IntegrationLogo = ({ slug, size = 30, title, className = '', style }: IntegrationLogoProps) => {
  const C = ShogunIntegrationConnectors;
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
