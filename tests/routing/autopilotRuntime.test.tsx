// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, NavLink } from 'react-router-dom';

import {
  operationsLinks,
  tenantLinks,
  configureLinks,
  settingsLink,
} from '../../client-app/src/components/TenantLayout';

void React;

afterEach(() => {
  cleanup();
});

function AutopilotStub() {
  return <div data-testid="autopilot-page">Autopilot page mounted</div>;
}

function MiniSidebar() {
  return (
    <nav>
      {operationsLinks.map((link) => (
        <NavLink key={link.to} to={link.to}>
          {link.i18nKey === 'tenant_nav.autopilot' ? 'Autopilot' : link.i18nKey}
        </NavLink>
      ))}
    </nav>
  );
}

describe('Autopilot is wired into the real tenant nav (runtime)', () => {
  it('exports an Operations entry that points at /autopilot with the Autopilot label', () => {
    const autopilot = operationsLinks.find((link) => link.to === '/autopilot');
    expect(autopilot, 'Autopilot link should be in operationsLinks').toBeTruthy();
    expect(autopilot!.i18nKey).toBe('tenant_nav.autopilot');
    expect(typeof autopilot!.icon).toBe('object');
  });

  it('does not duplicate the Autopilot entry across nav groups', () => {
    const allLinks = [
      ...tenantLinks,
      ...operationsLinks,
      ...configureLinks,
      settingsLink,
    ];
    const autopilotLinks = allLinks.filter((link) => link.to === '/autopilot');
    expect(autopilotLinks).toHaveLength(1);
  });

  it('clicking the real Autopilot sidebar link mounts the /autopilot route', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <MiniSidebar />
        <Routes>
          <Route path="/dashboard" element={<div data-testid="dashboard">dash</div>} />
          <Route path="/autopilot" element={<AutopilotStub />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('dashboard')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'Autopilot' });
    expect(link.getAttribute('href')).toBe('/autopilot');

    fireEvent.click(link);

    expect(screen.getByTestId('autopilot-page')).toBeTruthy();
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });
});
