import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { BookingsDashboard } from './pages/BookingsDashboard';
import { CheckoutPage } from './pages/CheckoutPage';
import { LoginPage } from './pages/LoginPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, checking, checkError, retryCheck } = useAuth();
  const location = useLocation();
  if (checking) return <p className="loading-line page" role="status">Loading…</p>;
  if (checkError) {
    return (
      <main className="page page--narrow">
        <div className="error-panel" role="alert">
          <p>{checkError.message}</p>
          <button type="button" className="button-primary" onClick={retryCheck}>Try again</button>
        </div>
      </main>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/bookings" element={<RequireAuth><BookingsDashboard /></RequireAuth>} />
      <Route path="/bookings/:id/checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/bookings" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
