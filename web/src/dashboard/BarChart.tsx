import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface BarDatum {
  key: string;
  /** Axis label (short). */
  label: string;
  /** Tooltip heading (long). */
  title: string;
  value: number | null;
  /** Extra tooltip line under the value. */
  detail?: string;
}

interface BarChartProps {
  data: BarDatum[];
  color: string;
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
  /** Fixed top of the scale (e.g. 1 for percentages); otherwise a clean round number above the max. */
  max?: number;
  ariaLabel: string;
  height?: number;
}

const PAD = { top: 22, right: 8, bottom: 26, left: 52 };

/** Rounds up to 1, 2, 2.5 or 5 × 10ⁿ so ticks are clean. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** Column path: square at the baseline, 4px rounded data-end. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Single-series column chart (inline SVG). Hover or keyboard (arrow keys
 * when focused) shows a tooltip per column; the peak is labeled directly.
 */
export function BarChart({ data, color, formatValue, formatTick, max, ariaLabel, height = 220 }: BarChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const values = data.map((d) => d.value ?? 0);
  const top = max ?? niceMax(Math.max(...values, 0));
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, band - 2)); // <= 24px, >= 2px surface gap between neighbours
  const y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const peak = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);

  const onKey = (e: KeyboardEvent) => {
    if (!data.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((i) => {
        const cur = i ?? (e.key === 'ArrowRight' ? -1 : data.length);
        return Math.min(data.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(data.length - 1);
    else if (e.key === 'Escape') setActive(null);
  };

  const a = active !== null ? data[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(PAD.left + band * active + band / 2, 70), width - 70) : 0;

  return (
    <div className="bar-chart" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${ariaLabel}. Use the left and right arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        aria-describedby={a ? tooltipId : undefined}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="chart-gridline" />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">{formatTick(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const v = d.value ?? 0;
          const x = PAD.left + band * i + (band - barW) / 2;
          const h = Math.max(0, PAD.top + plotH - y(v));
          return (
            <g key={d.key}>
              {h > 0 && (
                <path d={columnPath(x, y(v), barW, h)} fill={color}
                  className={`chart-bar${active === i ? ' chart-bar--active' : ''}`} />
              )}
              {/* hit target: the whole band, taller than the mark */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent"
                onMouseEnter={() => setActive(i)} onMouseMove={() => setActive(i)} />
              {i % labelEvery === 0 && (
                <text x={PAD.left + band * i + band / 2} y={height - 8} textAnchor="middle" className="chart-tick">{d.label}</text>
              )}
            </g>
          );
        })}
        {values[peak] > 0 && (
          <text x={PAD.left + band * peak + band / 2} y={y(values[peak]) - 6} textAnchor="middle" className="chart-direct-label">
            {formatValue(values[peak])}
          </text>
        )}
        <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} className="chart-axis" />
      </svg>
      {a && (
        <div className="chart-tooltip" id={tooltipId} role="status" style={{ left: tipLeft }}>
          <strong>{a.value === null ? '—' : formatValue(a.value)}</strong>
          <span>{a.title}</span>
          {a.detail && <span className="chart-tooltip-detail">{a.detail}</span>}
        </div>
      )}
    </div>
  );
}
