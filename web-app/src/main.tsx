import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ListenPage } from './pages/listen/index.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ListenPage />
  </StrictMode>,
);
