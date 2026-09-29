import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <main aria-label="Sanctum" className="h-full w-full bg-canvas" />
  </StrictMode>,
);
