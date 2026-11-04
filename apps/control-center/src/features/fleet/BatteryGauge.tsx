/** Ten cells, lit green above 30 %, orange from 15 % and red below. */
export function batteryTone(level: number): 'clear' | 'hold' | 'stop' {
  if (level < 15) return 'stop';
  if (level < 30) return 'hold';
  return 'clear';
}

export function BatteryGauge({ level }: { readonly level: number }) {
  const lit = Math.round(Math.min(100, Math.max(0, level)) / 10);
  return (
    <svg className="battery" data-tone={batteryTone(level)} viewBox="0 0 106 14" aria-hidden="true">
      {Array.from({ length: 10 }, (_, cell) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: the cells are fixed positions.
          key={cell}
          className={cell < lit ? 'cell-lit' : 'cell'}
          x={1 + cell * 10}
          y={1}
          width={8}
          height={12}
        />
      ))}
      <rect className="cell-nub" x={102} y={4} width={3} height={6} />
    </svg>
  );
}
