import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installSelectWheel } from './core/selectWheel.ts';
import { installTooltipSuppress } from './core/tooltipSuppress.ts';

installSelectWheel();
installTooltipSuppress();

createRoot(document.getElementById('root')!).render(<App />);
