import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthContext';
import { AccountPage } from '../src/pages/AccountPage';
import { LoginPage } from '../src/pages/LoginPage';
import { jsonResponse } from './fixtures';

let calls: Array<{ method: string; path: string; body: any }>;
let patchResponse: () => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/auth/me' && method === 'GET') return jsonResponse(200, { user: { id: 'p1', email: 'p@x.com', role: 'player', phone: null } });
    if (path === '/api/auth/me' && method === 'PATCH') return patchResponse();
    if (path === '/api/auth/register') return jsonResponse(201, { user: { id: 'p2', email: body.email, role: 'player', phone: '+639171234567' } });
    return jsonResponse(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (path: string) => render(
  <AuthProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/account" element={<AccountPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/bookings" element={<p>Calendar</p>} />
      </Routes>
    </MemoryRouter>
  </AuthProvider>,
);

describe('account notifications settings', () => {
  it('saves a mobile number for SMS confirmations', async () => {
    patchResponse = () => jsonResponse(200, { user: { id: 'p1', email: 'p@x.com', role: 'player', phone: '+639171234567' } });
    renderAt('/account');
    await userEvent.type(await screen.findByLabelText(/Mobile number for SMS/), '0917 123 4567');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. SMS confirmations will go to +639171234567.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ phone: '0917 123 4567' });
  });

  it('shows the server explanation for an invalid number', async () => {
    patchResponse = () => jsonResponse(400, { error: { code: 'INVALID_PHONE', message: 'Enter a valid mobile number, e.g. 0917 123 4567 or +63 917 123 4567.' } });
    renderAt('/account');
    await userEvent.type(await screen.findByLabelText(/Mobile number for SMS/), '02 8123 4567');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid mobile number/);
  });

  it('accepts an optional mobile number at sign-up', async () => {
    renderAt('/login');
    await userEvent.click(await screen.findByRole('button', { name: /Create an account/ }));
    await userEvent.type(screen.getByLabelText('Email'), 'new@x.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.type(screen.getByLabelText(/Mobile number/), '0917 123 4567');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Calendar')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/auth/register')!.body).toEqual({
      email: 'new@x.com', password: 'correct horse', role: 'player', phone: '0917 123 4567',
    });
  });
});
