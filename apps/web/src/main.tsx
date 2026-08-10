import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import './reset.css';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import { SessionProvider } from './lib/session.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container "#root" not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Suspense fallback={<p className="route-loading" role="status">Loading…</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </SessionProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
