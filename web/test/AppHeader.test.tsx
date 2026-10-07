import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthContext';
import { AppHeader } from '../src/components/AppHeader';
import { jsonResponse } from './fixtures';

let role: 'admin' | 'player';
beforeEach(() => {
  role = 'admin';
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/auth/me') return jsonResponse(200, { user: { id: 'u1', email: 'owner@x.com', role } });
    return new Response(null, { status: 204 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

const renderAt = (path: string) => render(
  <AuthProvider>
    <MemoryRouter initialEntries={[path]}>
      <AppHeader />
      <Routes><Route path="*" element={<><Where /><main><p>Page body</p></main></>} /></Routes>
    </MemoryRouter>
  </AuthProvider>,
);

describe('header menu', () => {
  it('has a menu button that opens and closes the navigation', async () => {
    renderAt('/bookings');
    const toggle = await screen.findByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'app-menu');
    expect(document.getElementById('app-menu')).not.toHaveClass('is-open');

    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('app-menu')).toHaveClass('is-open');

    await userEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(document.getElementById('app-menu')).not.toHaveClass('is-open');
  });

  it('shows owner links, marks the current page, and closes after navigating', async () => {
    renderAt('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(nav).toHaveTextContent('DashboardScheduleAccount');

    await userEvent.click(screen.getByRole('link', { name: 'Schedule' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/bookings');
    expect(document.getElementById('app-menu')).not.toHaveClass('is-open');
  });

  it('gives players a booking link instead of owner pages', async () => {
    role = 'player';
    renderAt('/bookings');
    await screen.findByRole('button', { name: 'Open menu' });
    expect(screen.getByRole('link', { name: 'Book a court' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('closes on Escape (returning focus to the button) and on an outside tap', async () => {
    renderAt('/bookings');
    const toggle = await screen.findByRole('button', { name: 'Open menu' });
    await userEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.getElementById('app-menu')).not.toHaveClass('is-open'));
    expect(toggle).toHaveFocus();

    await userEvent.click(toggle);
    fireEvent.pointerDown(screen.getByText('Page body'));
    await waitFor(() => expect(document.getElementById('app-menu')).not.toHaveClass('is-open'));
  });
});
