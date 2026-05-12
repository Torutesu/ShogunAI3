import type React from 'react';

import { PaneGeneral } from './PaneGeneral';
import { PaneSystem } from './PaneSystem';
import { PaneAppearance } from './PaneAppearance';
import { PanePrivacy } from './PanePrivacy';
import { PaneData } from './PaneData';
import { PaneCloudMirror } from './PaneCloudMirror';
import { PaneHummingbird } from './PaneHummingbird';
import { PaneMeetings } from './PaneMeetings';
import { PaneChat } from './PaneChat';
import { PaneLLM } from './PaneLLM';
import { PaneIntegrations } from './PaneIntegrations';
import { PaneShortcuts } from './PaneShortcuts';
import { PaneTeam } from './PaneTeam';
import { PaneSupport } from './PaneSupport';
import { PaneKiokuGraph } from './PaneKiokuGraph';
import { PaneKiokuPatterns } from './PaneKiokuPatterns';
import { PaneKiokuLessons } from './PaneKiokuLessons';

export {
  PaneGeneral, PaneSystem, PaneAppearance, PanePrivacy, PaneData,
  PaneCloudMirror,
  PaneHummingbird, PaneMeetings, PaneChat, PaneLLM, PaneIntegrations,
  PaneShortcuts, PaneTeam, PaneSupport, PaneKiokuGraph, PaneKiokuPatterns,
  PaneKiokuLessons,
};

export const PANES: Record<string, React.ComponentType> = {
  general: PaneGeneral,
  system: PaneSystem,
  appearance: PaneAppearance,
  privacy: PanePrivacy,
  data: PaneData,
  cloud_mirror: PaneCloudMirror,
  hummingbird: PaneHummingbird,
  meetings: PaneMeetings,
  chat: PaneChat,
  llm: PaneLLM,
  integrations: PaneIntegrations,
  shortcuts: PaneShortcuts,
  team: PaneTeam,
  support: PaneSupport,
  kioku_graph: PaneKiokuGraph,
  kioku_patterns: PaneKiokuPatterns,
  kioku_lessons: PaneKiokuLessons,
};
