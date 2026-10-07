import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/**
 * App header. On desktop and tablet the navigation is inline; below 768px it
 * collapses behind a menu button (hamburger) that opens a dropdown panel.
 */
export function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close after navigating, on Escape, and on a tap outside the header.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const go = (to: string) => (e: MouseEvent) => {
    e.preventDefault();
    setOpen(false);
    navigate(to);
  };
  const link = (to: string, label: string) => (
    <a href={to} className="nav-link" aria-current={pathname === to ? 'page' : undefined} onClick={go(to)}>{label}</a>
  );

  return (
    <header className="app-header" ref={headerRef}>
      <a href="/bookings" className="brand" onClick={go('/bookings')}>PickSched</a>
      {user && (
        <>
          <button
            ref={toggleRef}
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="app-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen(!open)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {open
                ? <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                : <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
            </svg>
          </button>
          <div id="app-menu" className={`app-menu${open ? ' is-open' : ''}`}>
            <div className="app-menu-identity">
              <span className={`role-chip role-chip--${user.role}`}>{user.role === 'admin' ? 'Court owner' : 'Player'}</span>
              <span className="user-email">{user.email}</span>
            </div>
            <nav className="app-nav" aria-label="Main">
              {user.role === 'admin' ? (
                <>
                  {link('/dashboard', 'Dashboard')}
                  {link('/bookings', 'Schedule')}
                </>
              ) : (
                link('/bookings', 'Book a court')
              )}
              {link('/account', 'Account')}
            </nav>
            <button type="button" className="nav-link nav-link--button" onClick={async () => { setOpen(false); await logout(); navigate('/login'); }}>
              Sign out
            </button>
          </div>
        </>
      )}
    </header>
  );
}
