import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { BookingCalendar } from '../calendar/BookingCalendar';
import { AppHeader } from '../components/AppHeader';

export function BookingsDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <>
      <AppHeader />
      <main className="page">
        <div className="page-heading">
          <h1>{user.role === 'admin' ? 'Facility schedule' : 'Book a court'}</h1>
          <p className="page-subtitle">
            {user.role === 'admin'
              ? 'All bookings on your courts. Click an open slot to block it for maintenance, or a booking to manage it.'
              : 'Pick an open slot to reserve it. Bookings must be made at least 1 hour in advance.'}
          </p>
        </div>
        <BookingCalendar user={user} onProceedToCheckout={(id) => navigate(`/bookings/${id}/checkout`)} />
      </main>
    </>
  );
}
