import { Database, Monitor, Palette, Shield, Trash2 } from 'lucide-react';
import { useAppStore, type AppTheme, type EditorThemeId } from '../../hooks/useAppStore';
import { refreshInlineDiagnostics, wipeStoredData } from '../../services/controller';
import { clearAllDocuments } from '../../services/workspaceStore';
import { EDITOR_THEMES } from '../Editor/themes';
import { Button, Dialog, Field, Segmented, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '../common/ui';

export function SettingsDialog() {
  const open = useAppStore((s) => s.dialogs.settings);
  const openDialog = useAppStore((s) => s.openDialog);
  const st = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  return (
    <Dialog open={open} onOpenChange={(o) => openDialog('settings', o)} title="Settings" description="Preferences are stored in this browser only (localStorage).">
      <Tabs defaultValue="appearance" className="flex min-h-[420px] flex-col sm:flex-row">
        <TabsList className="flex shrink-0 gap-1 border-b border-border p-2 sm:w-44 sm:flex-col sm:items-stretch sm:border-b-0 sm:border-r">
          <TabsTrigger value="appearance" className="justify-start">
            <Palette size={13} /> Appearance
          </TabsTrigger>
          <TabsTrigger value="editor" className="justify-start">
            <Monitor size={13} /> Editor
          </TabsTrigger>
          <TabsTrigger value="behavior" className="justify-start">
            <Database size={13} /> Behavior
          </TabsTrigger>
          <TabsTrigger value="privacy" className="justify-start">
            <Shield size={13} /> Privacy
          </TabsTrigger>
        </TabsList>
        <div className="min-w-0 flex-1 px-5 py-3">
          <TabsContent value="appearance">
            <Field label="App theme">
              <Segmented<AppTheme>
                label="App theme"
                value={st.appTheme}
                onChange={(v) => setSettings({ appTheme: v })}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </Field>
            <Field label="Editor theme">
              <Select<EditorThemeId>
                label="Editor theme"
                value={st.editorTheme}
                onChange={(v) => setSettings({ editorTheme: v })}
                options={[{ value: 'auto', label: 'Match app theme' }, ...EDITOR_THEMES.map((t) => ({ value: t.id as EditorThemeId, label: t.label }))]}
              />
            </Field>
            <Field label="Font size" hint="Editor text size in pixels">
              <input
                type="range"
                min={10}
                max={22}
                value={st.fontSize}
                onChange={(e) => setSettings({ fontSize: Number(e.target.value) })}
                className="w-40 accent-[var(--accent)]"
                aria-label="Font size"
              />
              <span className="w-8 text-right font-mono text-xs text-muted">{st.fontSize}</span>
            </Field>
            <Switch id="set-lig" checked={st.fontLigatures} onCheckedChange={(v) => setSettings({ fontLigatures: v })} label="Font ligatures" description="Render => and != as ligatures (JetBrains Mono)." />
          </TabsContent>
          <TabsContent value="editor">
            <Switch id="set-wrap" checked={st.wordWrap} onCheckedChange={(v) => setSettings({ wordWrap: v })} label="Word wrap" />
            <Switch id="set-minimap" checked={st.minimap} onCheckedChange={(v) => setSettings({ minimap: v })} label="Minimap" />
            <Switch id="set-sticky" checked={st.stickyScroll} onCheckedChange={(v) => setSettings({ stickyScroll: v })} label="Sticky scroll" description="Keep the enclosing object/element visible while scrolling." />
            <Switch id="set-ws" checked={st.renderWhitespace} onCheckedChange={(v) => setSettings({ renderWhitespace: v })} label="Show whitespace" />
            <Switch
              id="set-inline"
              checked={st.inlineDiagnostics}
              onCheckedChange={(v) => {
                setSettings({ inlineDiagnostics: v });
                setTimeout(refreshInlineDiagnostics, 0);
              }}
              label="Inline diagnostics"
              description="Show the first error or warning at the end of each affected line."
            />
          </TabsContent>
          <TabsContent value="behavior">
            <Switch id="set-live" checked={st.liveValidation} onCheckedChange={(v) => setSettings({ liveValidation: v })} label="Validate while typing" description="Re-detect and validate shortly after each edit. When off, use Validate (Shift+Alt+V)." />
            <Switch id="set-liveout" checked={st.liveOutput} onCheckedChange={(v) => setSettings({ liveOutput: v })} label="Live output" description="Re-run the last action (Beautify by default) whenever the input is valid." />
          </TabsContent>
          <TabsContent value="privacy">
            <div className="mb-2 rounded-lg border border-success/30 bg-success-soft p-3 text-[12px] leading-relaxed text-text">
              FormatX processes everything locally in a Web Worker. No document content is sent to any server, and nothing is stored unless you enable it below.
            </div>
            <Switch
              id="set-persist"
              checked={st.persistWorkspace}
              onCheckedChange={(v) => {
                setSettings({ persistWorkspace: v });
                if (!v) void clearAllDocuments();
              }}
              label="Remember workspace"
              description="Keep the current input and snapshots of recent documents in IndexedDB on this device, so they survive reloads. Turning this off deletes them."
            />
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <div className="text-[12.5px] font-medium text-text">Delete stored data</div>
                <div className="text-[11.5px] text-muted">Removes saved documents and the recent-operations history.</div>
              </div>
              <Button variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={() => void wipeStoredData()}>
                Delete
              </Button>
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </Dialog>
  );
}
