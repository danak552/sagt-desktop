import { Home, Mic, Settings, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SidebarProps {
    currentView: 'dashboard' | 'settings' | 'recordings';
    onViewChange: (view: 'dashboard' | 'settings' | 'recordings') => void;
}

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
    return (
        <div className="w-64 border-r h-full bg-white/80 backdrop-blur-md flex flex-col">
            <div className="p-6">
                <div
                    className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onViewChange('dashboard')}
                    role="button"
                    tabIndex={0}
                >
                    <div className="h-6 w-6 bg-primary rounded-md flex items-center justify-center">
                        <Activity className="h-4 w-4 text-primary-foreground" />
                    </div>
                    <h1 className="text-lg font-bold tracking-tight">Sagt.ai</h1>
                </div>
            </div>
            <nav className="flex-1 px-4 space-y-2">
                <Button
                    variant={currentView === 'dashboard' ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2"
                    onClick={() => onViewChange('dashboard')}
                >
                    <Home className="w-4 h-4" />
                    Hem
                </Button>
                <Button
                    variant={currentView === 'recordings' ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2"
                    onClick={() => onViewChange('recordings')}
                >
                    <Mic className="w-4 h-4" />
                    Inspelningar
                </Button>
                <Button
                    variant={currentView === 'settings' ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2"
                    onClick={() => onViewChange('settings')}
                >
                    <Settings className="w-4 h-4" />
                    Inställningar
                </Button>
            </nav>
        </div>
    );
}
