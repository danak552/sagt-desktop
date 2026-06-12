import { Home, Mic, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SidebarProps {
    currentView: 'dashboard' | 'settings' | 'recordings';
    onViewChange: (view: 'dashboard' | 'settings' | 'recordings') => void;
}

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
    return (
        <div className="w-64 border-r h-full bg-paper/80 backdrop-blur-md flex flex-col">
            <nav className="flex-1 px-4 pt-4 space-y-2">
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
