import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './lib/app';
import { Login } from './pages/Login';
import { Join } from './pages/Join';
import { Ask } from './pages/Ask';
import { Setup } from './pages/Setup';
import { Dashboard } from './pages/Dashboard';
import { IncidentRoom } from './pages/IncidentRoom';
import { Admin } from './pages/Admin';
import { Start } from './pages/Start';
import { Connect } from './pages/Connect';
import { Wall } from './pages/Wall';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/ask/:id" element={<Ask />} />
        <Route path="/setup/:token" element={<Setup />} />
        <Route path="/connect/:id" element={<Connect />} />
        <Route
          path="/*"
          element={
            <AppProvider>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/incidents/:id" element={<IncidentRoom />} />
                <Route path="/incidents/:id/wall" element={<Wall />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/start" element={<Start />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
