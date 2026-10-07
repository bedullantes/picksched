import type { Role } from '../api/types';

export function Legend({ role }: { role: Role }) {
  const items: Array<[string, string]> = [
    ['available', 'Available'],
    ['booked', 'Booked'],
    ...(role === 'player' ? [['mine', 'Your booking'] as [string, string]] : []),
    ['maintenance', 'Maintenance'],
    ['unavailable', 'Past / too soon'],
  ];
  return (
    <ul className="legend" aria-label="Legend">
      {items.map(([status, label]) => (
        <li key={status}>
          <span className={`legend-swatch slot--${status}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
