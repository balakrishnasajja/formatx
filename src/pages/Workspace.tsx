import { useEffect, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { InputPanel } from '../components/Editor/InputPanel';
import { BottomPanel } from '../components/ErrorPanel/BottomPanel';
import { Header } from '../components/Header/Header';
import { OutputPanel } from '../components/OutputPanel/OutputPanel';
import { Sidebar } from '../components/Sidebar/Sidebar';
import { StatusBar } from '../components/StatusBar/StatusBar';
import { useAppStore } from '../hooks/useAppStore';
import { useMediaQuery } from '../hooks/useTheme';

export function Workspace() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const bottomOpen = useAppStore((s) => s.bottomOpen);
  const set = useAppStore((s) => s.set);
  const narrow = useMediaQuery('(max-width: 900px)');
  const bottomRef = usePanelRef();
  // initial size follows the persisted open/closed state; later toggles use the imperative API
  const [initialBottom] = useState(() => (useAppStore.getState().bottomOpen ? '20' : '0'));

  useEffect(() => {
    const sync = () => {
      const p = bottomRef.current;
      if (!p) return false;
      if (bottomOpen && p.isCollapsed()) {
        p.expand();
        if (p.getSize().asPercentage < 15) p.resize('22');
      }
      if (!bottomOpen && !p.isCollapsed()) p.collapse();
      return true;
    };
    if (sync()) return;
    const raf = requestAnimationFrame(() => sync());
    return () => cancelAnimationFrame(raf);
  }, [bottomOpen, bottomRef]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <Header />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className={narrow ? 'absolute bottom-6 left-0 top-10 z-30 w-56 border-r border-border shadow-panel' : 'w-52 shrink-0 border-r border-border'}>
            <Sidebar />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Group orientation="vertical" className="h-full">
              <Panel id="editors" minSize="20%">
                <Group orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
                  <Panel id="input" defaultSize="50" minSize="15%">
                    <InputPanel />
                  </Panel>
                  <Separator className={narrow ? 'h-px' : 'w-px'} />
                  <Panel id="output" defaultSize="50" minSize="15%">
                    <OutputPanel />
                  </Panel>
                </Group>
              </Panel>
              <Separator className="h-px" />
              <Panel
                id="problems"
                panelRef={bottomRef}
                defaultSize={initialBottom}
                minSize="10%"
                collapsible
                collapsedSize="0%"
                onResize={(size) => {
                  const collapsed = size.asPercentage < 1;
                  if (collapsed === useAppStore.getState().bottomOpen) set({ bottomOpen: !collapsed });
                }}
              >
                <BottomPanel onCollapse={() => set({ bottomOpen: false })} />
              </Panel>
            </Group>
          </div>
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
