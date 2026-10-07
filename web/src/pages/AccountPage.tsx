import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AppHeader } from '../components/AppHeader';

/** Account settings: where booking confirmations are sent. */
export function AccountPage() {
  const { user, updatePhone } = useAuth();
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!user) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updatePhone(phone);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppHeader />
      <main className="page page--narrow">
        <h1>Account</h1>
        <form className="card" onSubmit={save}>
          <h2 className="card-title">Booking notifications</h2>
          <p className="hint">
            {user.role === 'admin'
              ? 'We alert you when a player books and pays for one of your courts.'
              : 'We send your booking confirmation as soon as your payment goes through.'}
          </p>
          <dl className="summary">
            <div><dt>Email</dt><dd>{user.email}</dd></div>
          </dl>
          <label className="field">
            <span>Mobile number for SMS</span>
            <input type="tel" autoComplete="tel" inputMode="tel" placeholder="0917 123 4567"
              value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} disabled={busy} />
            <small className="field-help">Leave empty to get email only.</small>
          </label>
          {error && <p className="notice notice--error" role="alert">{error}</p>}
          {saved && (
            <p className="notice notice--success" role="status">
              {user.phone ? `Saved. SMS confirmations will go to ${user.phone}.` : 'Saved. You will get email confirmations only.'}
            </p>
          )}
          <div className="checkout-actions">
            <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </main>
    </>
  );
}
