import { useState, useEffect } from "react";
import { Sidebar } from "./components/layout/sidebar";
import { ControlBar } from "./components/layout/control-bar";
import { SplitView } from "./components/dashboard/split-view";
import { AppGuard } from "./components/guard/AppGuard";
import { SettingsPage } from "./pages/settings-page";
import { RecordingsPage } from "./pages/recordings-page";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "./store/settings-store";
import { useSyncStore } from "./store/sync-store";
import { Toaster } from "sonner";
import { useConnectivity } from "@/hooks/use-connectivity";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { useUpdater } from "@/hooks/use-updater";
import { useAuthStore } from "@/store/auth-store";
import { MotdBanner } from "@/components/lifecycle/motd-banner";
import { TrialBanner } from "@/components/lifecycle/trial-banner";

function App() {
  useConnectivity();
  useUpdater();

  const [currentView, setCurrentView] = useState<'dashboard' | 'settings' | 'recordings'>('dashboard');
  const isSignedIn = useAuthStore((s) => s.isSignedIn);
  const { manualRefresh } = usePaymentRefresh();

  // Återställ molnläge för Pro-användare vars inställning nollställdes av v0.9.18-migrering.
  // Kör varje gång isSignedIn ändras (auth laddas asynkront efter mount).
  useEffect(() => {
    const { isPro } = useAuthStore.getState();
    const { recordingMode, modeExplicitlySet, defaultProMode, setRecordingMode } = useSettingsStore.getState();
    if (isPro() && !modeExplicitlySet && recordingMode === 'local') {
      setRecordingMode(defaultProMode);
      if (navigator.onLine) {
        useSyncStore.getState().setEffectiveMode(defaultProMode);
      }
    }
  }, [isSignedIn]);

  useEffect(() => {
    const state = useSettingsStore.getState();
    invoke("init_audio_engine", { device: state.inputDevice }).catch(console.error);
  }, []);

  // Hämta färsk Pro-status vid appstart och sedan var 60:e sekund.
  // Fångar upp avslutade eller nyaktiverade prenumerationer under aktiv session.
  useEffect(() => {
    if (!isSignedIn) return;
    manualRefresh();
    const id = setInterval(manualRefresh, 60_000);
    return () => clearInterval(id);
  }, [isSignedIn]);

  return (
    <AppGuard>
      <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-foreground font-sans antialiased text-sm">
        <Sidebar currentView={currentView} onViewChange={setCurrentView} />
        <main className="flex-1 flex flex-col h-full overflow-hidden relative">
          <MotdBanner />
          <TrialBanner />
          <div className="flex-1 overflow-hidden relative">
            {currentView === 'dashboard' ? <SplitView /> :
              currentView === 'settings' ? <SettingsPage /> :
                <RecordingsPage onViewChange={setCurrentView} />}
          </div>
          <ControlBar />
        </main>
      </div>
      <Toaster richColors position="bottom-right" />
    </AppGuard>
  );
}

export default App;
