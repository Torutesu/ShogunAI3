export const SETTINGS_NAV = [
  {id:'general',      label:'General',            jp:'一般', icon:'settings'},
  {id:'system',       label:'System',             jp:'系統', icon:'terminal'},
  {id:'appearance',   label:'Appearance',         jp:'外観', icon:'eye'},
  {id:'privacy',      label:'Privacy Controls',   jp:'守秘', icon:'shield'},
  {id:'data',         label:'Data Controls',      jp:'資料', icon:'memory'},
  {id:'hummingbird',  label:'Hummingbird',        jp:'鳥',   icon:'zap'},
  {id:'meetings',     label:'Meetings',           jp:'会議', icon:'calendar'},
  {id:'chat',         label:'Chat',               jp:'対話', icon:'chat'},
  {id:'llm',          label:'Model & API',        jp:'モデル', icon:'key'},
  {id:'kioku_graph',    label:'KIOKU Graph',        jp:'記憶グラフ', icon:'memory'},
  {id:'kioku_patterns', label:'KIOKU Patterns',     jp:'常套',     icon:'clock'},
  {id:'kioku_lessons',  label:'KIOKU Lessons',      jp:'教訓',     icon:'graduation'},
  {id:'integrations',   label:'Integrations',       jp:'連携', icon:'plug'},
  {id:'shortcuts',    label:'Keyboard Shortcuts', jp:'捷径', icon:'keyboard'},
  {id:'team',         label:'Team',               jp:'組',   icon:'users'},
  {id:'support',      label:'Support',            jp:'支援', icon:'info'},
];

// Alias panes from quick menu to the canonical settings panes
export const PANE_ALIAS: Record<string, string> = {
  upgrade:'general', feedback:'support', download:'general',
  referral:'general', changelog:'general', api:'llm',
  brief: 'general',
};
