import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <header className="app-header">
      <a href="/bookings" className="brand" onClick={(e) => { e.preventDefault(); navigate('/bookings'); }}>PickSched</a>
      {user && (
        <div className="app-header-user">
          <span className={`role-chip role-chip--${user.role}`}>{user.role === 'admin' ? 'Court owner' : 'Player'}</span>
          {user.role === 'admin' && (
            <nav className="app-nav" aria-label="Owner">
              <a href="/dashboard" className="text-button" onClick={(e) => { e.preventDefault(); navigate('/dashboard'); }}>Dashboard</a>
              <a href="/bookings" className="text-button" onClick={(e) => { e.preventDefault(); navigate('/bookings'); }}>Schedule</a>
            </nav>
          )}
          <span className="user-email">{user.email}</span>
          <a href="/account" className="text-button" onClick={(e) => { e.preventDefault(); navigate('/account'); }}>Account</a>
          <button type="button" className="text-button" onClick={async () => { await logout(); navigate('/login'); }}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
