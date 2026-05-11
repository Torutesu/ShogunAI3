import { useState } from 'react';
import { TabQueryTester } from './components/TabQueryTester';
import { TabKiokuStats } from './components/TabKiokuStats';
import { TabRecentCalls } from './components/TabRecentCalls';
import { TabSyncHealth } from './components/TabSyncHealth';
import { TabDbStats } from './components/TabDbStats';

type TabId = "query" | "recent" | "sync" | "stats" | "kioku";

function tabLabel(t: TabId): string {
  switch (t) {
    case "query": return "Query Tester";
    case "recent": return "Recent Calls";
    case "sync": return "Sync Health";
    case "stats": return "DB Stats";
    case "kioku": return "KIOKU Graph";
    default: return t;
  }
}

const TABS: TabId[] = ["query", "recent", "sync", "stats", "kioku"];

export function MemoryDebugScreen() {
  const [tab, setTab] = useState<TabId>("query");

  return (
    <div className="content-memory-debug">
      <div className="mdbg-header">
        <h1>Memory Debugger (dev)</h1>
        <div className="mdbg-tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {tabLabel(t)}
            </button>
          ))}
        </div>
      </div>
      {tab === "query" && <TabQueryTester />}
      {tab === "recent" && <TabRecentCalls />}
      {tab === "sync" && <TabSyncHealth />}
      {tab === "stats" && <TabDbStats />}
      {tab === "kioku" && <TabKiokuStats />}
    </div>
  );
}
