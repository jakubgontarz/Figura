import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installSelectWheel } from './core/selectWheel.ts';
import { installTooltipSuppress } from './core/tooltipSuppress.ts';

import { applyTheme } from './core/Theme.ts';
import { settings } from './core/Settings.ts';

const syncTheme = () => applyTheme(settings.get().theme, settings.get().accent);
syncTheme();
settings.subscribe(syncTheme);
installSelectWheel();
installTooltipSuppress();

createRoot(document.getElementById('root')!).render(<App />);
