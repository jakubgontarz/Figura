import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installSelectWheel } from './core/selectWheel.ts';
import { installTooltipSuppress } from './core/tooltipSuppress.ts';

import { applyTheme } from './core/Theme.ts';
import { settings } from './core/Settings.ts';
import { initPersist } from './core/Persist.ts';
import { WindowResizeHandles } from './components/WindowResizeHandles.tsx';
import { restoreWindowState, trackWindowState } from './platform/windowState.ts';

const syncTheme = () => applyTheme(settings.get().theme, settings.get().accent);
syncTheme();
settings.subscribe(syncTheme);
installSelectWheel();
installTooltipSuppress();

// W aplikacji Tauri ustawienia i presety leżą w pliku w folderze użytkownika: wczytujemy je przed startem interfejsu
void initPersist()
  .then(() => settings.reload())
  .catch(() => {})
  .then(() => restoreWindowState())
  .then(() => {
    trackWindowState();
    createRoot(document.getElementById('root')!).render(
      <>
        <App />
        <WindowResizeHandles />
      </>
    );
  });
