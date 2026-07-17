import { Icon } from '@/shared/icons';
import { MEETINGS_DOCK_SLASH_CATALOG } from '../lib/runtime';
import { toastM } from '../lib/runtime';
import { t } from '@/shared/lib/i18n';

export interface MtgChatDockProps {
  meetingsPrompt: string;
  setMeetingsPrompt: (v: string) => void;
  meetingsRecipeBrowse: boolean;
  setMeetingsRecipeBrowse: (fn: (v: boolean) => boolean) => void;
  showDockRecipeOverlay: boolean;
  filteredDockSlash: any[];
  allowServerMemoryAssembly: boolean;
  submitMeetingsPrompt: (e: any) => void;
  runDockSlashItem: (item: any) => void;
  runRuntimeAction: (action: string, payload: any, opts: any) => any;
}

export function MtgChatDock({
  meetingsPrompt,
  setMeetingsPrompt,
  meetingsRecipeBrowse,
  setMeetingsRecipeBrowse,
  showDockRecipeOverlay,
  filteredDockSlash,
  allowServerMemoryAssembly,
  submitMeetingsPrompt,
  runDockSlashItem,
  runRuntimeAction,
}: MtgChatDockProps) {
  return (
    <div className="screen-meetings-chatdock">
      <div className="screen-meetings-chatdock-inner">
        <div className="mtg-chatdock-panel" tabIndex={-1}>
          {showDockRecipeOverlay && filteredDockSlash.length > 0 && (
            <div className="mtg-recipe-overlay" role="listbox" aria-label="Commands">
              <div className="mtg-recipe-overlay-h">
                <span className="mtg-recipe-overlay-h-main">{meetingsRecipeBrowse ? 'Recipes' : 'Commands'}</span>
                <span className="mtg-recipe-overlay-h-jp jp dim">{meetingsRecipeBrowse ? 'レシピ' : 'コマンド'}</span>
                <span className="mtg-recipe-overlay-h-line" aria-hidden="true"/>
              </div>
              {filteredDockSlash.map(function (row) {
                var acc = row.accent || 'mint';
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="mtg-recipe-row"
                    onMouseDown={function (e) { e.preventDefault(); }}
                    onClick={function () { runDockSlashItem(row); }}
                  >
                    <span className={'mtg-recipe-icon mtg-recipe-icon--' + acc}>/</span>
                    <div style={{minWidth:0}}>
                      <div className="mtg-recipe-row-title">{row.label}</div>
                      <div className="mtg-recipe-row-desc">{row.desc}</div>
                      {row.jpHint && <div className="mtg-recipe-row-hint jp">{row.jpHint}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mtg-chatdock-top">
            <div className="mtg-chatdock-chips">
              <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[0]); }}>
                <Icon name="edit" size={12}/>
                <span className="en-only">List recent todos</span>
                <span className="jp" style={{fontSize:10}}>TODO</span>
              </button>
              <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[1]); }}>
                <Icon name="edit" size={12}/>
                <span>Coach me Matt</span>
              </button>
              <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[2]); }}>
                <Icon name="edit" size={12}/>
                <span className="en-only">Write weekly recap</span>
                <span className="jp" style={{fontSize:10}}>週報</span>
              </button>
            </div>
            <button
              type="button"
              className="mtg-chatdock-chip"
              style={{flexShrink:0}}
              onMouseDown={function (e) { e.preventDefault(); }}
              onClick={function () { setMeetingsRecipeBrowse(function (v) { return !v; }); }}
            >
              <Icon name="grid" size={12}/>
              <span className="en-only">All recipes</span>
              <span className="jp" style={{fontSize:10}}>全て</span>
            </button>
          </div>

          <form onSubmit={submitMeetingsPrompt}>
            <div className="mtg-chatdock-inputblock">
              <div className="mtg-chatdock-inputrow">
                <input
                  type="text"
                  value={meetingsPrompt}
                  onChange={function (e) {
                    var v = e.target.value;
                    setMeetingsPrompt(v);
                    if (v === '/') setMeetingsRecipeBrowse(function () { return false; });
                  }}
                  onKeyDown={function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submitMeetingsPrompt(e);
                    }
                  }}
                  placeholder="Ask anything"
                  aria-label="Ask anything"
                  autoComplete="off"
                  style={{
                    border:'none',
                    outline:'none',
                    background:'transparent',
                    color:'var(--text)',
                    fontSize:14,
                    fontFamily:'inherit',
                  }}
                />
                <span
                  className="mtg-chatdock-auto"
                  role="button"
                  tabIndex={0}
                  onMouseDown={function (e) { e.preventDefault(); }}
                  onClick={function () { toastM('Model: Auto', 'info'); }}
                  onKeyDown={function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toastM('Model: Auto', 'info'); } }}
                >
                  Auto <Icon name="chevronDown" size={10}/>
                </span>
                <button type="button" className="btn btn-sm btn-ghost" style={{padding:'0 6px'}} onMouseDown={function (e) { e.preventDefault(); }} onClick={function () {
                  var q = (meetingsPrompt || '').trim();
                  var payload: any = {
                    source: 'meetings_prompt',
                    action: 'attach',
                    target: 'document',
                    prompt: q || 'Meeting follow-up draft from dock',
                  };
                  if (allowServerMemoryAssembly) {
                    payload.memoryAssembly = {
                      query: q.slice(0, 480),
                      limit: 12,
                      semantic: true,
                    };
                  }
                  runRuntimeAction('draft.create', payload, { silentError: true }).then(function (r: any) {
                    if (r && r.ok) toastM(t('Draft generated (mock)', '下書きを生成しました（モック）'), 'success');
                    else toastM((r && r.error && r.error.message) || t('Could not produce a draft', '下書きできませんでした'), 'warn');
                  });
                }}><Icon name="paperclip" size={13}/></button>
                <button
                  type="submit"
                  className="mtg-chatdock-send"
                  disabled={!(meetingsPrompt || '').trim()}
                  title="Send"
                  aria-label="Send"
                >
                  <Icon name="arrowUp" size={17}/>
                </button>
              </div>
            </div>
          </form>
          <div className="mtg-chatdock-handle" aria-hidden="true"/>
        </div>
      </div>
    </div>
  );
}
