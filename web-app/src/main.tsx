import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ListenPage } from './pages/listen/index.tsx';
import './styles.css';

// Embedded-issuer pages load on demand, so the listening page never ships the auth client.
const AccountPage = lazy(() => import('./pages/auth/index.tsx').then(module => ({ default: module.AccountPage })));
const ConsentPage = lazy(() => import('./pages/auth/index.tsx').then(module => ({ default: module.ConsentPage })));
const InvitePage = lazy(() => import('./pages/auth/index.tsx').then(module => ({ default: module.InvitePage })));

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

const path = location.pathname;
const invitation = /^\/invite\/([\w-]+)$/.exec(path)?.[1];
createRoot(container).render(
  <StrictMode>
    <Suspense>
      {path === '/sign-in' || path === '/sign-up' ? (
        <AccountPage mode={path === '/sign-in' ? 'sign-in' : 'sign-up'} />
      ) : path === '/consent' ? (
        <ConsentPage />
      ) : invitation !== undefined ? (
        <InvitePage id={invitation} />
      ) : (
        <ListenPage />
      )}
    </Suspense>
  </StrictMode>,
);
