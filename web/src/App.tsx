import type { ReactNode } from 'react';
import type { Role } from './api/types';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { BookingsDashboard } from './pages/BookingsDashboard';
import { AccountPage } from './pages/AccountPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { DashboardPage } from './pages/DashboardPage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';
import { LoginPage } from './pages/LoginPage';
import { PaymentResultPage } from './pages/PaymentResultPage';

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

/** Signed-in users with another role are sent to the unauthorized page. */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth();
  if (user && user.role !== role) return <Navigate to="/unauthorized" replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/bookings" element={<RequireAuth><BookingsDashboard /></RequireAuth>} />
      <Route path="/bookings/:id/checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
      <Route path="/bookings/:id/payment" element={<RequireAuth><PaymentResultPage /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
      <Route path="/dashboard" element={<RequireAuth><RequireRole role="admin"><DashboardPage /></RequireRole></RequireAuth>} />
      <Route path="/unauthorized" element={<RequireAuth><UnauthorizedPage /></RequireAuth>} />
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
