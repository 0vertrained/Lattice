/** Recording time as m:ss. */
export const minutes = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;

/** A fixed-point number with a true minus sign. */
export const signed = (value: number, digits: number) => value.toFixed(digits).replace('-', '−');
