import { Link } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';

export function UnauthorizedPage() {
  return (
    <>
      <AppHeader />
      <main className="page page--narrow">
        <div className="error-panel" role="alert">
          <h1>You don't have access to this page</h1>
          <p>The dashboard is only available to court owners.</p>
          <Link className="button-primary button-link" to="/bookings">Back to bookings</Link>
        </div>
      </main>
    </>
  );
}
